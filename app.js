(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const canvas = $("#editorCanvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const state = {
    baseImage: null,
    fileName: "image",
    edits: [],
    undoStack: [],
    redoStack: [],
    activeTool: "select",
    selectedId: null,
    draft: null,
    interaction: null,
    nextId: 1,
    exportFormat: "png",
    mosaicLayers: new Map(),
    defaults: {
      mosaicBrushSize: 84,
      mosaicSize: 18,
      blurBrushSize: 84,
      blurAmount: 14,
      coverColor: "#17191f",
      coverShape: "rect",
      text: "ここにテキスト",
      fontSize: 42,
      textColor: "#ffffff",
      textBackground: true,
    },
  };

  const toolNames = {
    select: "選択",
    mosaic: "モザイク",
    blur: "ぼかし",
    cover: "塗りつぶし",
    text: "テキスト",
    overlay: "画像の上乗せ",
  };

  const typeIcons = {
    mosaic: '<span class="mosaic-icon"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>',
    blur: '<svg viewBox="0 0 24 24"><path d="M12 3s6 6.4 6 11a6 6 0 1 1-12 0c0-4.6 6-11 6-11Z"/></svg>',
    cover: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14" rx="2"/></svg>',
    text: '<svg viewBox="0 0 24 24"><path d="M5 6V4h14v2M12 4v16M8 20h8"/></svg>',
    overlay: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m7 15 3-3 3 3 2-2 3 3"/></svg>',
  };

  const refs = {
    emptyState: $("#emptyState"),
    canvasStage: $("#canvasStage"),
    workspaceStatus: $("#workspaceStatus"),
    imageInput: $("#imageInput"),
    overlayInput: $("#overlayInput"),
    exportButton: $("#exportButton"),
    exportDialog: $("#exportDialog"),
    undoButton: $("#undoButton"),
    redoButton: $("#redoButton"),
    inspector: $(".inspector"),
    inspectorTitle: $("#inspectorTitle"),
    selectionEmpty: $("#selectionEmpty"),
    selectionControls: $("#selectionControls"),
    dropOverlay: $("#dropOverlay"),
    imageInfo: $("#imageInfo"),
    zoomInfo: $("#zoomInfo"),
    statusHint: $("#statusHint"),
    brushCursor: $("#brushCursor"),
    toast: $("#toast"),
  };

  function cloneEdits(edits = state.edits) {
    return edits.map((edit) => ({
      ...edit,
      points: edit.points?.map((point) => ({ ...point })),
    }));
  }

  function snapshot() {
    state.undoStack.push(cloneEdits());
    if (state.undoStack.length > 60) state.undoStack.shift();
    state.redoStack = [];
    updateHistoryButtons();
  }

  function undo() {
    if (!state.undoStack.length) return;
    state.redoStack.push(cloneEdits());
    state.edits = state.undoStack.pop();
    state.selectedId = null;
    render();
    updateHistoryButtons();
    updateSelectionPanel();
  }

  function redo() {
    if (!state.redoStack.length) return;
    state.undoStack.push(cloneEdits());
    state.edits = state.redoStack.pop();
    state.selectedId = null;
    render();
    updateHistoryButtons();
    updateSelectionPanel();
  }

  function updateHistoryButtons() {
    refs.undoButton.disabled = state.undoStack.length === 0;
    refs.redoButton.disabled = state.redoStack.length === 0;
  }

  function normalizedRect(rect) {
    const x = rect.w < 0 ? rect.x + rect.w : rect.x;
    const y = rect.h < 0 ? rect.y + rect.h : rect.y;
    return { ...rect, x, y, w: Math.abs(rect.w), h: Math.abs(rect.h) };
  }

  function pathShape(target, edit) {
    const item = normalizedRect(edit);
    target.beginPath();
    if (item.shape === "ellipse") {
      target.ellipse(item.x + item.w / 2, item.y + item.h / 2, item.w / 2, item.h / 2, 0, 0, Math.PI * 2);
    } else {
      target.rect(item.x, item.y, item.w, item.h);
    }
  }

  function isBrushEdit(edit) {
    return Array.isArray(edit.points);
  }

  function getEditBounds(edit, padding = 0) {
    if (!isBrushEdit(edit)) return normalizedRect(edit);
    const radius = edit.brushSize / 2 + padding;
    const xs = edit.points.map((point) => point.x);
    const ys = edit.points.map((point) => point.y);
    const left = Math.min(...xs) - radius;
    const top = Math.min(...ys) - radius;
    const right = Math.max(...xs) + radius;
    const bottom = Math.max(...ys) + radius;
    return { x: left, y: top, w: right - left, h: bottom - top };
  }

  function clippedBounds(bounds) {
    const x = Math.max(0, Math.floor(bounds.x));
    const y = Math.max(0, Math.floor(bounds.y));
    const right = Math.min(canvas.width, Math.ceil(bounds.x + bounds.w));
    const bottom = Math.min(canvas.height, Math.ceil(bounds.y + bounds.h));
    return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
  }

  function drawBrushPath(target, edit, offsetX = 0, offsetY = 0, extraWidth = 0) {
    if (!edit.points?.length) return;
    target.beginPath();
    if (edit.points.length === 1) {
      target.arc(
        edit.points[0].x + offsetX,
        edit.points[0].y + offsetY,
        Math.max(1, (edit.brushSize + extraWidth) / 2),
        0,
        Math.PI * 2,
      );
      target.fill();
      return;
    }
    target.moveTo(edit.points[0].x + offsetX, edit.points[0].y + offsetY);
    edit.points.slice(1).forEach((point) => target.lineTo(point.x + offsetX, point.y + offsetY));
    target.lineWidth = Math.max(1, edit.brushSize + extraWidth);
    target.lineCap = "round";
    target.lineJoin = "round";
    target.stroke();
  }

  function applyBrushMask(target, edit, bounds) {
    applyBrushMasks(target, [edit], bounds);
  }

  function applyBrushMasks(target, edits, bounds) {
    const mask = document.createElement("canvas");
    mask.width = target.canvas.width;
    mask.height = target.canvas.height;
    const maskCtx = mask.getContext("2d", { willReadFrequently: true });
    maskCtx.fillStyle = "white";
    maskCtx.strokeStyle = "white";
    edits.forEach((edit) => drawBrushPath(maskCtx, edit, -bounds.x, -bounds.y));

    // Make the mask a true union. This prevents anti-aliased brush edges from
    // getting stronger when the same area is painted more than once.
    const pixels = maskCtx.getImageData(0, 0, mask.width, mask.height);
    for (let index = 3; index < pixels.data.length; index += 4) {
      if (pixels.data[index] > 0) pixels.data[index] = 255;
    }
    maskCtx.putImageData(pixels, 0, 0);

    target.save();
    target.globalCompositeOperation = "destination-in";
    target.drawImage(mask, 0, 0);
    target.restore();
  }

  function getMosaicLayer(amount) {
    const block = Math.max(2, Math.round(amount));
    if (state.mosaicLayers.has(block)) return state.mosaicLayers.get(block);

    const reduced = document.createElement("canvas");
    reduced.width = Math.max(1, Math.ceil(canvas.width / block));
    reduced.height = Math.max(1, Math.ceil(canvas.height / block));
    const reducedCtx = reduced.getContext("2d");
    reducedCtx.imageSmoothingEnabled = true;
    reducedCtx.imageSmoothingQuality = "high";
    reducedCtx.drawImage(state.baseImage, 0, 0, canvas.width, canvas.height, 0, 0, reduced.width, reduced.height);

    const layer = document.createElement("canvas");
    layer.width = canvas.width;
    layer.height = canvas.height;
    const layerCtx = layer.getContext("2d");
    layerCtx.imageSmoothingEnabled = false;
    layerCtx.drawImage(reduced, 0, 0, reduced.width, reduced.height, 0, 0, reduced.width * block, reduced.height * block);
    state.mosaicLayers.set(block, layer);
    return layer;
  }

  function renderMosaicGroup(edits) {
    if (!edits.length) return;
    const strokeBounds = edits.map((edit) => getEditBounds(edit));
    const left = Math.min(...strokeBounds.map((item) => item.x));
    const top = Math.min(...strokeBounds.map((item) => item.y));
    const right = Math.max(...strokeBounds.map((item) => item.x + item.w));
    const bottom = Math.max(...strokeBounds.map((item) => item.y + item.h));
    const item = clippedBounds({ x: left, y: top, w: right - left, h: bottom - top });
    if (item.w < 1 || item.h < 1) return;
    const layer = getMosaicLayer(edits[0].amount);
    const effect = document.createElement("canvas");
    effect.width = item.w;
    effect.height = item.h;
    const effectCtx = effect.getContext("2d");
    effectCtx.imageSmoothingEnabled = false;
    effectCtx.drawImage(layer, item.x, item.y, item.w, item.h, 0, 0, item.w, item.h);
    applyBrushMasks(effectCtx, edits, item);
    ctx.drawImage(effect, item.x, item.y);
  }

  function renderMosaic(edit) {
    renderMosaicGroup([edit]);
  }

  function renderBlur(edit) {
    const item = clippedBounds(getEditBounds(edit, edit.amount * 2));
    if (item.w < 1 || item.h < 1) return;
    const effect = document.createElement("canvas");
    effect.width = item.w;
    effect.height = item.h;
    const effectCtx = effect.getContext("2d");
    effectCtx.save();
    effectCtx.filter = `blur(${Math.max(1, edit.amount)}px)`;
    effectCtx.drawImage(canvas, -item.x, -item.y);
    effectCtx.restore();
    applyBrushMask(effectCtx, edit, item);
    ctx.drawImage(effect, item.x, item.y);
  }

  function roundedRect(target, x, y, w, h, radius) {
    const r = Math.min(radius, w / 2, h / 2);
    target.beginPath();
    target.moveTo(x + r, y);
    target.arcTo(x + w, y, x + w, y + h, r);
    target.arcTo(x + w, y + h, x, y + h, r);
    target.arcTo(x, y + h, x, y, r);
    target.arcTo(x, y, x + w, y, r);
    target.closePath();
  }

  function getTextMetrics(edit) {
    ctx.save();
    ctx.font = `700 ${edit.fontSize}px "Noto Sans JP", sans-serif`;
    const lines = edit.text.split("\n");
    const width = Math.max(...lines.map((line) => ctx.measureText(line || " ").width));
    ctx.restore();
    const padding = edit.background ? Math.max(8, edit.fontSize * 0.28) : 0;
    const lineHeight = edit.fontSize * 1.35;
    return { width: width + padding * 2, height: lines.length * lineHeight + padding * 2, padding, lineHeight };
  }

  function renderText(edit) {
    const metrics = getTextMetrics(edit);
    edit.w = metrics.width;
    edit.h = metrics.height;
    ctx.save();
    if (edit.background) {
      ctx.fillStyle = "rgba(17, 19, 25, .78)";
      roundedRect(ctx, edit.x, edit.y, edit.w, edit.h, Math.max(5, edit.fontSize * 0.2));
      ctx.fill();
    }
    ctx.fillStyle = edit.color;
    ctx.font = `700 ${edit.fontSize}px "Noto Sans JP", sans-serif`;
    ctx.textBaseline = "top";
    edit.text.split("\n").forEach((line, index) => {
      ctx.fillText(line, edit.x + metrics.padding, edit.y + metrics.padding + index * metrics.lineHeight);
    });
    ctx.restore();
  }

  function renderEdit(edit) {
    if (edit.type === "mosaic") return renderMosaic(edit);
    if (edit.type === "blur") return renderBlur(edit);
    if (edit.type === "cover") {
      ctx.save();
      pathShape(ctx, edit);
      ctx.fillStyle = edit.color;
      ctx.fill();
      ctx.restore();
    }
    if (edit.type === "text") renderText(edit);
    if (edit.type === "overlay" && edit.image) ctx.drawImage(edit.image, edit.x, edit.y, edit.w, edit.h);
  }

  function renderSelection(edit) {
    if (!edit) return;
    const item = getEditBounds(edit);
    const scale = canvas.width / Math.max(1, canvas.getBoundingClientRect().width);
    const line = Math.max(1, 1.5 * scale);
    const handle = Math.max(8, 9 * scale);
    ctx.save();
    ctx.strokeStyle = "#635bff";
    ctx.lineWidth = line;
    ctx.setLineDash([5 * scale, 4 * scale]);
    ctx.strokeRect(item.x - line, item.y - line, item.w + line * 2, item.h + line * 2);
    ctx.setLineDash([]);
    ctx.fillStyle = "white";
    ctx.strokeStyle = "#635bff";
    ctx.lineWidth = line;
    [[item.x, item.y], [item.x + item.w, item.y], [item.x, item.y + item.h], [item.x + item.w, item.y + item.h]].forEach(([x, y]) => {
      ctx.fillRect(x - handle / 2, y - handle / 2, handle, handle);
      ctx.strokeRect(x - handle / 2, y - handle / 2, handle, handle);
    });
    ctx.restore();
  }

  function renderDraft(effectAlreadyRendered = false) {
    if (!state.draft) return;
    if (!effectAlreadyRendered) renderEdit(state.draft);
    const scale = canvas.width / Math.max(1, canvas.getBoundingClientRect().width);
    ctx.save();
    ctx.strokeStyle = "#ffffff";
    ctx.fillStyle = "#ffffff";
    ctx.lineWidth = 2 * scale;
    ctx.setLineDash([6 * scale, 4 * scale]);
    if (isBrushEdit(state.draft)) {
      const outline = { ...state.draft, brushSize: 2 * scale };
      drawBrushPath(ctx, outline);
      const last = state.draft.points.at(-1);
      ctx.beginPath();
      ctx.arc(last.x, last.y, state.draft.brushSize / 2, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      pathShape(ctx, state.draft);
      ctx.stroke();
    }
    ctx.restore();
  }

  function render() {
    if (!state.baseImage) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(state.baseImage, 0, 0, canvas.width, canvas.height);

    const mosaicEdits = state.edits.filter((edit) => edit.type === "mosaic");
    if (state.draft?.type === "mosaic") mosaicEdits.push(state.draft);
    const mosaicGroups = new Map();
    mosaicEdits.forEach((edit) => {
      const amount = Math.max(2, Math.round(edit.amount));
      if (!mosaicGroups.has(amount)) mosaicGroups.set(amount, []);
      mosaicGroups.get(amount).push(edit);
    });
    mosaicGroups.forEach(renderMosaicGroup);

    state.edits.filter((edit) => edit.type !== "mosaic").forEach(renderEdit);
    renderDraft(state.draft?.type === "mosaic");
    if (state.activeTool === "select") renderSelection(state.edits.find((edit) => edit.id === state.selectedId));
  }

  function showEditor(image, name = "image") {
    state.baseImage = image;
    state.fileName = name.replace(/\.[^.]+$/, "") || "image";
    state.edits = [];
    state.undoStack = [];
    state.redoStack = [];
    state.mosaicLayers.clear();
    state.selectedId = null;
    state.nextId = 1;
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    refs.emptyState.classList.add("hidden");
    refs.canvasStage.classList.remove("hidden");
    refs.workspaceStatus.classList.remove("hidden");
    refs.exportButton.disabled = false;
    refs.imageInfo.textContent = `${canvas.width.toLocaleString()} × ${canvas.height.toLocaleString()} px`;
    $("#exportSize").textContent = `${canvas.width.toLocaleString()} × ${canvas.height.toLocaleString()} px`;
    setTool("select", false);
    render();
    updateHistoryButtons();
    requestAnimationFrame(updateZoom);
  }

  function loadFile(file, overlay = false) {
    if (!file || !file.type.startsWith("image/")) {
      showToast("画像ファイルを選択してください");
      return;
    }
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      if (overlay && state.baseImage) {
        addOverlay(image);
      } else {
        showEditor(image, file.name);
        showToast("画像を開きました");
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      showToast("画像を読み込めませんでした");
    };
    image.src = url;
  }

  function addOverlay(image) {
    snapshot();
    const maxW = canvas.width * 0.35;
    const maxH = canvas.height * 0.35;
    const ratio = Math.min(maxW / image.naturalWidth, maxH / image.naturalHeight, 1);
    const w = image.naturalWidth * ratio;
    const h = image.naturalHeight * ratio;
    const edit = { id: state.nextId++, type: "overlay", image, x: (canvas.width - w) / 2, y: (canvas.height - h) / 2, w, h };
    state.edits.push(edit);
    state.selectedId = edit.id;
    setTool("select");
    render();
    showToast("画像を追加しました");
  }

  function createSample() {
    const sample = document.createElement("canvas");
    sample.width = 1200;
    sample.height = 760;
    const s = sample.getContext("2d");
    const gradient = s.createLinearGradient(0, 0, 1200, 760);
    gradient.addColorStop(0, "#d9e7ff");
    gradient.addColorStop(0.52, "#f4e7dc");
    gradient.addColorStop(1, "#cad9bd");
    s.fillStyle = gradient;
    s.fillRect(0, 0, 1200, 760);
    s.fillStyle = "rgba(255,255,255,.8)";
    s.fillRect(80, 72, 1040, 616);
    s.fillStyle = "#252935";
    s.font = '700 46px "Noto Sans JP", sans-serif';
    s.fillText("週末のフォトダイアリー", 140, 160);
    s.fillStyle = "#777b86";
    s.font = '500 22px "Noto Sans JP", sans-serif';
    s.fillText("シェアする前に、顔や個人情報を隠してみましょう。", 140, 205);
    const faces = [[320, 410, "#e1aa7d", "#44362f"], [600, 390, "#be835f", "#272523"], [870, 425, "#f0c39d", "#6a4b38"]];
    faces.forEach(([x, y, skin, hair], index) => {
      s.fillStyle = index === 1 ? "#5769a8" : index === 0 ? "#ca6f70" : "#63866b";
      s.beginPath(); s.roundRect(x - 100, y + 80, 200, 190, 60); s.fill();
      s.fillStyle = skin; s.beginPath(); s.arc(x, y, 92, 0, Math.PI * 2); s.fill();
      s.fillStyle = hair; s.beginPath(); s.arc(x, y - 25, 94, Math.PI, 0); s.lineTo(x + 88, y - 5); s.quadraticCurveTo(x + 50, y - 88, x, y - 86); s.quadraticCurveTo(x - 55, y - 82, x - 88, y - 5); s.fill();
      s.fillStyle = "#302f32"; s.beginPath(); s.arc(x - 30, y + 5, 7, 0, 7); s.arc(x + 30, y + 5, 7, 0, 7); s.fill();
      s.strokeStyle = "#7e4e48"; s.lineWidth = 5; s.beginPath(); s.arc(x, y + 25, 30, .2, Math.PI - .2); s.stroke();
    });
    s.fillStyle = "rgba(255,255,255,.88)";
    s.fillRect(830, 625, 230, 36);
    s.fillStyle = "#4f535d";
    s.font = '500 19px "DM Sans", sans-serif';
    s.fillText("TOKYO · 2026.08.16", 845, 650);
    const image = new Image();
    image.onload = () => { showEditor(image, "privacy-paint-sample.png"); showToast("サンプル画像を開きました"); };
    image.src = sample.toDataURL("image/png");
  }

  function setTool(tool, openMobile = true) {
    state.activeTool = tool;
    state.draft = null;
    canvas.dataset.tool = tool;
    $$(".tool-button").forEach((button) => {
      const active = button.dataset.tool === tool;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    $$(".settings-panel").forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === tool));
    refs.inspectorTitle.textContent = toolNames[tool];
    refs.statusHint.textContent = tool === "select" ? "加工を選択して移動・拡大縮小" : tool === "text" ? "配置したい場所をクリック" : tool === "overlay" ? "重ねる画像を選択" : tool === "mosaic" || tool === "blur" ? "隠したい場所をなぞって塗る" : "隠したい範囲をドラッグ";
    refs.brushCursor.classList.add("hidden");
    if (tool === "select") updateSelectionPanel();
    if (openMobile && window.innerWidth <= 720 && tool !== "select") refs.inspector.classList.add("open");
    render();
  }

  function canvasPoint(event) {
    const bounds = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(canvas.width, (event.clientX - bounds.left) * canvas.width / bounds.width)),
      y: Math.max(0, Math.min(canvas.height, (event.clientY - bounds.top) * canvas.height / bounds.height)),
    };
  }

  function updateBrushCursor(event) {
    const isBrush = state.activeTool === "mosaic" || state.activeTool === "blur";
    if (!state.baseImage || !isBrush || event.pointerType === "touch") {
      refs.brushCursor.classList.add("hidden");
      return;
    }
    const bounds = canvas.getBoundingClientRect();
    const brushSize = state.defaults[`${state.activeTool}BrushSize`] * bounds.width / canvas.width;
    refs.brushCursor.style.left = `${event.clientX - bounds.left}px`;
    refs.brushCursor.style.top = `${event.clientY - bounds.top}px`;
    refs.brushCursor.style.width = `${brushSize}px`;
    refs.brushCursor.style.height = `${brushSize}px`;
    refs.brushCursor.classList.remove("hidden");
  }

  function distanceToSegment(point, start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
    const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
  }

  function pointInEdit(point, edit) {
    if (isBrushEdit(edit)) {
      const tolerance = 4 * canvas.width / Math.max(1, canvas.getBoundingClientRect().width);
      const radius = edit.brushSize / 2 + tolerance;
      if (edit.points.length === 1) return Math.hypot(point.x - edit.points[0].x, point.y - edit.points[0].y) <= radius;
      return edit.points.slice(1).some((end, index) => distanceToSegment(point, edit.points[index], end) <= radius);
    }
    const item = normalizedRect(edit);
    if (edit.shape === "ellipse") {
      const rx = item.w / 2 || 1;
      const ry = item.h / 2 || 1;
      return ((point.x - item.x - rx) / rx) ** 2 + ((point.y - item.y - ry) / ry) ** 2 <= 1;
    }
    return point.x >= item.x && point.x <= item.x + item.w && point.y >= item.y && point.y <= item.y + item.h;
  }

  function findEdit(point) {
    return [...state.edits].reverse().find((edit) => pointInEdit(point, edit));
  }

  function nearResizeHandle(point, edit) {
    const item = getEditBounds(edit);
    const tolerance = 16 * canvas.width / Math.max(1, canvas.getBoundingClientRect().width);
    return Math.abs(point.x - (item.x + item.w)) <= tolerance && Math.abs(point.y - (item.y + item.h)) <= tolerance;
  }

  function beginInteraction(event) {
    if (!state.baseImage || event.button > 0) return;
    const point = canvasPoint(event);
    canvas.setPointerCapture(event.pointerId);

    if (state.activeTool === "select") {
      const selected = state.edits.find((edit) => edit.id === state.selectedId);
      if (selected && nearResizeHandle(point, selected)) {
        snapshot();
        const item = getEditBounds(selected);
        if (!isBrushEdit(selected)) Object.assign(selected, item);
        state.interaction = {
          mode: "resize",
          id: selected.id,
          start: point,
          startW: item.w,
          startH: item.h,
          startFontSize: selected.fontSize,
          aspectRatio: item.w / Math.max(1, item.h),
          startBounds: item,
          originalPoints: selected.points?.map((brushPoint) => ({ ...brushPoint })),
          originalBrushSize: selected.brushSize,
        };
      } else {
        const hit = findEdit(point);
        state.selectedId = hit?.id ?? null;
        if (hit) {
          const item = getEditBounds(hit);
          state.interaction = { mode: "move", id: hit.id, offsetX: point.x - item.x, offsetY: point.y - item.y, moved: false };
        }
      }
      updateSelectionPanel();
      render();
      return;
    }

    if (state.activeTool === "text") {
      const text = state.defaults.text.trim();
      if (!text) { showToast("テキストを入力してください"); return; }
      snapshot();
      const edit = { id: state.nextId++, type: "text", x: point.x, y: point.y, w: 0, h: 0, text, fontSize: state.defaults.fontSize, color: state.defaults.textColor, background: state.defaults.textBackground };
      state.edits.push(edit);
      state.selectedId = edit.id;
      setTool("select");
      render();
      return;
    }

    if (state.activeTool === "overlay") {
      refs.overlayInput.click();
      return;
    }

    if (state.activeTool === "mosaic" || state.activeTool === "blur") {
      const draft = {
        id: state.nextId,
        type: state.activeTool,
        points: [point],
        brushSize: state.defaults[`${state.activeTool}BrushSize`],
        amount: state.defaults[state.activeTool === "mosaic" ? "mosaicSize" : "blurAmount"],
      };
      state.draft = draft;
      state.interaction = { mode: "brush" };
      render();
      return;
    }

    const shape = state.defaults[`${state.activeTool}Shape`];
    const draft = { id: state.nextId, type: state.activeTool, x: point.x, y: point.y, w: 0, h: 0, shape };
    if (draft.type === "cover") draft.color = state.defaults.coverColor;
    state.draft = draft;
    state.interaction = { mode: "draw", start: point };
  }

  function moveInteraction(event) {
    if (!state.interaction) return;
    const point = canvasPoint(event);
    if (state.interaction.mode === "brush" && state.draft) {
      const pointerEvents = event.getCoalescedEvents?.() || [event];
      pointerEvents.forEach((pointerEvent) => {
        const next = canvasPoint(pointerEvent);
        const last = state.draft.points.at(-1);
        const minDistance = Math.max(1, state.draft.brushSize * 0.018);
        if (Math.hypot(next.x - last.x, next.y - last.y) >= minDistance) state.draft.points.push(next);
      });
    } else if (state.interaction.mode === "draw" && state.draft) {
      state.draft.w = point.x - state.interaction.start.x;
      state.draft.h = point.y - state.interaction.start.y;
    } else {
      const edit = state.edits.find((item) => item.id === state.interaction.id);
      if (!edit) return;
      if (state.interaction.mode === "move") {
        if (!state.interaction.moved) snapshot();
        const item = getEditBounds(edit);
        const targetX = point.x - state.interaction.offsetX;
        const targetY = point.y - state.interaction.offsetY;
        if (isBrushEdit(edit)) {
          const dx = targetX - item.x;
          const dy = targetY - item.y;
          edit.points.forEach((brushPoint) => { brushPoint.x += dx; brushPoint.y += dy; });
        } else {
          edit.x = targetX;
          edit.y = targetY;
        }
        state.interaction.moved = true;
      } else if (state.interaction.mode === "resize") {
        const min = 12 * canvas.width / Math.max(1, canvas.getBoundingClientRect().width);
        if (isBrushEdit(edit)) {
          const bounds = state.interaction.startBounds;
          const targetW = Math.max(min, point.x - bounds.x);
          const targetH = Math.max(min, point.y - bounds.y);
          const scaleX = targetW / Math.max(1, bounds.w);
          const scaleY = targetH / Math.max(1, bounds.h);
          edit.points = state.interaction.originalPoints.map((brushPoint) => ({
            x: bounds.x + (brushPoint.x - bounds.x) * scaleX,
            y: bounds.y + (brushPoint.y - bounds.y) * scaleY,
          }));
          edit.brushSize = Math.max(4, state.interaction.originalBrushSize * Math.min(scaleX, scaleY));
        } else {
          edit.w = Math.max(min, point.x - edit.x);
          edit.h = Math.max(min, point.y - edit.y);
          if (edit.type === "overlay") edit.h = edit.w / state.interaction.aspectRatio;
          if (edit.type === "text") {
            const ratio = edit.h / state.interaction.startH;
            edit.fontSize = Math.max(10, Math.round(state.interaction.startFontSize * ratio));
          }
        }
      }
    }
    render();
  }

  function endInteraction(event) {
    if (!state.interaction) return;
    const completedInteraction = state.interaction;
    if (state.interaction.mode === "brush" && state.draft) {
      const finalPoint = canvasPoint(event);
      const lastPoint = state.draft.points.at(-1);
      if (Math.hypot(finalPoint.x - lastPoint.x, finalPoint.y - lastPoint.y) > 1) state.draft.points.push(finalPoint);
      snapshot();
      state.draft.id = state.nextId++;
      state.edits.push(state.draft);
      state.selectedId = state.draft.id;
      state.draft = null;
    } else if (state.interaction.mode === "draw" && state.draft) {
      const item = normalizedRect(state.draft);
      const minSize = 5 * canvas.width / Math.max(1, canvas.getBoundingClientRect().width);
      if (item.w >= minSize && item.h >= minSize) {
        snapshot();
        item.id = state.nextId++;
        state.edits.push(item);
        state.selectedId = item.id;
      }
      state.draft = null;
    }
    state.interaction = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    render();
    updateSelectionPanel();
    if (completedInteraction.mode === "move" && !completedInteraction.moved && window.innerWidth <= 720) {
      refs.inspector.classList.add("open");
    }
  }

  function updateSelectionPanel() {
    const edit = state.edits.find((item) => item.id === state.selectedId);
    refs.selectionEmpty.classList.toggle("hidden", Boolean(edit));
    refs.selectionControls.classList.toggle("hidden", !edit);
    if (edit) {
      $("#selectedTypeName").textContent = toolNames[edit.type];
      $("#selectedTypeIcon").innerHTML = typeIcons[edit.type];
    }
  }

  function deleteSelected() {
    const index = state.edits.findIndex((edit) => edit.id === state.selectedId);
    if (index < 0) return;
    snapshot();
    state.edits.splice(index, 1);
    state.selectedId = null;
    updateSelectionPanel();
    render();
    showToast("加工を削除しました");
  }

  function updateZoom() {
    if (!state.baseImage) return;
    const displayed = canvas.getBoundingClientRect().width;
    refs.zoomInfo.textContent = `${Math.round(displayed / canvas.width * 100)}%`;
  }

  function showToast(message) {
    $("p", refs.toast).textContent = message;
    refs.toast.classList.add("show");
    clearTimeout(showToast.timeout);
    showToast.timeout = setTimeout(() => refs.toast.classList.remove("show"), 2200);
  }

  function downloadImage() {
    const format = state.exportFormat;
    const mime = `image/${format}`;
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = canvas.width;
    exportCanvas.height = canvas.height;
    const exportCtx = exportCanvas.getContext("2d");
    if (format === "jpeg") {
      exportCtx.fillStyle = "white";
      exportCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
    }
    const selected = state.selectedId;
    state.selectedId = null;
    render();
    exportCtx.drawImage(canvas, 0, 0);
    state.selectedId = selected;
    render();
    exportCanvas.toBlob((blob) => {
      if (!blob) { showToast("書き出しに失敗しました"); return; }
      const link = document.createElement("a");
      const extension = format === "jpeg" ? "jpg" : format;
      link.href = URL.createObjectURL(blob);
      link.download = `${state.fileName}-edited.${extension}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      refs.exportDialog.close();
      showToast("画像を書き出しました");
    }, mime, 0.92);
  }

  function bindRange(id, stateKey, outputId, suffix = "") {
    const input = $(`#${id}`);
    const output = $(`#${outputId}`);
    const update = () => {
      state.defaults[stateKey] = Number(input.value);
      output.value = `${input.value}${suffix}`;
      const progress = (input.value - input.min) / (input.max - input.min) * 100;
      input.style.setProperty("--range-progress", `${progress}%`);
    };
    input.addEventListener("input", update);
    update();
  }

  function bindShape(groupId, stateKey) {
    $$("button", $(`#${groupId}`)).forEach((button) => button.addEventListener("click", () => {
      $$("button", $(`#${groupId}`)).forEach((item) => item.classList.toggle("active", item === button));
      state.defaults[stateKey] = button.dataset.shape;
    }));
  }

  $$(".tool-button").forEach((button) => button.addEventListener("click", () => {
    if (button.dataset.tool === "overlay" && state.baseImage && window.innerWidth > 720) setTool("overlay");
    else setTool(button.dataset.tool);
  }));

  ["#openButton", "#emptyOpenButton"].forEach((id) => $(id).addEventListener("click", () => refs.imageInput.click()));
  $("#sampleButton").addEventListener("click", createSample);
  $("#overlayOpenButton").addEventListener("click", () => refs.overlayInput.click());
  refs.imageInput.addEventListener("change", (event) => { loadFile(event.target.files[0]); event.target.value = ""; });
  refs.overlayInput.addEventListener("change", (event) => { loadFile(event.target.files[0], true); event.target.value = ""; });
  refs.undoButton.addEventListener("click", undo);
  refs.redoButton.addEventListener("click", redo);
  $("#deleteButton").addEventListener("click", deleteSelected);
  $("#closeInspector").addEventListener("click", () => refs.inspector.classList.remove("open"));

  canvas.addEventListener("pointerdown", beginInteraction);
  canvas.addEventListener("pointermove", moveInteraction);
  canvas.addEventListener("pointermove", updateBrushCursor);
  canvas.addEventListener("pointerenter", updateBrushCursor);
  canvas.addEventListener("pointerleave", () => refs.brushCursor.classList.add("hidden"));
  canvas.addEventListener("pointerup", endInteraction);
  canvas.addEventListener("pointercancel", endInteraction);

  bindRange("mosaicBrushSize", "mosaicBrushSize", "mosaicBrushSizeValue", "px");
  bindRange("mosaicSize", "mosaicSize", "mosaicSizeValue");
  bindRange("blurBrushSize", "blurBrushSize", "blurBrushSizeValue", "px");
  bindRange("blurAmount", "blurAmount", "blurAmountValue");
  bindShape("coverShape", "coverShape");

  const coverColor = $("#coverColor");
  const coverColorText = $("#coverColorText");
  const coverColorSwatch = $("#coverColorSwatch");
  function setCoverColor(color) {
    state.defaults.coverColor = color.toLowerCase();
    coverColor.value = color;
    coverColorText.value = color.toUpperCase();
    coverColorSwatch.style.background = color;
    $$("button", $("#quickColors")).forEach((button) => button.classList.toggle("active", button.dataset.color.toLowerCase() === color.toLowerCase()));
  }
  coverColor.addEventListener("input", () => setCoverColor(coverColor.value));
  coverColorText.addEventListener("change", () => {
    if (/^#[0-9a-f]{6}$/i.test(coverColorText.value)) setCoverColor(coverColorText.value);
    else coverColorText.value = state.defaults.coverColor.toUpperCase();
  });
  $$("button", $("#quickColors")).forEach((button) => button.addEventListener("click", () => setCoverColor(button.dataset.color)));
  setCoverColor(state.defaults.coverColor);

  $("#textContent").addEventListener("input", (event) => { state.defaults.text = event.target.value; });
  $("#fontSize").addEventListener("input", (event) => { state.defaults.fontSize = Math.max(10, Number(event.target.value) || 42); });
  $("#textBackground").addEventListener("change", (event) => { state.defaults.textBackground = event.target.checked; });
  $("#textColor").addEventListener("input", (event) => {
    state.defaults.textColor = event.target.value;
    $("#textColorSwatch").style.background = event.target.value;
  });
  $("#textColorSwatch").style.background = state.defaults.textColor;

  refs.exportButton.addEventListener("click", () => refs.exportDialog.showModal());
  $$("button", $("#formatGrid")).forEach((button) => button.addEventListener("click", () => {
    state.exportFormat = button.dataset.format;
    $$("button", $("#formatGrid")).forEach((item) => item.classList.toggle("active", item === button));
  }));
  $("#downloadButton").addEventListener("click", downloadImage);

  const workspace = $("#workspace");
  let dragDepth = 0;
  workspace.addEventListener("dragenter", (event) => { event.preventDefault(); dragDepth++; refs.dropOverlay.classList.remove("hidden"); });
  workspace.addEventListener("dragover", (event) => event.preventDefault());
  workspace.addEventListener("dragleave", (event) => { event.preventDefault(); dragDepth--; if (dragDepth <= 0) { dragDepth = 0; refs.dropOverlay.classList.add("hidden"); } });
  workspace.addEventListener("drop", (event) => {
    event.preventDefault();
    dragDepth = 0;
    refs.dropOverlay.classList.add("hidden");
    loadFile(event.dataTransfer.files[0]);
  });

  document.addEventListener("paste", (event) => {
    const file = [...event.clipboardData.items].find((item) => item.type.startsWith("image/"))?.getAsFile();
    if (file) loadFile(file);
  });

  document.addEventListener("keydown", (event) => {
    const editingText = ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName);
    if (!editingText && (event.key === "Delete" || event.key === "Backspace")) deleteSelected();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      event.shiftKey ? redo() : undo();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); }
    if (event.key === "Escape") { state.selectedId = null; state.draft = null; refs.inspector.classList.remove("open"); render(); updateSelectionPanel(); }
  });

  new ResizeObserver(() => { updateZoom(); render(); }).observe($("#canvasStage"));
  window.addEventListener("resize", updateZoom);

  if (new URLSearchParams(location.search).has("demo")) createSample();
})();
