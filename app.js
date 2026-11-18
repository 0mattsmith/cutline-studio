/*
 * Cutline Studio — web app
 *
 *   • Drag photos in, arrange them in a printable grid, export to PDF or Word.
 *   • Each photo is cropped to fill a square cell (default 4.4 cm × 4.4 cm).
 *   • Pages can be portrait or landscape — all together, or one at a time.
 *   • Optional cell borders (10 styles, any colour) and a file-name footer.
 *   • Everything happens on this device — no server, no upload.
 *
 * Page geometry lives in layout.js and border drawing in borders.js. This
 * file is the interface plus photo import and PDF/Word export.
 */

"use strict";

// Polyfill replaceChildren for older Android WebViews (Chrome < 86).
for (const Proto of [Element.prototype, Document.prototype, DocumentFragment.prototype]) {
  if (Proto && typeof Proto.replaceChildren !== "function") {
    Proto.replaceChildren = function (...nodes) {
      this.textContent = "";
      if (nodes.length) this.append(...nodes);
    };
  }
}

const Layout = window.CutlineStudioLayout;
const Borders = window.CutlineStudioBorders;

const APP_VERSION = "1.1.0";
const REPO_VERSION_URL = "https://0mattsmith.github.io/cutline-studio/version.json";

// ─── Constants ────────────────────────────────────────────────────────────

const SUPPORTED_EXT = new Set([
  "jpg", "jpeg", "jpe", "jfif", "png", "gif", "bmp", "tif", "tiff",
  "webp", "ico", "heic", "heif", "hif", "heics", "heifs", "avif",
]);

// Export image settings. With "Compress images" on, every photo is cropped
// to what's visible in its cell and resized to the chosen DPI at its printed
// size (never enlarged). With it off, photos are cropped but keep their own
// resolution.
const QUALITY_PROFILES = {
  print:   { dpi: 300, jpeg: 0.92, label: "Print" },
  reduced: { dpi: 200, jpeg: 0.82, label: "Reduced" },
  minimum: { dpi: 110, jpeg: 0.72, label: "Minimum" },
};
const FULL_RES_PROFILE = { dpi: 0, jpeg: 0.95, label: "Full resolution" };
// Largest exported image edge — keeps canvases inside iOS Safari's limits.
const MAX_EXPORT_EDGE_PX = 4096;

// On-screen thumbnails. ~800 px is plenty for the preview and keeps memory low.
const THUMB_MAX_PX = 800;
const THUMB_JPEG_Q = 0.85;

// Crop zoom: 1 = cover fit (the shorter side fills the cell), up to 4×.
const CROP_ZOOM_MIN = 1.0;
const CROP_ZOOM_MAX = 4.0;
const CROP_ZOOM_STEP = 0.15;

// Canvas zoom. 100% = real size on a 96 dpi screen.
const PX_PER_MM = 96 / 25.4;
const VIEW_ZOOM_MIN = 0.1;
const VIEW_ZOOM_MAX = 3;
const PAGE_HEAD_PX = 36;

// Footer fonts. These three families look the same on screen, in the PDF
// (built-in PDF fonts) and in Word (fonts installed on every PC and Mac).
const FOOTER_FONTS = {
  sans:  { pdf: "helvetica", word: "Arial",           css: 'Arial, Helvetica, "Liberation Sans", sans-serif' },
  serif: { pdf: "times",     word: "Times New Roman", css: '"Times New Roman", Times, "Liberation Serif", serif' },
  mono:  { pdf: "courier",   word: "Courier New",     css: '"Courier New", Courier, "Liberation Mono", monospace' },
};
const FOOTER_SIZE_MIN = 6;
const FOOTER_SIZE_MAX = 28;
const FOOTER_PLACEHOLDER = "File name";

const COLOR_SWATCHES = [
  { hex: "#000000", name: "Black" },
  { hex: "#404040", name: "Dark grey" },
  { hex: "#8C8C8C", name: "Grey" },
  { hex: "#BFBFBF", name: "Light grey" },
  { hex: "#8B3DFF", name: "Purple" },
  { hex: "#3D7DF2", name: "Blue" },
  { hex: "#00B8C8", name: "Teal" },
  { hex: "#1E9E5A", name: "Green" },
  { hex: "#F5B400", name: "Yellow" },
  { hex: "#F2711C", name: "Orange" },
  { hex: "#E03E44", name: "Red" },
  { hex: "#E6549F", name: "Pink" },
];

const FILE_TYPES = {
  pdf: {
    ext: ".pdf", label: "PDF", button: "Save PDF…",
    mime: "application/pdf", description: "PDF document",
  },
  docx: {
    ext: ".docx", label: "Word document", button: "Save Word document…",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    description: "Word document",
  },
};

// Characters that aren't allowed in file names on Windows/macOS/Linux.
const BAD_FILENAME_CHARS = /[\\/:*?"<>|\x00-\x1f\x7f]+/g;

// Worker pool — HEIC decoding (when the OS can't do it) runs off the main
// thread so the UI stays responsive.
const WORKER_POOL_SIZE = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));

let _idCounter = 0;
const nextId = () => `img_${++_idCounter}`;

// ─── State ────────────────────────────────────────────────────────────────

const state = {
  images: [],
  // Per-image record:
  //   { id, file, name, loading?, error?,
  //     sourceBlob,           // original image (or HEIC→JPEG) used for export
  //     previewUrl,           // ObjectURL of a small thumbnail, used on screen
  //     w, h,                 // natural size of the source image
  //     cropAnchor: {x, y},   // 0..1 each, drag-to-pan crop offset
  //     cropZoom,             // 1..CROP_ZOOM_MAX
  //     exportCache }         // { key, bytes, w, h } from the last export
  selectedId: null,
  selectedPage: 0,
  pageOrientation: {},        // page index → "portrait" | "landscape"
  lastFileName: "",           // name of the last export (pre-fills the next)
  activePanel: "photos",
  panelOpen: true,
  viewZoom: null,             // null = fit the page to the window
  settings: {
    rows: 5,
    cols: 4,
    cellSizeCm: 4.4,
    pageSize: "A4",
    orientation: "portrait",     // pages without their own orientation use this
    orientationAllPages: true,   // orientation changes apply to every page
    marginMm: 12,
    spacingMm: 3,
    trimEmptyRows: true,
    squareCrop: true,

    borderEnabled: false,
    borderStyle: Borders.DEFAULT_STYLE,   // dashed
    borderColor: Borders.DEFAULT_COLOR,   // light grey

    footerEnabled: true,
    footerFont: "sans",
    footerSizePt: 10,
    footerBold: false,
    footerItalic: false,
    footerAlign: "center",
    footerColor: "#404040",

    compressImages: true,
    outputQuality: "print",      // "print" | "reduced" | "minimum"
    exportFormat: "pdf",         // "pdf" | "docx"
  },
};

// ─── DOM refs ─────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const els = {
  studio:        $("dropTarget"),
  status:        $("statusBar"),
  dropOverlay:   $("dropOverlay"),
  railBtns:      Array.from(document.querySelectorAll(".rail-btn")),
  panelViews:    Array.from(document.querySelectorAll(".panel-view")),

  fileList:      $("fileList"),
  fileInput:     $("fileInput"),
  photoCount:    $("photoCount"),
  photosEmpty:   $("photosEmpty"),
  btnAdd:        $("btnAdd"),
  btnUp:         $("btnUp"),
  btnDown:       $("btnDown"),
  btnRemove:     $("btnRemove"),
  btnClear:      $("btnClear"),

  cropEditor:    $("cropEditor"),
  cropEmpty:     $("cropEmpty"),
  cropEmptyText: $("cropEmptyText"),
  cropFrame:     $("cropFrame"),
  cropImage:     $("cropImage"),
  cropName:      $("cropName"),
  ctlCropZoom:   $("ctlCropZoom"),
  btnResetCrop:  $("btnResetCrop"),
  btnZoomIn:     $("btnZoomIn"),
  btnZoomOut:    $("btnZoomOut"),
  zoomLabel:     $("zoomLabel"),

  ctlRows:       $("ctlRows"),
  ctlCols:       $("ctlCols"),
  ctlCellCm:     $("ctlCellCm"),
  ctlCellCmNum:  $("ctlCellCmNum"),
  ctlPage:       $("ctlPage"),
  ctlMargin:     $("ctlMargin"),
  ctlMarginNum:  $("ctlMarginNum"),
  ctlSpacing:    $("ctlSpacing"),
  ctlSpacingNum: $("ctlSpacingNum"),
  ctlTrim:       $("ctlTrim"),
  ctlSquareCrop: $("ctlSquareCrop"),

  ctlBorders:      $("ctlBorders"),
  borderOptions:   $("borderOptions"),
  borderStyleList: $("borderStyleList"),
  borderSwatches:  $("borderSwatches"),

  footerOptions:    $("footerOptions"),
  footerSample:     $("footerSample"),
  ctlFooterSize:    $("ctlFooterSize"),
  ctlFooterSizeNum: $("ctlFooterSizeNum"),
  btnFooterBold:    $("btnFooterBold"),
  btnFooterItalic:  $("btnFooterItalic"),
  footerSwatches:   $("footerSwatches"),

  ctxPhoto:      $("ctxPhoto"),
  ctxThumb:      $("ctxThumb"),
  ctxName:       $("ctxName"),
  ctxCrop:       $("ctxCrop"),
  ctxUp:         $("ctxUp"),
  ctxDown:       $("ctxDown"),
  ctxRemove:     $("ctxRemove"),

  preview:       $("previewStack"),
  previewScroll: $("previewScroll"),
  pagerLabel:    $("pagerLabel"),
  btnPagePrev:   $("btnPagePrev"),
  btnPageNext:   $("btnPageNext"),
  fitWarning:    $("fitWarning"),
  fitWarningText:$("fitWarningText"),
  ctlViewZoom:   $("ctlViewZoom"),
  outViewZoom:   $("outViewZoom"),
  btnFit:        $("btnFit"),

  btnExportOpen:   $("btnExportOpen"),
  exportCard:      $("exportCard"),
  btnExportClose:  $("btnExportClose"),
  ctlCompress:     $("ctlCompress"),
  qualityChips:    $("qualityChips"),
  compressOffNote: $("compressOffNote"),
  btnEditFooter:   $("btnEditFooter"),
  exportSummary:   $("exportSummary"),
  btnExportGo:     $("btnExportGo"),

  dlg:        $("appDialog"),
  dlgForm:    $("appDialogForm"),
  dlgTitle:   $("appDialogTitle"),
  dlgMessage: $("appDialogMessage"),
  dlgField:   $("appDialogField"),
  dlgLabel:   $("appDialogLabel"),
  dlgInput:   $("appDialogInput"),
  dlgSuffix:  $("appDialogSuffix"),
  dlgOk:      $("appDialogOk"),
  dlgCancel:  $("appDialogCancel"),

  toast:             $("toast"),
  toastText:         $("toastText"),
  toastBtn:          $("toastBtn"),
  busy:              $("busyOverlay"),
  busyText:          $("busyText"),
  netIndicator:      $("netIndicator"),
  btnInstall:        $("btnInstall"),
  btnVersion:        $("btnVersion"),
  versionLabel:      $("versionLabel"),
  updateDot:         $("updateDot"),
  updateBanner:      $("updateBanner"),
  updateBannerText:  $("updateBannerText"),
  btnUpdateAction:   $("btnUpdateAction"),
  btnDismissUpdate:  $("btnDismissUpdate"),
  updateDlg:         $("updateDialog"),
  btnUpdateDlgClose: $("btnUpdateDlgClose"),
  updatePlatform:    $("updatePlatform"),
  updateCurrentVer:  $("updateCurrentVer"),
  updateStatusText:  $("updateStatusText"),
  updateNotesText:   $("updateNotesText"),
  updateProgressWrap:$("updateProgressWrap"),
  updateProgress:    $("updateProgress"),
  updateProgressLabel:$("updateProgressLabel"),
  updateAutoRow:     $("updateAutoRow"),
  updateAutoDesc:    $("updateAutoDesc"),
  ctlAutoUpdate:     $("ctlAutoUpdate"),
  btnCheckUpdates:   $("btnCheckUpdates"),
  btnApplyUpdate:    $("btnApplyUpdate"),
  iosInstallTip:     $("iosInstallTip"),
  btnDismissIosTip:  $("btnDismissIosTip"),
  contextMenu:       $("contextMenu"),
};

const isAndroidApk = !!window.CutlineAndroid;
let isWordAddin = false;
let isWordDialog = false;

if (window.Office) {
  Office.onReady((info) => {
    if (info.host === Office.HostType.Word) {
      isWordAddin = true;
      if (window.location.search.includes("dialog=true")) {
        isWordDialog = true;
      }
      document.body.classList.add("is-word-addin");
      
      els.btnExportOpen.querySelector("span").textContent = "Insert";
      els.btnExportGo.textContent = "Insert into Document";
      
      document.querySelector('input[name="exportFormat"][value="pdf"]').closest('.choice').style.display = 'none';
      state.settings.exportFormat = "docx";
      document.querySelector('input[name="exportFormat"][value="docx"]').checked = true;
      syncControlsFromState();
      renderUpdaterUi();
    }
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  buildBorderStylePicker();
  buildSwatches(els.borderSwatches, "borderColor", (hex) => {
    state.settings.borderColor = hex;
    state.settings.borderEnabled = true;
    syncControlsFromState();
    render();
  });
  buildSwatches(els.footerSwatches, "footerColor", (hex) => {
    state.settings.footerColor = hex;
    syncControlsFromState();
    render();
  });
  syncControlsFromState();
  attachEventListeners();
  attachCropDragHandlers();
  attachCanvasHandlers();
  initDialog();
  initNetworkIndicator();
  initInstallable();
  initUpdater();
  initContextMenu();
  initAndroidBackHandler();
  setActivePanel(state.activePanel, true);
  render();
});

// ─── Small helpers ────────────────────────────────────────────────────────

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function hasFiles(dt) { return !!dt?.types && Array.from(dt.types).includes("Files"); }
function plural(n, word) { return `${n} ${word}${n === 1 ? "" : "s"}`; }
function capitalise(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function truncate(s, n) { return (s && s.length > n) ? s.slice(0, n - 1) + "…" : (s || ""); }

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function iconButton(iconId, label) {
  const b = el("button", "icon-btn");
  b.type = "button";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${iconId}"/></svg>`;
  return b;
}

function updateRangeFill(range) {
  const min = parseFloat(range.min) || 0;
  const max = parseFloat(range.max) || 100;
  const pct = max > min ? ((parseFloat(range.value) - min) / (max - min)) * 100 : 0;
  range.style.setProperty("--fill", `${clamp(pct, 0, 100)}%`);
}

function setStatus(text) { els.status.textContent = text; }
function showBusy(text)  { els.busyText.textContent = text || "Working…"; els.busy.hidden = false; }
function setBusy(text)   { els.busyText.textContent = text; }
function hideBusy()      { els.busy.hidden = true; }

let _toastTO = null;
let _toastAction = null;
function showToast(text, opts = 3500) {
  const options = typeof opts === "number" ? { ms: opts } : (opts || {});
  const ms = options.ms ?? 3500;
  els.toastText.textContent = text;
  if (options.actionLabel && typeof options.onAction === "function") {
    _toastAction = options.onAction;
    els.toastBtn.textContent = options.actionLabel;
    els.toastBtn.hidden = false;
  } else {
    _toastAction = null;
    els.toastBtn.hidden = true;
  }
  els.toast.hidden = false;
  clearTimeout(_toastTO);
  _toastTO = setTimeout(() => {
    els.toast.hidden = true;
    _toastAction = null;
  }, ms);
}

// ─── In-app dialog ────────────────────────────────────────────────────────
// One <dialog> is reused for confirmations, alerts and the "Save as" name
// prompt (used when the browser has no native save dialog).

let _dialogResolve = null;
let _dialogValidate = null;

function initDialog() {
  els.dlgForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!els.dlgOk.disabled) closeDialog(true);
  });
  els.dlgCancel.addEventListener("click", () => closeDialog(false));
  els.dlg.addEventListener("cancel", (e) => { e.preventDefault(); closeDialog(false); });
  els.dlgInput.addEventListener("input", validateDialogInput);
}

function openDialog({ title, message = "", okLabel = "OK", cancelLabel = "Cancel", danger = false, input = null }) {
  if (_dialogResolve) closeDialog(false);
  hideContextMenu();
  closeExportCard();
  els.dlgTitle.textContent = title;
  els.dlgMessage.textContent = message;
  els.dlgOk.textContent = okLabel;
  els.dlgOk.classList.toggle("btn-danger", danger);
  els.dlgCancel.hidden = cancelLabel == null;
  els.dlgCancel.textContent = cancelLabel || "";
  els.dlgField.hidden = !input;
  _dialogValidate = input?.validate || null;
  if (input) {
    els.dlgLabel.textContent = input.label || "";
    els.dlgInput.value = input.value || "";
    els.dlgSuffix.textContent = input.suffix || "";
  }
  validateDialogInput();
  els.dlg.showModal();
  if (input) {
    els.dlgInput.focus();
    els.dlgInput.select();
  } else {
    els.dlgOk.focus();
  }
  return new Promise((resolve) => { _dialogResolve = resolve; });
}

function closeDialog(ok) {
  const resolve = _dialogResolve;
  _dialogResolve = null;
  const value = els.dlgInput.value;
  if (els.dlg.open) els.dlg.close();
  resolve?.({ ok, value });
}

function validateDialogInput() {
  els.dlgOk.disabled = !!(_dialogValidate && !_dialogValidate(els.dlgInput.value));
}

async function confirmDialog(opts) { return (await openDialog(opts)).ok; }
function alertDialog(opts) { return openDialog({ okLabel: "OK", cancelLabel: null, ...opts }); }

// ─── Panels ───────────────────────────────────────────────────────────────

function setActivePanel(name, open = true) {
  state.activePanel = name;
  state.panelOpen = open;
  els.studio.classList.toggle("panel-collapsed", !open);
  for (const b of els.railBtns) {
    b.setAttribute("aria-pressed", String(open && b.dataset.panel === name));
  }
  for (const v of els.panelViews) v.hidden = v.dataset.view !== name;
}

function openPanel(name) { setActivePanel(name, true); }

// ─── Custom context menu ──────────────────────────────────────────────────

function initContextMenu() {
  document.addEventListener("contextmenu", (e) => {
    // Keep the browser's menu for text fields (copy/paste) and dialogs.
    if (e.target.closest?.('input[type="text"], input[type="number"], textarea, dialog')) return;
    e.preventDefault();
    showContextMenu(e);
  });
  document.addEventListener("click", hideContextMenu);
  // Scroll events arrive a frame late, so ignore any that land just after
  // the menu opens (they belong to a scroll that happened before it).
  document.addEventListener("scroll", () => {
    if (performance.now() - _menuOpenedAt > 150) hideContextMenu();
  }, true);
  window.addEventListener("blur", hideContextMenu);
}

let _menuOpenedAt = 0;

function showContextMenu(event) {
  const items = buildContextMenuItems(event.target);
  if (!items.length) return;

  const menu = els.contextMenu;
  menu.replaceChildren();
  for (const it of items) {
    if (it.sep) { menu.appendChild(el("div", "ctx-sep")); continue; }
    if (it.header) { menu.appendChild(el("div", "ctx-header", it.header)); continue; }
    const row = el("div", "ctx-item" + (it.danger ? " danger" : "") + (it.disabled ? " disabled" : "") + (it.checked ? " checked" : ""));
    row.setAttribute("role", it.checked != null ? "menuitemradio" : "menuitem");
    if (it.checked != null) row.setAttribute("aria-checked", String(!!it.checked));
    row.tabIndex = -1;
    row.appendChild(el("span", null, it.label));
    if (it.shortcut) row.appendChild(el("span", "shortcut", it.shortcut));
    if (!it.disabled) {
      row.addEventListener("click", (ev) => {
        ev.stopPropagation();
        hideContextMenu();
        it.action?.();
      });
    }
    menu.appendChild(row);
  }
  menu.hidden = false;
  _menuOpenedAt = performance.now();

  const margin = 6;
  menu.style.left = "0px";
  menu.style.top = "0px";
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(margin, Math.min(event.clientX, window.innerWidth - width - margin))}px`;
  menu.style.top = `${Math.max(margin, Math.min(event.clientY, window.innerHeight - height - margin))}px`;
}

function hideContextMenu() {
  if (els.contextMenu && !els.contextMenu.hidden) els.contextMenu.hidden = true;
}

/** Menu items for what was right-clicked: a photo, a page, or empty space. */
function buildContextMenuItems(target) {
  const items = [];

  const li = target.closest?.("li[data-id]");
  const cell = target.closest?.(".cell.filled[data-img-id]");
  const imgId = li?.dataset?.id || cell?.dataset?.imgId;
  const img = imgId ? state.images.find((i) => i.id === imgId) : null;

  if (img) {
    if (state.selectedId !== img.id) selectImageById(img.id);
    const idx = state.images.indexOf(img);
    items.push({ header: truncate(img.name, 36) });
    items.push({ label: "Crop…", disabled: !!img.error || !state.settings.squareCrop, action: () => openPanel("crop") });
    items.push({ label: "Move earlier", shortcut: "Ctrl ↑", disabled: idx === 0, action: () => shiftSelection(-1) });
    items.push({ label: "Move later", shortcut: "Ctrl ↓", disabled: idx === state.images.length - 1, action: () => shiftSelection(+1) });
    items.push({
      label: "Reset crop",
      disabled: !state.settings.squareCrop,
      action: () => resetCrop(img),
    });
    items.push({ label: "Remove from grid", shortcut: "Del", danger: true, action: () => removeSelected() });
    items.push({ sep: true });
  }

  const wrap = target.closest?.(".page-wrap[data-page]");
  if (wrap) {
    const pageIndex = parseInt(wrap.dataset.page, 10);
    const current = orientationOfPage(pageIndex);
    items.push({ header: `Page ${pageIndex + 1}` });
    items.push({ label: "Portrait", checked: current === "portrait", action: () => { selectPage(pageIndex); setOrientation("portrait", pageIndex); } });
    items.push({ label: "Landscape", checked: current === "landscape", action: () => { selectPage(pageIndex); setOrientation("landscape", pageIndex); } });
    items.push({ label: `Make every page ${current}`, action: () => setOrientation(current, "all") });
    items.push({ sep: true });
  }

  items.push({ label: "Upload photos…", action: () => els.fileInput.click() });
  items.push({ label: "Clear all…", danger: true, disabled: state.images.length === 0, action: clearAll });
  items.push({ sep: true });
  items.push({ label: "Export PDF…", disabled: state.images.length === 0, action: () => exportDocument("pdf") });
  items.push({ label: "Export Word…", disabled: state.images.length === 0, action: () => exportDocument("docx") });
  return items;
}

// ─── PWA install (Chrome/Edge/Android prompt + iOS Safari tip) ───────────

let _deferredInstallPrompt = null;

function initInstallable() {
  const isStandalone =
    isAndroidApk ||
    window.matchMedia?.("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
  if (isStandalone) {
    els.btnInstall.hidden = true;
    els.iosInstallTip.hidden = true;
    return;
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    _deferredInstallPrompt = e;
    els.btnInstall.hidden = false;
  });
  window.addEventListener("appinstalled", () => {
    els.btnInstall.hidden = true;
    els.iosInstallTip.hidden = true;
    setStatus("App installed. Look for Cutline Studio in your apps.");
  });

  els.btnInstall.addEventListener("click", async () => {
    if (!_deferredInstallPrompt) return;
    els.btnInstall.disabled = true;
    try {
      _deferredInstallPrompt.prompt();
      const { outcome } = await _deferredInstallPrompt.userChoice;
      if (outcome === "accepted") els.btnInstall.hidden = true;
    } catch (e) {
      console.warn("install prompt failed", e);
    } finally {
      els.btnInstall.disabled = false;
      _deferredInstallPrompt = null;
    }
  });

  let tipDismissed = false;
  try { tipDismissed = !!localStorage.getItem("photogrid:iosTipDismissed"); } catch (_) {}
  if (isIosSafari() && !tipDismissed) els.iosInstallTip.hidden = false;
  els.btnDismissIosTip.addEventListener("click", () => {
    els.iosInstallTip.hidden = true;
    try { localStorage.setItem("photogrid:iosTipDismissed", "1"); } catch (_) {}
  });
}

function isIosSafari() {
  const ua = navigator.userAgent || "";
  const isIOS = /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  return isIOS && isSafari;
}

// ─── Online/offline indicator ─────────────────────────────────────────────
// Cosmetic — the app works the same offline because photos never leave the
// browser.

function initNetworkIndicator() {
  const update = () => {
    const online = navigator.onLine;
    els.netIndicator.classList.toggle("offline", !online);
    els.netIndicator.title = online
      ? "Online — but your photos still stay on this device."
      : "Offline — the app is cached and photos still process locally.";
  };
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
}

// ─── Version checker & seamless auto-updater (PWA + Android APK) ──────────

function compareSemver(a, b) {
  const pa = String(a || "0").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

const UPDATE_AUTO_KEY = "cutline:autoUpdate";
const _updater = {
  currentVersion: APP_VERSION,
  status: "idle", // idle | checking | available | downloading | ready | up_to_date | error
  latestVersion: null,
  notes: "",
  progress: 0,
  swReg: null,
  bannerDismissedVersion: null,
  autoEnabled: true,
};

function isAutoUpdateEnabled() {
  if (isAndroidApk && typeof window.CutlineAndroid.isAutoUpdateEnabled === "function") {
    return !!window.CutlineAndroid.isAutoUpdateEnabled();
  }
  try { return localStorage.getItem(UPDATE_AUTO_KEY) !== "0"; } catch (_) { return true; }
}

function setAutoUpdateEnabled(enabled) {
  _updater.autoEnabled = !!enabled;
  if (isAndroidApk && typeof window.CutlineAndroid.setAutoUpdateEnabled === "function") {
    window.CutlineAndroid.setAutoUpdateEnabled(!!enabled);
  } else {
    try { localStorage.setItem(UPDATE_AUTO_KEY, enabled ? "1" : "0"); } catch (_) {}
  }
}

function renderUpdaterUi() {
  if (!els.btnVersion) return;
  const ver = _updater.currentVersion || APP_VERSION;
  els.versionLabel.textContent = `v${String(ver).replace(/^v/i, "")}`;
  els.updateCurrentVer.textContent = `v${String(ver).replace(/^v/i, "")}`;
  els.updatePlatform.textContent = isWordAddin
    ? "Microsoft Word Add-in"
    : isAndroidApk
      ? "Android App (GitHub)"
      : "Web App / PWA";

  const hasActionable = _updater.status === "available" || _updater.status === "ready";
  els.updateDot.hidden = !hasActionable;
  els.btnVersion.classList.toggle("has-update", hasActionable);

  if (isWordAddin) {
    els.updateBanner.hidden = true;
    els.updateAutoRow.hidden = true;
    els.btnCheckUpdates.hidden = true;
    els.btnApplyUpdate.hidden = true;
    els.updateProgressWrap.hidden = true;
    els.updateStatusText.textContent = "Managed inside Microsoft Word.";
    return;
  }

  els.ctlAutoUpdate.checked = isAutoUpdateEnabled();
  els.updateAutoDesc.textContent = isAndroidApk
    ? "Automatically check GitHub Releases and download APK updates in the background on Wi-Fi."
    : "Automatically check the GitHub repo and apply updates when opening the app.";

  const lv = _updater.latestVersion ? `v${String(_updater.latestVersion).replace(/^v/i, "")}` : "";
  if (_updater.status === "checking") {
    els.updateStatusText.textContent = "Checking GitHub repo for updates…";
    els.btnApplyUpdate.hidden = true;
    els.updateProgressWrap.hidden = true;
  } else if (_updater.status === "downloading") {
    const pct = clamp(Math.round(_updater.progress || 0), 0, 100);
    els.updateStatusText.textContent = `Downloading ${lv || "update"}…`;
    els.updateProgressWrap.hidden = false;
    els.updateProgress.value = pct;
    els.updateProgressLabel.textContent = `${pct}%`;
    els.btnApplyUpdate.hidden = true;
  } else if (_updater.status === "ready") {
    els.updateStatusText.textContent = `${lv || "A new version"} is ready to install.`;
    els.updateProgressWrap.hidden = true;
    els.btnApplyUpdate.hidden = false;
    els.btnApplyUpdate.textContent = isAndroidApk ? `Install ${lv}` : `Update to ${lv}`;
  } else if (_updater.status === "available") {
    els.updateStatusText.textContent = `${lv || "A new version"} is available from the GitHub repo.`;
    els.updateProgressWrap.hidden = true;
    els.btnApplyUpdate.hidden = false;
    els.btnApplyUpdate.textContent = isAndroidApk ? `Download & Install ${lv}` : `Update to ${lv}`;
  } else if (_updater.status === "error") {
    els.updateStatusText.textContent = _updater.notes || "Could not reach update server right now.";
    els.updateProgressWrap.hidden = true;
    els.btnApplyUpdate.hidden = true;
  } else {
    els.updateStatusText.textContent = _updater.status === "up_to_date"
      ? `You're on the latest version (${els.versionLabel.textContent}).`
      : `Running ${els.versionLabel.textContent}.`;
    els.updateProgressWrap.hidden = true;
    els.btnApplyUpdate.hidden = true;
  }

  if (_updater.notes && _updater.status !== "error") {
    els.updateNotesText.textContent = _updater.notes;
    els.updateNotesText.hidden = false;
  } else {
    els.updateNotesText.hidden = true;
  }

  const showBanner =
    !isWordAddin &&
    (_updater.status === "ready" || _updater.status === "available" || _updater.status === "downloading") &&
    _updater.bannerDismissedVersion !== _updater.latestVersion;
  els.updateBanner.hidden = !showBanner;
  if (showBanner) {
    if (_updater.status === "downloading") {
      els.updateBannerText.textContent = `Downloading Cutline Studio ${lv} (${Math.round(_updater.progress || 0)}%)…`;
      els.btnUpdateAction.hidden = true;
    } else if (_updater.status === "ready") {
      els.updateBannerText.textContent = `Cutline Studio ${lv} is ready`;
      els.btnUpdateAction.hidden = false;
      els.btnUpdateAction.textContent = isAndroidApk ? "Install" : "Update now";
    } else {
      els.updateBannerText.textContent = `Cutline Studio ${lv} is available`;
      els.btnUpdateAction.hidden = false;
      els.btnUpdateAction.textContent = isAndroidApk ? "Download" : "Update now";
    }
  }
}

async function applyAvailableUpdate() {
  if (isAndroidApk) {
    window.CutlineAndroid?.applyUpdate?.();
    return;
  }
  const reg = _updater.swReg;
  if (reg?.waiting) {
    reg.waiting.postMessage("SKIP_WAITING");
  }
  try { sessionStorage.setItem("cutline:justUpdated", _updater.latestVersion || ""); } catch (_) {}
  window.location.reload();
}

async function checkForUpdates(manual = false) {
  if (isWordAddin) return;
  if (isAndroidApk) {
    _updater.status = "checking";
    renderUpdaterUi();
    window.CutlineAndroid?.checkForUpdates?.(!!manual);
    return;
  }

  if (!navigator.onLine) {
    if (manual) {
      _updater.status = "error";
      _updater.notes = "Offline — connect to the internet to check for updates.";
      renderUpdaterUi();
    }
    return;
  }

  _updater.status = "checking";
  if (manual) _updater.notes = "";
  renderUpdaterUi();

  try {
    if (_updater.swReg) {
      await _updater.swReg.update().catch(() => {});
    }
    let res = await fetch(`./version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) {
      res = await fetch(`${REPO_VERSION_URL}?t=${Date.now()}`, { cache: "no-store" });
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const remoteVer = String(data.version || APP_VERSION).replace(/^v/i, "");
    const hasWaitingSw = !!_updater.swReg?.waiting;
    const isNewer = compareSemver(remoteVer, _updater.currentVersion) > 0;

    if (isNewer || hasWaitingSw) {
      _updater.latestVersion = isNewer ? remoteVer : _updater.currentVersion;
      _updater.notes = data.notes || "";
      _updater.status = "ready";
      _updater.bannerDismissedVersion = null;
      renderUpdaterUi();

      // Seamless automatic update when idle with no photos open.
      if (isAutoUpdateEnabled() && state.images.length === 0 && !_exporting) {
        await applyAvailableUpdate();
      }
      return;
    }

    _updater.latestVersion = _updater.currentVersion;
    _updater.notes = data.notes || "";
    _updater.status = "up_to_date";
    renderUpdaterUi();
  } catch (e) {
    console.warn("[Cutline Studio] Update check failed:", e);
    _updater.status = manual ? "error" : "idle";
    _updater.notes = manual ? "Couldn't check GitHub Pages for updates." : "";
    renderUpdaterUi();
  }
}

function initUpdater() {
  if (isAndroidApk && typeof window.CutlineAndroid.getInstalledVersion === "function") {
    _updater.currentVersion = window.CutlineAndroid.getInstalledVersion() || APP_VERSION;
  }

  try {
    const justUpdated = sessionStorage.getItem("cutline:justUpdated");
    if (justUpdated) {
      sessionStorage.removeItem("cutline:justUpdated");
      showToast(`Updated to Cutline Studio v${String(justUpdated).replace(/^v/i, "")}`);
    }
  } catch (_) {}

  els.toastBtn.addEventListener("click", () => {
    const fn = _toastAction;
    els.toast.hidden = true;
    _toastAction = null;
    fn?.();
  });

  els.btnVersion.addEventListener("click", () => {
    renderUpdaterUi();
    if (!els.updateDlg.open) {
      els.updateDlg.showModal();
      els.btnCheckUpdates.focus();
    }
    if (!isWordAddin && (_updater.status === "idle" || _updater.status === "up_to_date" || _updater.status === "error")) {
      checkForUpdates(true);
    }
  });
  els.btnUpdateDlgClose.addEventListener("click", () => {
    if (els.updateDlg.open) els.updateDlg.close();
  });
  els.updateDlg.addEventListener("click", (e) => {
    if (e.target === els.updateDlg) els.updateDlg.close();
  });
  els.btnCheckUpdates.addEventListener("click", () => checkForUpdates(true));
  els.btnApplyUpdate.addEventListener("click", applyAvailableUpdate);
  els.btnUpdateAction.addEventListener("click", applyAvailableUpdate);
  els.btnDismissUpdate.addEventListener("click", () => {
    _updater.bannerDismissedVersion = _updater.latestVersion;
    renderUpdaterUi();
  });
  els.ctlAutoUpdate.addEventListener("change", () => {
    setAutoUpdateEnabled(els.ctlAutoUpdate.checked);
    renderUpdaterUi();
  });

  if (isAndroidApk) {
    window.__cutlineOnUpdateState = (payload) => {
      try {
        const data = typeof payload === "string" ? JSON.parse(payload) : payload;
        if (!data) return;
        if (data.currentVersion) _updater.currentVersion = data.currentVersion;
        if (data.status) _updater.status = data.status;
        if (data.latestVersion !== undefined) _updater.latestVersion = data.latestVersion;
        if (data.notes !== undefined) _updater.notes = data.notes || "";
        if (data.progress !== undefined) _updater.progress = data.progress;
        if (data.status === "available" || data.status === "ready") {
          _updater.bannerDismissedVersion = null;
        }
        renderUpdaterUi();
      } catch (e) {
        console.warn("[Cutline Studio] Bad update state payload:", e);
      }
    };
    renderUpdaterUi();
    setTimeout(() => checkForUpdates(false), 1200);
    return;
  }

  if (!isWordAddin && !window.Office && "serviceWorker" in navigator) {
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      if (isAutoUpdateEnabled() && state.images.length === 0 && !_exporting) {
        reloading = true;
        try { sessionStorage.setItem("cutline:justUpdated", _updater.latestVersion || ""); } catch (_) {}
        window.location.reload();
      } else {
        _updater.status = "ready";
        _updater.bannerDismissedVersion = null;
        renderUpdaterUi();
      }
    });

    navigator.serviceWorker.register("service-worker.js").then((reg) => {
      _updater.swReg = reg;
      reg.addEventListener("updatefound", () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          if (installing.state === "installed" && navigator.serviceWorker.controller) {
            _updater.status = "ready";
            _updater.bannerDismissedVersion = null;
            renderUpdaterUi();
          }
        });
      });
      checkForUpdates(false);
    }).catch((e) => console.warn("[Cutline Studio] SW registration failed:", e));

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") checkForUpdates(false);
    });
    window.addEventListener("online", () => checkForUpdates(false));
    setInterval(() => checkForUpdates(false), 30 * 60 * 1000);
  }

  renderUpdaterUi();
}

function initAndroidBackHandler() {
  window.__cutlineOnBackPressed = () => {
    if (els.updateDlg?.open) { els.updateDlg.close(); return true; }
    if (els.dlg?.open) { closeDialog(false); return true; }
    if (!els.exportCard.hidden) { closeExportCard(); return true; }
    if (!els.contextMenu.hidden) { hideContextMenu(); return true; }
    const isCompactViewport = window.innerWidth <= 760 || (window.innerWidth <= 1320 && window.innerHeight > window.innerWidth);
    if (isCompactViewport && state.panelOpen) {
      setActivePanel(state.activePanel, false);
      return true;
    }
    return false;
  };
}

// ─── Settings → controls ──────────────────────────────────────────────────

function setRadio(name, value) {
  for (const input of document.querySelectorAll(`input[type="radio"][name="${name}"]`)) {
    input.checked = input.value === value;
  }
}

function syncControlsFromState() {
  const s = state.settings;
  els.ctlRows.value = s.rows;
  els.ctlCols.value = s.cols;
  els.ctlCellCm.value = s.cellSizeCm;
  els.ctlCellCmNum.value = s.cellSizeCm;
  els.ctlPage.value = s.pageSize;
  els.ctlMargin.value = s.marginMm;
  els.ctlMarginNum.value = s.marginMm;
  els.ctlSpacing.value = s.spacingMm;
  els.ctlSpacingNum.value = s.spacingMm;
  els.ctlTrim.checked = s.trimEmptyRows;
  els.ctlSquareCrop.checked = s.squareCrop;

  els.ctlBorders.checked = s.borderEnabled;
  setRadio("borderStyle", s.borderStyle);
  syncSwatches(els.borderSwatches, "borderColor", s.borderColor);
  els.borderOptions.classList.toggle("is-off", !s.borderEnabled);
  renderBorderSamples();

  for (const t of document.querySelectorAll("[data-footer-toggle]")) t.checked = s.footerEnabled;
  setRadio("footerFont", s.footerFont);
  els.ctlFooterSize.value = s.footerSizePt;
  els.ctlFooterSizeNum.value = s.footerSizePt;
  els.btnFooterBold.setAttribute("aria-pressed", String(s.footerBold));
  els.btnFooterItalic.setAttribute("aria-pressed", String(s.footerItalic));
  setRadio("footerAlign", s.footerAlign);
  syncSwatches(els.footerSwatches, "footerColor", s.footerColor);

  els.ctlCompress.checked = s.compressImages;
  setRadio("quality", s.outputQuality);
  setRadio("exportFormat", s.exportFormat);
  els.qualityChips.classList.add("options-block");
  els.qualityChips.classList.toggle("is-off", !s.compressImages);
  for (const q of els.qualityChips.querySelectorAll("input")) q.disabled = !s.compressImages;
  els.compressOffNote.hidden = s.compressImages;
  els.btnExportGo.textContent = FILE_TYPES[s.exportFormat].button;

  for (const r of document.querySelectorAll('input[type="range"]')) updateRangeFill(r);
}

// ─── Event wiring ─────────────────────────────────────────────────────────

/** Keep a slider and its number box in step. */
function bindRangeNumber(range, num, { min, max, parse = parseFloat, onChange }) {
  const apply = (raw, from) => {
    let v = parse(raw);
    if (!Number.isFinite(v)) return;
    v = clamp(v, min, max);
    if (from !== range) range.value = v;
    if (from !== num) num.value = v;
    updateRangeFill(range);
    onChange(v);
  };
  range.addEventListener("input", () => apply(range.value, range));
  num.addEventListener("input", () => { if (num.value !== "") apply(num.value, num); });
  num.addEventListener("change", () => apply(num.value === "" ? range.value : num.value, null));
}

function invalidateExportCache() {
  for (const im of state.images) im.exportCache = null;
}

function attachEventListeners() {
  // Rail + panel close buttons
  for (const b of els.railBtns) {
    b.addEventListener("click", () => {
      const name = b.dataset.panel;
      if (state.panelOpen && state.activePanel === name) setActivePanel(name, false);
      else setActivePanel(name, true);
    });
  }
  for (const b of document.querySelectorAll("[data-close-panel]")) {
    b.addEventListener("click", () => setActivePanel(state.activePanel, false));
  }

  // Layout
  const intInput = (input, key) => input.addEventListener("input", () => {
    const v = parseInt(input.value, 10);
    if (!Number.isFinite(v)) return;
    state.settings[key] = clamp(v, 1, 30);
    render();
  });
  intInput(els.ctlRows, "rows");
  intInput(els.ctlCols, "cols");
  for (const input of [els.ctlRows, els.ctlCols]) {
    input.addEventListener("change", () => { syncControlsFromState(); });
  }
  bindRangeNumber(els.ctlCellCm, els.ctlCellCmNum, {
    min: 1, max: 20,
    onChange: (v) => { state.settings.cellSizeCm = Math.round(v * 10) / 10; invalidateExportCache(); render(); },
  });
  els.ctlPage.addEventListener("change", () => { state.settings.pageSize = els.ctlPage.value; render(); });
  bindRangeNumber(els.ctlMargin, els.ctlMarginNum, {
    min: 0, max: 40, parse: (x) => Math.round(parseFloat(x)),
    onChange: (v) => { state.settings.marginMm = v; render(); },
  });
  bindRangeNumber(els.ctlSpacing, els.ctlSpacingNum, {
    min: 0, max: 20, parse: (x) => Math.round(parseFloat(x)),
    onChange: (v) => { state.settings.spacingMm = v; render(); },
  });
  els.ctlTrim.addEventListener("change", () => { state.settings.trimEmptyRows = els.ctlTrim.checked; render(); });
  els.ctlSquareCrop.addEventListener("change", () => {
    state.settings.squareCrop = els.ctlSquareCrop.checked;
    invalidateExportCache();
    render();
  });

  // Orientation (Layout panel and toolbar share the same state)
  for (const input of document.querySelectorAll("[data-orient]")) {
    input.addEventListener("change", () => { if (input.checked) setOrientation(input.value); });
  }
  for (const cb of document.querySelectorAll("[data-orient-all]")) {
    cb.addEventListener("change", () => {
      state.settings.orientationAllPages = cb.checked;
      render();
    });
  }

  // Borders
  els.ctlBorders.addEventListener("change", () => {
    state.settings.borderEnabled = els.ctlBorders.checked;
    syncControlsFromState();
    render();
  });
  els.borderStyleList.addEventListener("change", (e) => {
    if (e.target.name !== "borderStyle") return;
    state.settings.borderStyle = e.target.value;
    state.settings.borderEnabled = true;
    syncControlsFromState();
    render();
  });

  // Footer
  for (const t of document.querySelectorAll("[data-footer-toggle]")) {
    t.addEventListener("change", () => {
      state.settings.footerEnabled = t.checked;
      syncControlsFromState();
      render();
    });
  }
  for (const r of document.querySelectorAll('input[name="footerFont"]')) {
    r.addEventListener("change", () => { if (r.checked) { state.settings.footerFont = r.value; render(); } });
  }
  bindRangeNumber(els.ctlFooterSize, els.ctlFooterSizeNum, {
    min: FOOTER_SIZE_MIN, max: FOOTER_SIZE_MAX, parse: (x) => Math.round(parseFloat(x) * 2) / 2,
    onChange: (v) => { state.settings.footerSizePt = v; render(); },
  });
  els.btnFooterBold.addEventListener("click", () => {
    state.settings.footerBold = !state.settings.footerBold;
    syncControlsFromState();
    render();
  });
  els.btnFooterItalic.addEventListener("click", () => {
    state.settings.footerItalic = !state.settings.footerItalic;
    syncControlsFromState();
    render();
  });
  for (const r of document.querySelectorAll('input[name="footerAlign"]')) {
    r.addEventListener("change", () => { if (r.checked) { state.settings.footerAlign = r.value; render(); } });
  }

  // Export card
  els.btnExportOpen.addEventListener("click", () => {
    if (els.exportCard.hidden) openExportCard(); else closeExportCard();
  });
  els.btnExportClose.addEventListener("click", closeExportCard);
  document.addEventListener("pointerdown", (e) => {
    if (els.exportCard.hidden) return;
    if (els.exportCard.contains(e.target) || els.btnExportOpen.contains(e.target)) return;
    closeExportCard();
  });
  for (const r of document.querySelectorAll('input[name="exportFormat"]')) {
    r.addEventListener("change", () => {
      if (!r.checked) return;
      state.settings.exportFormat = r.value;
      syncControlsFromState();
    });
  }
  els.ctlCompress.addEventListener("change", () => {
    state.settings.compressImages = els.ctlCompress.checked;
    syncControlsFromState();
  });
  for (const r of document.querySelectorAll('input[name="quality"]')) {
    r.addEventListener("change", () => {
      if (r.checked) state.settings.outputQuality = r.value;
    });
  }
  els.btnEditFooter.addEventListener("click", () => {
    closeExportCard();
    openPanel("footer");
  });
  els.btnExportGo.addEventListener("click", () => exportDocument(state.settings.exportFormat));

  // Photos
  els.btnAdd.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", (e) => {
    if (e.target.files?.length) ingestFiles(e.target.files);
    e.target.value = ""; // allow re-selecting the same files
  });
  els.btnUp.addEventListener("click", () => shiftSelection(-1));
  els.btnDown.addEventListener("click", () => shiftSelection(+1));
  els.btnRemove.addEventListener("click", () => removeSelected());
  els.btnClear.addEventListener("click", clearAll);

  // Toolbar
  els.ctxCrop.addEventListener("click", () => openPanel("crop"));
  els.ctxUp.addEventListener("click", () => shiftSelection(-1));
  els.ctxDown.addEventListener("click", () => shiftSelection(+1));
  els.ctxRemove.addEventListener("click", () => removeSelected());

  // Bottom bar
  els.btnPagePrev.addEventListener("click", () => selectPage(state.selectedPage - 1, { scroll: true }));
  els.btnPageNext.addEventListener("click", () => selectPage(state.selectedPage + 1, { scroll: true }));
  els.ctlViewZoom.addEventListener("input", () => setViewZoom(parseFloat(els.ctlViewZoom.value) / 100));
  els.btnFit.addEventListener("click", () => setViewZoom(null));

  // Slider fill for any range input
  document.addEventListener("input", (e) => {
    if (e.target.type === "range") updateRangeFill(e.target);
  });

  // Drag and drop — anywhere in the window
  ["dragenter", "dragover"].forEach((evt) =>
    window.addEventListener(evt, (e) => {
      if (hasFiles(e.dataTransfer)) {
        e.preventDefault();
        els.dropOverlay.hidden = false;
      }
    }));
  ["dragleave", "drop"].forEach((evt) =>
    window.addEventListener(evt, (e) => {
      if (evt === "dragleave" && e.relatedTarget) return;
      els.dropOverlay.hidden = true;
    }));
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) ingestFiles(e.dataTransfer.files);
  });

  window.addEventListener("keydown", onKeyDown);
}

// ─── Border style picker and colour swatches ──────────────────────────────

function buildBorderStylePicker() {
  const frag = document.createDocumentFragment();
  for (const s of Borders.STYLES) {
    const label = el("label", "chip");
    label.title = s.label;
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "borderStyle";
    input.value = s.id;
    const face = el("span");
    const sample = el("span", "style-sample");
    sample.dataset.style = s.id;
    face.append(sample, el("small", null, s.label));
    label.append(input, face);
    frag.appendChild(label);
  }
  els.borderStyleList.replaceChildren(frag);
}

function renderBorderSamples() {
  const color = state.settings.borderColor;
  // Very light colours are hard to see on the white chips — show them a little darker.
  const { r, g, b } = Borders.hexToRgb(color);
  const light = (0.299 * r + 0.587 * g + 0.114 * b) > 200;
  const sampleColor = light ? "#9AA0A8" : color;
  for (const node of els.borderStyleList.querySelectorAll(".style-sample")) {
    const key = `${node.dataset.style}|${sampleColor}`;
    if (node.dataset.key === key) continue;
    node.dataset.key = key;
    node.innerHTML = Borders.sampleSvg(node.dataset.style, sampleColor, 112, 24);
  }
}

function buildSwatches(container, name, onPick) {
  const frag = document.createDocumentFragment();
  for (const c of COLOR_SWATCHES) {
    const label = el("label", "swatch");
    label.title = c.name;
    const input = document.createElement("input");
    input.type = "radio";
    input.name = name;
    input.value = c.hex;
    input.setAttribute("aria-label", c.name);
    const dot = el("span");
    dot.style.setProperty("--c", c.hex);
    label.append(input, dot);
    frag.appendChild(label);
  }
  const custom = el("label", "swatch swatch-custom");
  custom.title = "Custom colour";
  const picker = document.createElement("input");
  picker.type = "color";
  picker.setAttribute("aria-label", "Custom colour");
  custom.append(picker, el("span"));
  frag.appendChild(custom);
  container.replaceChildren(frag);

  container.addEventListener("change", (e) => {
    if (e.target.name === name && e.target.checked) onPick(e.target.value.toUpperCase());
  });
  let raf = 0;
  picker.addEventListener("input", () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => onPick(picker.value.toUpperCase()));
  });
}

function syncSwatches(container, name, color) {
  const c = Borders.normaliseColor(color);
  let matched = false;
  for (const input of container.querySelectorAll(`input[name="${name}"]`)) {
    input.checked = input.value.toUpperCase() === c;
    matched = matched || input.checked;
  }
  const custom = container.querySelector(".swatch-custom");
  if (!custom) return;
  custom.classList.toggle("is-selected", !matched);
  custom.querySelector("span").style.setProperty("--c", matched ? "#ffffff" : c);
  custom.querySelector('input[type="color"]').value = c.toLowerCase();
}

// ─── Export card ──────────────────────────────────────────────────────────

function openExportCard() {
  hideContextMenu();
  syncControlsFromState();
  renderExportSummary();
  els.exportCard.hidden = false;
  els.btnExportOpen.setAttribute("aria-expanded", "true");
  els.btnExportGo.focus();
}

function closeExportCard() {
  if (els.exportCard.hidden) return;
  els.exportCard.hidden = true;
  els.btnExportOpen.setAttribute("aria-expanded", "false");
}

function renderExportSummary(pages = currentPages()) {
  const n = state.images.filter((im) => !im.error).length;
  const s = state.settings;
  els.exportSummary.textContent = n
    ? `${plural(n, "photo")} · ${plural(pages.length, "page")} · ${s.pageSize}`
    : "Add photos to export them.";
  els.btnExportGo.disabled = n === 0;
}

// ─── File ingestion ───────────────────────────────────────────────────────

async function ingestFiles(fileList) {
  const files = Array.from(fileList).filter((f) => {
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    return SUPPORTED_EXT.has(ext) || f.type.startsWith("image/");
  });
  if (!files.length) {
    setStatus("No supported image files in that drop.");
    showToast("No supported image files in that drop.");
    return;
  }

  // Show placeholders straight away; each is filled in as it decodes.
  const placeholders = files.map((f) => ({
    id: nextId(), file: f, name: f.name,
    loading: true,
    sourceBlob: null, previewUrl: null,
    w: 0, h: 0,
    cropAnchor: { x: 0.5, y: 0.5 },
    cropZoom: 1,
    exportCache: null,
  }));
  state.images.push(...placeholders);
  if (!state.selectedId && state.images.length) {
    const first = state.images.find((i) => i.loading) || state.images[0];
    state.selectedId = first.id;
    state.selectedPage = pageIndexOfImageId(first.id);
  }
  render();

  setStatus(`Loading ${plural(files.length, "photo")}…`);

  let done = 0;
  await Promise.all(placeholders.map(async (ph) => {
    try {
      const data = await loadImage(ph.file);
      Object.assign(ph, data);
    } catch (e) {
      console.error("Failed to load", ph.file?.name, e);
      ph.error = e.message || String(e);
    }
    ph.loading = false;
    done++;
    setStatus(`Loaded ${done}/${files.length}…`);
    patchListItem(ph);
    schedulePreviewRedraw();
  }));

  const failed = placeholders.filter((p) => p.error).length;
  setStatus(`${plural(state.images.length, "photo")} loaded.` + (failed ? ` ${failed} couldn't be read.` : ""));
  render();
}

/** Update one list item in place while a batch loads. */
function patchListItem(image) {
  const li = els.fileList.querySelector(`li[data-id="${CSS.escape(image.id)}"]`);
  if (!li) return;
  li.classList.toggle("loading", !!image.loading);
  li.classList.toggle("failed", !!image.error);
  if (image.previewUrl) {
    const thumb = li.querySelector(".thumb");
    if (thumb && thumb.dataset.url !== image.previewUrl) {
      thumb.style.backgroundImage = `url("${image.previewUrl}")`;
      thumb.dataset.url = image.previewUrl;
    }
  }
  const name = li.querySelector(".name");
  if (name) name.textContent = listLabel(image);
}

function listLabel(image) {
  return image.name + (image.error ? "  (couldn't load)" : image.loading ? "  (loading…)" : "");
}

// ─── Worker pool ──────────────────────────────────────────────────────────

let _workers = null;
let _workerRR = 0;
const _workerPending = new Map();
let _workerSeq = 0;

function getWorkerPool() {
  if (_workers) return _workers;
  _workers = [];
  for (let i = 0; i < WORKER_POOL_SIZE; i++) {
    let worker;
    try {
      worker = new Worker("image-worker.js");
    } catch (e) {
      console.warn("Worker construction failed:", e);
      break;
    }
    worker.onmessage = (e) => {
      const { id, error, ...rest } = e.data || {};
      const pending = _workerPending.get(id);
      if (!pending) return;
      _workerPending.delete(id);
      if (error) pending.reject(new Error(error));
      else pending.resolve(rest);
    };
    worker.onerror = (e) => console.error("Worker error:", e);
    _workers.push(worker);
  }
  return _workers;
}

/**
 * Decode a photo and make its thumbnail.
 *
 * The browser's own decoder (createImageBitmap on the main thread) is tried
 * first: it's fastest and handles HEIC on Safari and Chrome-on-Mac through
 * the system codec, which web workers can't reach. HEIC files the OS can't
 * decode go to a worker that uses libheif (WASM).
 */
async function loadImage(file) {
  try {
    const t0 = performance.now();
    const bitmap = await createImageBitmap(file);
    const thumbBlob = await makeThumbnailBlob(bitmap, THUMB_MAX_PX, THUMB_JPEG_Q);
    const w = bitmap.width;
    const h = bitmap.height;
    bitmap.close?.();
    console.log(`[Cutline Studio] ${file.name}: native, ${Math.round(performance.now() - t0)}ms`);
    return { sourceBlob: file, previewUrl: URL.createObjectURL(thumbBlob), w, h };
  } catch (eNative) {
    console.log(`[Cutline Studio] ${file.name}: native decode failed (${eNative.message || eNative}), trying worker libheif`);
  }

  if (!looksHeicLike(file)) throw new Error(`Format not supported: ${file.name}`);
  const pool = getWorkerPool();
  if (!pool.length) throw new Error("HEIC needs Web Workers, but they're unavailable in this browser.");

  const worker = pool[_workerRR++ % pool.length];
  const id = ++_workerSeq;
  const result = await new Promise((resolve, reject) => {
    _workerPending.set(id, { resolve, reject });
    try {
      worker.postMessage({ id, file, thumbMax: THUMB_MAX_PX, thumbQ: THUMB_JPEG_Q });
    } catch (e) {
      _workerPending.delete(id);
      reject(e);
    }
  });
  if (result.decoder) console.log(`[Cutline Studio] ${file.name}: ${result.decoder}, ${result.took}ms`);
  return {
    sourceBlob: result.sourceBlob,
    previewUrl: URL.createObjectURL(result.thumbBlob),
    w: result.w,
    h: result.h,
  };
}

function looksHeicLike(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const heicExts = ["heic", "heif", "hif", "heics", "heifs"];
  const heicMimes = ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"];
  return heicExts.includes(ext) || heicMimes.includes(file.type || "");
}

// Coalesce preview redraws (bulk loading, window resizes).
let _previewRedrawTO = null;
function schedulePreviewRedraw() {
  if (_previewRedrawTO) return;
  _previewRedrawTO = setTimeout(() => {
    _previewRedrawTO = null;
    const pages = currentPages();
    renderPreview(pages);
    renderBottomBar(pages);
  }, 80);
}

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/** Free a canvas's memory straight away (matters on iOS). */
function releaseCanvas(c) {
  c.width = 0;
  c.height = 0;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Image encoding failed"))), type, quality);
  });
}

/** JPEG thumbnail from a decoded ImageBitmap or <img>. */
async function makeThumbnailBlob(src, maxDim, jpegQ) {
  const srcW = src.width ?? src.naturalWidth;
  const srcH = src.height ?? src.naturalHeight;
  const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, w, h);
  try {
    return await canvasToBlob(canvas, "image/jpeg", jpegQ);
  } finally {
    releaseCanvas(canvas);
  }
}

function loadHtmlImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("Image load failed"));
    img.src = src;
  });
}

// ─── Selection + ordering ─────────────────────────────────────────────────

function getSelectedImage() {
  return state.images.find((i) => i.id === state.selectedId) || null;
}

function selectedIndex() {
  return state.images.findIndex((i) => i.id === state.selectedId);
}

function pageIndexOfImageId(id) {
  const i = state.images.findIndex((im) => im.id === id);
  return i < 0 ? state.selectedPage : Layout.pageIndexOfImage(i, state.settings.rows, state.settings.cols);
}

function selectImageById(id, { scroll = false } = {}) {
  state.selectedId = id;
  state.selectedPage = pageIndexOfImageId(id);
  render();
  if (scroll) scrollSelectionIntoView();
}

function selectPage(index, { scroll = false, deselect = false } = {}) {
  const count = currentPages().length;
  state.selectedPage = clamp(index, 0, count - 1);
  if (deselect) state.selectedId = null;
  render();
  if (scroll) scrollPageIntoView(state.selectedPage);
}

function shiftSelection(delta) {
  const i = selectedIndex();
  if (i < 0) return;
  const j = i + delta;
  if (j < 0 || j >= state.images.length) return;
  [state.images[i], state.images[j]] = [state.images[j], state.images[i]];
  state.selectedPage = pageIndexOfImageId(state.selectedId);
  render();
  scrollSelectionIntoView();
}

function removeSelected() {
  const i = selectedIndex();
  if (i < 0) return;
  const [removed] = state.images.splice(i, 1);
  if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
  state.selectedId = state.images[i]?.id || state.images[i - 1]?.id || null;
  if (state.selectedId) state.selectedPage = pageIndexOfImageId(state.selectedId);
  render();
}

async function clearAll() {
  if (!state.images.length) return;
  const ok = await confirmDialog({
    title: "Clear all photos?",
    message: `This removes all ${plural(state.images.length, "photo")} from the grid. The files on your device aren't touched.`,
    okLabel: "Clear all",
    danger: true,
  });
  if (!ok) return;
  for (const im of state.images) {
    if (im.previewUrl) URL.revokeObjectURL(im.previewUrl);
  }
  state.images = [];
  state.selectedId = null;
  state.selectedPage = 0;
  state.pageOrientation = {};
  setStatus("All photos cleared.");
  render();
}

function onKeyDown(e) {
  if (els.dlg.open) return;
  if (e.key === "Escape") {
    if (!els.exportCard.hidden) { closeExportCard(); els.btnExportOpen.focus(); return; }
    hideContextMenu();
    return;
  }
  const t = e.target;
  const tag = (t.tagName || "").toLowerCase();
  if (tag === "select" || tag === "textarea") return;
  if (tag === "input" && !["checkbox", "button"].includes(t.type)) return;
  if (els.exportCard.contains(t)) return;
  if (!state.images.length) return;

  if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
    e.preventDefault();
    if ((e.ctrlKey || e.metaKey) && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      shiftSelection(e.key === "ArrowUp" ? -1 : +1);
      return;
    }
    const idx = selectedIndex();
    const cur = idx < 0 ? 0 : idx;
    const page = currentPages()[Layout.pageIndexOfImage(cur, state.settings.rows, state.settings.cols)];
    const cols = page ? page.cols : state.settings.cols;
    let next = cur;
    if (idx >= 0) {
      if (e.key === "ArrowLeft")  next = Math.max(0, cur - 1);
      if (e.key === "ArrowRight") next = Math.min(state.images.length - 1, cur + 1);
      if (e.key === "ArrowUp")    next = Math.max(0, cur - cols);
      if (e.key === "ArrowDown")  next = Math.min(state.images.length - 1, cur + cols);
    }
    selectImageById(state.images[next].id, { scroll: true });
    return;
  }
  if ((e.key === "Backspace" || e.key === "Delete") && state.selectedId) {
    e.preventDefault();
    removeSelected();
  }
}

function scrollPageIntoView(index) {
  const wrap = els.preview.querySelector(`.page-wrap[data-page="${index}"]`);
  wrap?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
}

function scrollSelectionIntoView() {
  if (!state.selectedId) return;
  const cell = els.preview.querySelector(`.cell[data-img-id="${CSS.escape(state.selectedId)}"]`);
  cell?.scrollIntoView({ block: "nearest", inline: "nearest" });
  const li = els.fileList.querySelector(`li[data-id="${CSS.escape(state.selectedId)}"]`);
  li?.scrollIntoView({ block: "nearest" });
}

// ─── Orientation ──────────────────────────────────────────────────────────

function orientationOfPage(index) {
  const o = state.pageOrientation[index];
  return o === "portrait" || o === "landscape" ? o : state.settings.orientation;
}

/**
 * Change orientation. `scope` is a page index, "all", or omitted — in which
 * case the "Apply to all pages" tick box decides (selected page vs all).
 */
function setOrientation(value, scope) {
  const v = value === "landscape" ? "landscape" : "portrait";
  const all = scope === "all" || (scope == null && state.settings.orientationAllPages);
  if (all) {
    state.settings.orientation = v;
    state.pageOrientation = {};
  } else {
    const i = typeof scope === "number" ? scope : state.selectedPage;
    if (v === state.settings.orientation) delete state.pageOrientation[i];
    else state.pageOrientation[i] = v;
  }
  render();
}

function rotatePage(index) {
  const next = orientationOfPage(index) === "landscape" ? "portrait" : "landscape";
  state.selectedPage = index;
  setOrientation(next, state.settings.orientationAllPages ? "all" : index);
}

function syncOrientationControls(pageCount) {
  const all = state.settings.orientationAllPages;
  let value;
  if (all) {
    const seen = new Set();
    for (let i = 0; i < pageCount; i++) seen.add(orientationOfPage(i));
    value = seen.size === 1 ? [...seen][0] : null; // null = pages differ
  } else {
    value = orientationOfPage(state.selectedPage);
  }
  for (const input of document.querySelectorAll("[data-orient]")) input.checked = input.value === value;
  for (const cb of document.querySelectorAll("[data-orient-all]")) cb.checked = all;
  const target = all ? (value ? "All pages" : "All pages · mixed") : `Page ${state.selectedPage + 1}`;
  for (const node of document.querySelectorAll("[data-orient-target]")) {
    node.textContent = target;
    node.classList.toggle("is-page", !all);
  }
  for (const node of document.querySelectorAll("[data-orient-ctx]")) {
    node.textContent = all ? "Orientation" : `Page ${state.selectedPage + 1}`;
    node.classList.toggle("is-page", !all);
  }
  for (const node of document.querySelectorAll("[data-orient-hint]")) {
    node.textContent = all
      ? "Untick to change only the selected page."
      : `Only page ${state.selectedPage + 1} changes. Click a page to select it.`;
  }
}

// ─── Page layout ──────────────────────────────────────────────────────────

function currentPages() {
  const s = state.settings;
  return Layout.computePages({
    imageCount: state.images.length,
    rows: s.rows,
    cols: s.cols,
    cellMm: s.cellSizeCm * 10,
    spacingMm: s.spacingMm,
    marginMm: s.marginMm,
    pageSize: s.pageSize,
    orientation: s.orientation,
    overrides: state.pageOrientation,
    trimEmptyRows: s.trimEmptyRows,
    footer: s.footerEnabled ? { fontPt: s.footerSizePt, align: s.footerAlign } : null,
  });
}

// ─── Footer text ──────────────────────────────────────────────────────────

function footerFontCss(sizePx) {
  const s = state.settings;
  const font = FOOTER_FONTS[s.footerFont] || FOOTER_FONTS.sans;
  return `${s.footerItalic ? "italic " : ""}${s.footerBold ? 700 : 400} ${sizePx}px ${font.css}`;
}

const _measureCtx = document.createElement("canvas").getContext("2d");

/** Footer size in pt, shrunk if the text would be wider than `maxWidthMm`. */
function fittedFooterPt(text, maxWidthMm) {
  const pt = state.settings.footerSizePt;
  _measureCtx.font = footerFontCss(100);
  const widthAt100 = _measureCtx.measureText(text).width;       // px at a 100 px font
  const widthMm = (widthAt100 / 100) * pt * Layout.PT_TO_MM;
  if (!widthMm || widthMm <= maxWidthMm) return pt;
  return Math.max(4, Math.floor((pt * maxWidthMm / widthMm) * 0.97 * 2) / 2);
}

function footerSpec(text) {
  const s = state.settings;
  return {
    text,
    font: FOOTER_FONTS[s.footerFont] || FOOTER_FONTS.sans,
    bold: s.footerBold,
    italic: s.footerItalic,
    color: Borders.normaliseColor(s.footerColor),
  };
}

// ─── Render ───────────────────────────────────────────────────────────────

function render() {
  const pages = currentPages();
  if (state.selectedPage >= pages.length) state.selectedPage = pages.length - 1;
  if (state.selectedPage < 0) state.selectedPage = 0;
  renderFileList();
  renderContextBar();
  renderPreview(pages);
  renderCropEditor();
  renderBottomBar(pages);
  syncOrientationControls(pages.length);
  renderFooterSample();
  renderExportSummary(pages);
  els.borderOptions.classList.toggle("is-off", !state.settings.borderEnabled);
}

function renderFileList() {
  const list = els.fileList;
  list.replaceChildren();
  state.images.forEach((img, i) => {
    const li = el("li");
    li.dataset.id = img.id;
    if (img.id === state.selectedId) li.classList.add("sel");
    if (img.loading) li.classList.add("loading");
    if (img.error) li.classList.add("failed");

    const idx = el("span", "idx", String(i + 1));
    const thumb = el("span", "thumb");
    if (img.previewUrl) {
      thumb.style.backgroundImage = `url("${img.previewUrl}")`;
      thumb.dataset.url = img.previewUrl;
    }
    const name = el("span", "name", listLabel(img));
    name.title = img.name;

    li.append(idx, thumb, name);
    li.addEventListener("click", () => selectImageById(img.id, { scroll: true }));
    list.appendChild(li);
  });
  const n = state.images.length;
  els.photoCount.textContent = String(n);
  els.photosEmpty.hidden = n > 0;
  list.hidden = n === 0;
}

function renderContextBar() {
  const im = getSelectedImage();
  const idx = selectedIndex();
  els.ctxPhoto.classList.toggle("is-empty", !im);
  els.ctxName.textContent = im ? im.name : "No photo selected";
  els.ctxName.title = im ? im.name : "";
  els.ctxThumb.style.backgroundImage = im?.previewUrl ? `url("${im.previewUrl}")` : "";
  const cantMoveUp = !im || idx <= 0;
  const cantMoveDown = !im || idx >= state.images.length - 1;
  els.ctxCrop.disabled = !im || !!im.error || !state.settings.squareCrop;
  els.ctxUp.disabled = cantMoveUp;
  els.ctxDown.disabled = cantMoveDown;
  els.ctxRemove.disabled = !im;
  els.btnUp.disabled = cantMoveUp;
  els.btnDown.disabled = cantMoveDown;
  els.btnRemove.disabled = !im;
  els.btnClear.disabled = state.images.length === 0;
}

let _lastScale = PX_PER_MM;

function renderPreview(pages = currentPages()) {
  const stack = els.preview;
  const scroller = els.previewScroll;
  const cs = getComputedStyle(scroller);
  const availW = scroller.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const availH = scroller.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - PAGE_HEAD_PX;
  if (availW < 40 || availH < 40) { stack.replaceChildren(); return; }

  let fit = Infinity;
  for (const p of pages) fit = Math.min(fit, availW / p.dims.w, availH / p.dims.h);
  const scale = state.viewZoom == null ? fit : state.viewZoom * PX_PER_MM;
  _lastScale = scale;

  const s = state.settings;
  const px = (mm) => `${mm * scale}px`;
  const frag = document.createDocumentFragment();

  for (const p of pages) {
    const wrap = el("div", "page-wrap");
    wrap.dataset.page = String(p.index);
    wrap.style.width = px(p.dims.w);
    if (p.index === state.selectedPage) wrap.classList.add("is-selected");
    if (!s.orientationAllPages && p.index === state.selectedPage) wrap.classList.add("is-target");

    // Header: "Page 2  Landscape · 20 photos"  [rotate]
    const head = el("div", "page-head");
    const grow = el("div", "grow");
    grow.append(
      el("span", "title", `Page ${p.index + 1}`),
      el("span", "meta", `${capitalise(p.orientation)} · ${plural(p.count, "photo")}`),
    );
    if (!p.fits) grow.append(el("span", "badge-warn", "Grid doesn't fit"));
    const rotate = iconButton("i-rotate", s.orientationAllPages ? "Rotate all pages" : `Rotate page ${p.index + 1}`);
    rotate.dataset.rotate = String(p.index);
    head.append(grow, rotate);

    const page = el("div", "page");
    page.style.width = px(p.dims.w);
    page.style.height = px(p.dims.h);
    if (s.borderEnabled) page.classList.add("has-borders");

    const guide = el("div", "margin-guide");
    guide.style.left = px(p.margins.left);
    guide.style.top = px(p.margins.top);
    guide.style.width = px(p.dims.w - p.margins.left - p.margins.right);
    guide.style.height = px(p.dims.h - p.margins.top - p.margins.bottom);
    page.appendChild(guide);

    let selCell = null;
    for (const c of p.cells) {
      const cell = el("div", "cell");
      cell.style.left = px(c.x);
      cell.style.top = px(c.y);
      cell.style.width = px(c.w);
      cell.style.height = px(c.h);
      if (c.imageIndex != null) {
        const im = state.images[c.imageIndex];
        cell.classList.add("filled");
        cell.dataset.imgId = im.id;
        if (im.id === state.selectedId) selCell = c;
        if (im.error) {
          const err = el("div", "err");
          err.append(el("strong", null, "⚠"), el("small", null, im.name));
          cell.appendChild(err);
        } else if (!im.previewUrl) {
          cell.classList.add("loading");
        } else {
          const img = el("div", "img");
          img.dataset.imgId = im.id;
          img.style.backgroundImage = `url("${im.previewUrl}")`;
          if (s.squareCrop) {
            applyCropStyle(img, im);
          } else {
            img.style.backgroundSize = "contain";
            img.style.backgroundPosition = "center";
          }
          cell.appendChild(img);
        }
      }
      page.appendChild(cell);
    }

    if (s.borderEnabled) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "border-layer");
      svg.setAttribute("aria-hidden", "true");
      svg.innerHTML = Borders.svgMarkup(p.cells, s.borderStyle, s.borderColor, scale, 1);
      page.appendChild(svg);
    }

    if (selCell) {
      const frame = el("div", "sel-frame");
      frame.appendChild(document.createElement("i"));
      frame.style.left = `${selCell.x * scale - 1}px`;
      frame.style.top = `${selCell.y * scale - 1}px`;
      frame.style.width = `${selCell.w * scale + 2}px`;
      frame.style.height = `${selCell.h * scale + 2}px`;
      page.appendChild(frame);
    }

    if (p.footer) {
      const text = state.lastFileName || FOOTER_PLACEHOLDER;
      const f = p.footer;
      const node = el("div", "page-footer" + (state.lastFileName ? "" : " is-placeholder"), text);
      node.title = state.lastFileName
        ? "Footer — shows the name you save the file as. Click to change its style."
        : "The name you save the file as goes here. Click to change the footer style.";
      const pt = fittedFooterPt(text, f.maxWidth);
      node.style.font = footerFontCss(pt * Layout.PT_TO_MM * scale);
      node.style.lineHeight = "1.15";
      node.style.color = s.footerColor;
      node.style.top = px(f.y);
      node.style.maxWidth = px(f.maxWidth);
      if (f.align === "left") {
        node.style.left = px(f.side);
      } else if (f.align === "right") {
        node.style.right = px(f.side);
      } else {
        node.style.left = "50%";
        node.style.transform = "translate(-50%, -50%)";
      }
      page.appendChild(node);
    }

    wrap.append(head, page);
    frag.appendChild(wrap);
  }
  stack.replaceChildren(frag);
}

function renderBottomBar(pages = currentPages()) {
  els.pagerLabel.textContent = `Page ${state.selectedPage + 1} of ${pages.length}`;
  els.btnPagePrev.disabled = state.selectedPage <= 0;
  els.btnPageNext.disabled = state.selectedPage >= pages.length - 1;

  const bad = pages.filter((p) => !p.fits);
  els.fitWarning.hidden = bad.length === 0;
  if (bad.length) {
    els.fitWarningText.textContent = bad.length === pages.length
      ? "The grid is bigger than the page — reduce rows, columns, cell size or margins."
      : `The grid doesn't fit on ${bad.length === 1 ? "page" : "pages"} ${bad.map((p) => p.index + 1).join(", ")}.`;
    els.fitWarning.title = els.fitWarningText.textContent;
  }

  const pct = Math.round((_lastScale / PX_PER_MM) * 100);
  els.ctlViewZoom.value = String(clamp(pct, VIEW_ZOOM_MIN * 100, VIEW_ZOOM_MAX * 100));
  els.outViewZoom.textContent = `${pct}%`;
  els.btnFit.disabled = state.viewZoom == null;
  updateRangeFill(els.ctlViewZoom);
}

function renderFooterSample() {
  const s = state.settings;
  const span = els.footerSample.firstElementChild;
  span.textContent = state.lastFileName || FOOTER_PLACEHOLDER;
  span.style.font = footerFontCss(Math.min(s.footerSizePt * (96 / 72), 36));
  span.style.lineHeight = "1.15";
  span.style.color = s.footerColor;
  els.footerSample.style.justifyContent =
    s.footerAlign === "left" ? "flex-start" : s.footerAlign === "right" ? "flex-end" : "center";
  els.footerSample.classList.toggle("is-placeholder", !state.lastFileName);
  els.footerOptions.classList.toggle("is-off", !s.footerEnabled);
}

// ─── Canvas interactions ──────────────────────────────────────────────────

function setViewZoom(z) {
  const sc = els.previewScroll;
  const cx = sc.scrollWidth ? (sc.scrollLeft + sc.clientWidth / 2) / sc.scrollWidth : 0.5;
  const cy = sc.scrollHeight ? (sc.scrollTop + sc.clientHeight / 2) / sc.scrollHeight : 0;
  state.viewZoom = z == null ? null : clamp(z, VIEW_ZOOM_MIN, VIEW_ZOOM_MAX);
  const pages = currentPages();
  renderPreview(pages);
  renderBottomBar(pages);
  sc.scrollLeft = cx * sc.scrollWidth - sc.clientWidth / 2;
  sc.scrollTop = cy * sc.scrollHeight - sc.clientHeight / 2;
}

function attachCanvasHandlers() {
  els.preview.addEventListener("click", (e) => {
    const rotate = e.target.closest("[data-rotate]");
    if (rotate) {
      rotatePage(parseInt(rotate.dataset.rotate, 10));
      return;
    }
    const wrap = e.target.closest(".page-wrap[data-page]");
    const pageIndex = wrap ? parseInt(wrap.dataset.page, 10) : null;
    if (e.target.closest(".page-footer")) {
      if (pageIndex != null) state.selectedPage = pageIndex;
      openPanel("footer");
      render();
      return;
    }
    const cell = e.target.closest(".cell.filled[data-img-id]");
    if (cell) {
      selectImageById(cell.dataset.imgId);
      return;
    }
    if (pageIndex != null) selectPage(pageIndex, { deselect: true });
  });

  // Ctrl/⌘ + wheel (and trackpad pinch) zooms the canvas.
  els.previewScroll.addEventListener("wheel", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const current = _lastScale / PX_PER_MM;
    setViewZoom(current * Math.exp(-e.deltaY * 0.0025));
  }, { passive: false });

  // Two-finger touch pinch-to-zoom on canvas (tablets & phones).
  let _canvasPinch = null;
  const touchDist = (t1, t2) => Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
  els.previewScroll.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2) {
      _canvasPinch = {
        dist: Math.max(10, touchDist(e.touches[0], e.touches[1])),
        zoom: _lastScale / PX_PER_MM,
      };
    } else {
      _canvasPinch = null;
    }
  }, { passive: true });
  els.previewScroll.addEventListener("touchmove", (e) => {
    if (!_canvasPinch || e.touches.length !== 2) return;
    e.preventDefault();
    const d = Math.max(10, touchDist(e.touches[0], e.touches[1]));
    setViewZoom(_canvasPinch.zoom * (d / _canvasPinch.dist));
  }, { passive: false });
  els.previewScroll.addEventListener("touchend", () => { _canvasPinch = null; });
  els.previewScroll.addEventListener("touchcancel", () => { _canvasPinch = null; });

  // Re-fit when the canvas changes size (window resize, panel opened/closed).
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => schedulePreviewRedraw()).observe(els.previewScroll);
  } else {
    window.addEventListener("resize", schedulePreviewRedraw);
  }
}

// ─── Crop editor (per-photo drag-to-pan + zoom) ───────────────────────────

function renderCropEditor() {
  const im = getSelectedImage();
  const cropOff = !state.settings.squareCrop;
  const usable = !!(im && im.previewUrl && !im.error && !cropOff);
  els.cropEditor.hidden = !usable;
  els.cropEmpty.hidden = usable;
  if (!usable) {
    els.cropEmptyText.textContent =
      cropOff ? "Cropping is off. Turn on “Crop photos to fill their cells” in Layout." :
      im?.error ? "This photo couldn't be loaded." :
      im ? "This photo is still loading…" :
      "Select a photo to crop it.";
    return;
  }
  els.cropName.textContent = im.name;
  els.cropName.title = im.name;
  const url = `url("${im.previewUrl}")`;
  if (els.cropImage.style.backgroundImage !== url) els.cropImage.style.backgroundImage = url;
  applyCropStyle(els.cropImage, im);

  const zoom = im.cropZoom || 1;
  els.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  els.ctlCropZoom.value = String(Math.round(zoom * 100));
  updateRangeFill(els.ctlCropZoom);
  els.btnZoomOut.disabled = zoom <= CROP_ZOOM_MIN + 1e-6;
  els.btnZoomIn.disabled = zoom >= CROP_ZOOM_MAX - 1e-6;
}

/**
 * Show a photo's crop with CSS background-size/position, so panning and
 * zooming update instantly without redrawing pixels. At zoom 1 the shorter
 * side of the photo fills the cell.
 */
function applyCropStyle(node, im) {
  const zoom = Math.max(CROP_ZOOM_MIN, im.cropZoom || 1);
  const ratio = (im.w || 1) / (im.h || 1);
  node.style.backgroundSize = ratio <= 1 ? `${zoom * 100}% auto` : `auto ${zoom * 100}%`;
  const ax = (im.cropAnchor?.x ?? 0.5) * 100;
  const ay = (im.cropAnchor?.y ?? 0.5) * 100;
  node.style.backgroundPosition = `${ax.toFixed(2)}% ${ay.toFixed(2)}%`;
}

function cropChanged(im) {
  im.exportCache = null;
  renderCropEditor();
  updatePreviewCellsFor(im);
}

function resetCrop(im) {
  if (!im) return;
  im.cropAnchor = { x: 0.5, y: 0.5 };
  im.cropZoom = 1;
  cropChanged(im);
}

let _drag = null;
function attachCropDragHandlers() {
  const frame = els.cropFrame;
  const pointers = new Map();
  let _pinch = null;

  const begin = (clientX, clientY) => {
    const im = getSelectedImage();
    if (!im || im.error || !im.previewUrl) return;
    _drag = {
      startX: clientX, startY: clientY,
      startAnchor: { ...im.cropAnchor },
      frame: frame.getBoundingClientRect(),
      imgW: im.w, imgH: im.h,
      zoom: Math.max(CROP_ZOOM_MIN, im.cropZoom || 1),
      id: im.id,
    };
  };
  const beginPinch = () => {
    if (pointers.size !== 2) return;
    const im = getSelectedImage();
    if (!im || im.error || !im.previewUrl) return;
    const pts = Array.from(pointers.values());
    _drag = null;
    _pinch = {
      dist: Math.max(10, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)),
      zoom: Math.max(CROP_ZOOM_MIN, im.cropZoom || 1),
    };
  };
  const move = (clientX, clientY) => {
    if (!_drag) return;
    const im = state.images.find((i) => i.id === _drag.id);
    if (!im) return;
    const dx = clientX - _drag.startX;
    const dy = clientY - _drag.startY;
    // At zoom z in a square frame of size F, the scaled photo overflows the
    // frame by (scaled − F) on each axis; background-position moves it by
    // that overflow at 100%.
    const W = _drag.imgW, H = _drag.imgH;
    const F = _drag.frame.width;
    const z = _drag.zoom;
    let overflowX, overflowY;
    if (W <= H) {
      overflowX = F * (z - 1);
      overflowY = F * (z * H / W - 1);
    } else {
      overflowX = F * (z * W / H - 1);
      overflowY = F * (z - 1);
    }
    const dax = overflowX > 0 ? -dx / overflowX : 0;
    const day = overflowY > 0 ? -dy / overflowY : 0;
    im.cropAnchor = {
      x: clamp(_drag.startAnchor.x + dax, 0, 1),
      y: clamp(_drag.startAnchor.y + day, 0, 1),
    };
    cropChanged(im);
  };
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    _pinch = null;
    if (pointers.size === 1) {
      const [pt] = pointers.values();
      begin(pt.x, pt.y);
    } else if (pointers.size === 0) {
      _drag = null;
    }
  };

  frame.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    try { frame.setPointerCapture?.(e.pointerId); } catch (_) {}
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) begin(e.clientX, e.clientY);
    else if (pointers.size === 2) beginPinch();
  });
  frame.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && _pinch) {
      const pts = Array.from(pointers.values());
      const dist = Math.max(10, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y));
      setCropZoom(_pinch.zoom * (dist / _pinch.dist));
    } else if (pointers.size === 1 && _drag) {
      move(e.clientX, e.clientY);
    }
  });
  frame.addEventListener("pointerup", endPointer);
  frame.addEventListener("pointercancel", endPointer);

  els.btnResetCrop.addEventListener("click", () => resetCrop(getSelectedImage()));
  els.btnZoomIn.addEventListener("click", () => adjustZoom(+CROP_ZOOM_STEP));
  els.btnZoomOut.addEventListener("click", () => adjustZoom(-CROP_ZOOM_STEP));
  els.ctlCropZoom.addEventListener("input", () => setCropZoom(parseFloat(els.ctlCropZoom.value) / 100));

  frame.addEventListener("wheel", (e) => {
    if (!getSelectedImage()) return;
    e.preventDefault();
    // Mouse wheels send ~100 per notch, trackpads much less: normalise.
    const dir = e.deltaY < 0 ? +1 : -1;
    const mag = Math.min(1, Math.abs(e.deltaY) / 60);
    adjustZoom(dir * CROP_ZOOM_STEP * mag);
  }, { passive: false });
}

function adjustZoom(delta) {
  const im = getSelectedImage();
  if (im) setCropZoom((im.cropZoom || 1) + delta);
}

function setCropZoom(z) {
  const im = getSelectedImage();
  if (!im) return;
  const next = clamp(z, CROP_ZOOM_MIN, CROP_ZOOM_MAX);
  if (Math.abs(next - (im.cropZoom || 1)) < 1e-6) return;
  im.cropZoom = next;
  cropChanged(im);
}

/** Live-update every preview cell that shows a given photo. */
function updatePreviewCellsFor(im) {
  if (!state.settings.squareCrop) return;
  els.preview.querySelectorAll(`.img[data-img-id="${CSS.escape(im.id)}"]`)
    .forEach((node) => applyCropStyle(node, im));
}

// ─── Export ───────────────────────────────────────────────────────────────
//
// Flow: ask where to save (and under what name) first, then build the file
// with that name in the footer, then write it.

let _exporting = false;

function libraryReady(kind) {
  return kind === "pdf"
    ? typeof window.jspdf?.jsPDF === "function"
    : typeof window.docx?.Document === "function";
}

function exportProfile() {
  const s = state.settings;
  return s.compressImages ? (QUALITY_PROFILES[s.outputQuality] || QUALITY_PROFILES.print) : FULL_RES_PROFILE;
}

function defaultBaseName() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `Cutline Studio-${stamp}`;
}

/** File name without extension, safe on Windows, macOS and Linux. */
function cleanBaseName(raw, ext) {
  let n = String(raw || "").replace(BAD_FILENAME_CHARS, " ").replace(/\s+/g, " ").trim();
  if (ext && n.toLowerCase().endsWith(ext)) n = n.slice(0, -ext.length).trim();
  return n.replace(/[. ]+$/, "").slice(0, 180);
}

function stripExtension(name, ext) {
  const n = String(name || "").trim();
  return ext && n.toLowerCase().endsWith(ext) ? n.slice(0, -ext.length).trim() : n;
}

/**
 * Ask where to save. Uses the browser's own Save dialog where there is one
 * (Chrome, Edge). Elsewhere (Safari, Firefox) asks for a name in the app and
 * downloads the file under that name.
 * Returns { name, fileName, handle } or null if cancelled.
 */
async function chooseSaveTarget(kind) {
  const type = FILE_TYPES[kind];
  const base = state.lastFileName || defaultBaseName();

  if (!isAndroidApk && typeof window.showSaveFilePicker === "function") {
    try {
      const handle = await window.showSaveFilePicker({
        id: "photogrid-export",
        startIn: "documents",
        suggestedName: base + type.ext,
        excludeAcceptAllOption: true,
        types: [{ description: type.description, accept: { [type.mime]: [type.ext] } }],
      });
      const name = stripExtension(handle.name, type.ext) || base;
      return { name, fileName: handle.name, handle, mime: type.mime };
    } catch (e) {
      if (e?.name === "AbortError") return null;
      console.warn("[Cutline Studio] Save dialog unavailable, asking for a name instead:", e);
    }
  }

  const result = await openDialog({
    title: `Save as ${type.label}`,
    message: state.settings.footerEnabled
      ? "This name is also printed in the footer of every page."
      : "",
    okLabel: "Save",
    input: {
      label: "File name",
      value: base,
      suffix: type.ext,
      validate: (v) => cleanBaseName(v, type.ext).length > 0,
    },
  });
  if (!result.ok) return null;
  const name = cleanBaseName(result.value, type.ext);
  if (!name) return null;
  return { name, fileName: name + type.ext, handle: null, mime: type.mime };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const str = String(reader.result || "");
      const idx = str.indexOf(",");
      resolve(idx >= 0 ? str.slice(idx + 1) : str);
    };
    reader.onerror = () => reject(reader.error || new Error("Failed to read file data"));
    reader.readAsDataURL(blob);
  });
}

async function writeOutput(target, blob) {
  if (isAndroidApk && typeof window.CutlineAndroid?.saveExportedFile === "function") {
    const base64 = await blobToBase64(blob);
    const raw = window.CutlineAndroid.saveExportedFile(base64, target.fileName, target.mime || blob.type || "application/octet-stream");
    const res = JSON.parse(raw);
    if (!res?.ok) throw new Error(res?.error || "Could not save file on Android");
    return res;
  }
  if (target.handle) {
    const writable = await target.handle.createWritable();
    try {
      await writable.write(blob);
      await writable.close();
    } catch (e) {
      try { await writable.abort?.(); } catch (_) {}
      throw e;
    }
    return null;
  }
  if (typeof window.saveAs === "function") {
    window.saveAs(blob, target.fileName);
    return null;
  }
  const url = URL.createObjectURL(blob);
  const a = el("a");
  a.href = url;
  a.download = target.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return null;
}

async function insertIntoWord(blob, footerText) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      
      if (isWordDialog) {
        // We are in the popup dialog. Save to IndexedDB and message parent.
        const req = indexedDB.open("CutlineStudioExchange", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("files");
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("files", "readwrite");
          tx.objectStore("files").put(base64, "latest");
          tx.oncomplete = () => {
            const msgFooter = footerText ? encodeURIComponent(footerText) : "";
            Office.context.ui.messageParent(`READY:latest:${msgFooter}`);
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      } else {
        // We are in the taskpane directly. Insert directly.
        Word.run(async (context) => {
          const body = context.document.body;
          body.load("text");
          await context.sync();
          
          if (body.text.trim() === "") {
            body.insertFileFromBase64(base64, Word.InsertLocation.replace);
          } else {
            body.insertBreak(Word.BreakType.page, Word.InsertLocation.end);
            body.insertFileFromBase64(base64, Word.InsertLocation.end);
          }
          
          if (footerText) {
            const sections = context.document.sections;
            sections.load("items");
            await context.sync();
            if (sections.items.length > 0) {
              const section = sections.items[sections.items.length - 1];
              const footer = section.getFooter(Word.HeaderFooterType.primary);
              const p = footer.insertParagraph(footerText, Word.InsertLocation.end);
              p.alignment = Word.Alignment.centered;
              p.font.color = "#777777";
              p.font.size = 10;
            }
          }
          
          await context.sync();
        }).then(resolve).catch(reject);
      }
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function exportDocument(kind) {
  closeExportCard();
  hideContextMenu();
  if (_exporting || !FILE_TYPES[kind]) return;

  if (!state.images.some((im) => !im.error)) {
    await alertDialog({ title: "Nothing to export yet", message: "Add some photos first." });
    return;
  }
  if (!libraryReady(kind)) {
    await alertDialog({
      title: "Export isn't available",
      message: `The ${kind === "pdf" ? "PDF" : "Word"} library didn't load. Check your connection and reload the page.`,
    });
    return;
  }
  const loading = state.images.filter((im) => im.loading).length;
  if (loading) {
    const ok = await confirmDialog({
      title: "Some photos are still loading",
      message: `${plural(loading, "photo")} will be left out of the file. Export anyway?`,
      okLabel: "Export anyway",
    });
    if (!ok) return;
  }

  let target = null;
  if (!isWordAddin) {
    target = await chooseSaveTarget(kind);
    if (!target) return;
  } else {
    let name = state.lastFileName || defaultBaseName();
    if (state.settings.footerEnabled) {
      const result = await openDialog({
        title: "Insert into Word",
        message: "This title will be printed in the footer of every page.",
        okLabel: "Insert",
        input: {
          label: "Footer title",
          value: name,
          validate: (v) => v.trim().length > 0,
        },
      });
      if (!result.ok) return;
      name = result.value.trim();
    }
    target = { name, fileName: name + ".docx", handle: null };
  }

  _exporting = true;
  showBusy("Preparing photos…");
  let error = null;
  try {
    const pages = currentPages();
    const footer = state.settings.footerEnabled ? footerSpec(target.name) : null;
    const { images, failed } = await prepareExportImages(exportProfile());
    setBusy(kind === "pdf" ? "Building PDF…" : "Building Word document…");
    const blob = kind === "pdf"
      ? await buildPdf(pages, images, footer)
      : await buildDocx(pages, images, footer);
    
    if (isWordAddin) {
      setBusy("Inserting into Word…");
      await insertIntoWord(blob, footer ? footer.text : null);
      state.lastFileName = target.name;
      let msg = `Inserted ${plural(pages.length, "page")} into document.`;
      if (failed) msg += ` ${plural(failed, "photo")} couldn't be added.`;
      setStatus(msg);
      showToast(msg);
    } else {
      setBusy("Saving…");
      const androidResult = await writeOutput(target, blob);
      state.lastFileName = target.name;
      let msg = androidResult?.path
        ? `Saved to ${androidResult.path} (${formatBytes(blob.size)}, ${plural(pages.length, "page")}).`
        : `Saved ${target.fileName} (${formatBytes(blob.size)}, ${plural(pages.length, "page")}).`;
      if (failed) msg += ` ${plural(failed, "photo")} couldn't be added.`;
      setStatus(msg);
      if (androidResult && typeof window.CutlineAndroid?.shareLastExport === "function") {
        showToast(msg, {
          ms: 7000,
          actionLabel: "Open / Share",
          onAction: () => window.CutlineAndroid.shareLastExport(),
        });
      } else {
        showToast(msg);
      }
    }
  } catch (e) {
    console.error(e);
    error = e;
  } finally {
    hideBusy();
    _exporting = false;
    render();
  }
  if (error) {
    await alertDialog({ title: "Export failed", message: error.message || String(error) });
  }
}

/** Render every photo for export, one at a time to keep memory low. */
async function prepareExportImages(profile) {
  const cellMm = state.settings.cellSizeCm * 10;
  const list = state.images.filter((im) => !im.error && !im.loading && im.sourceBlob);
  const images = new Map();
  let failed = 0;
  for (let i = 0; i < list.length; i++) {
    setBusy(`Preparing photos… ${i + 1} of ${list.length}`);
    try {
      images.set(list[i].id, await renderExportImage(list[i], profile, cellMm));
    } catch (e) {
      console.error("Export render failed for", list[i].name, e);
      failed++;
    }
    // Let the busy message repaint between photos.
    await new Promise((r) => setTimeout(r, 0));
  }
  return { images, failed };
}

function exportKey(im, profile, cellMm) {
  const a = im.cropAnchor || { x: 0.5, y: 0.5 };
  return [
    cellMm, state.settings.squareCrop ? "crop" : "fit",
    a.x.toFixed(4), a.y.toFixed(4), (im.cropZoom || 1).toFixed(3),
    profile.dpi, profile.jpeg,
  ].join("|");
}

/**
 * One photo as a JPEG ready for the document: only the part inside the crop,
 * at (at most) the profile's DPI for its printed size. Returns
 * { key, bytes, w, h }.
 */
async function renderExportImage(im, profile, cellMm) {
  const key = exportKey(im, profile, cellMm);
  if (im.exportCache && im.exportCache.key === key) return im.exportCache;

  const src = await decodeSource(im.sourceBlob);
  try {
    const W = src.width, H = src.height;
    const targetPx = profile.dpi ? Math.round((cellMm / 25.4) * profile.dpi) : Infinity;
    let sx = 0, sy = 0, sw = W, sh = H, outW, outH;
    if (state.settings.squareCrop) {
      const zoom = Math.max(CROP_ZOOM_MIN, im.cropZoom || 1);
      const side = Math.min(W, H) / zoom;
      sx = (W - side) * clamp(im.cropAnchor?.x ?? 0.5, 0, 1);
      sy = (H - side) * clamp(im.cropAnchor?.y ?? 0.5, 0, 1);
      sw = sh = side;
      outW = outH = Math.max(1, Math.round(Math.min(side, targetPx, MAX_EXPORT_EDGE_PX)));
    } else {
      const k = Math.min(1, targetPx / Math.max(W, H), MAX_EXPORT_EDGE_PX / Math.max(W, H));
      outW = Math.max(1, Math.round(W * k));
      outH = Math.max(1, Math.round(H * k));
    }
    const canvas = drawScaled(src.image, sx, sy, sw, sh, outW, outH);
    let blob;
    try {
      blob = await canvasToBlob(canvas, "image/jpeg", profile.jpeg);
    } finally {
      releaseCanvas(canvas);
    }
    const result = { key, bytes: new Uint8Array(await blob.arrayBuffer()), w: outW, h: outH };
    // Keep compressed renders for the next export; full-size ones are too big to hold.
    im.exportCache = profile.dpi ? result : null;
    return result;
  } finally {
    src.close();
  }
}

/** Decode a source image (EXIF orientation applied, same as the thumbnails). */
async function decodeSource(blob) {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(blob);
      return { image: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close?.() };
    } catch (_) { /* fall back to <img> */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadHtmlImage(url);
    return { image: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Draw a region of `src` at outW × outH on a white background. Large
 * reductions are done in halving steps, which avoids the jagged, aliased
 * result a single big drawImage gives in some browsers.
 */
function drawScaled(src, sx, sy, sw, sh, outW, outH) {
  let steps = 0;
  while (
    steps < 8 &&
    outW * 2 ** (steps + 1) <= sw &&
    outH * 2 ** (steps + 1) <= sh &&
    Math.max(outW, outH) * 2 ** (steps + 1) <= MAX_EXPORT_EDGE_PX
  ) steps++;
  let w = outW * 2 ** steps;
  let h = outH * 2 ** steps;
  let canvas = makeCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // JPEG has no transparency — use paper white
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
  while (steps-- > 0) {
    const nw = w / 2, nh = h / 2;
    const next = makeCanvas(nw, nh);
    const nctx = next.getContext("2d");
    nctx.imageSmoothingEnabled = true;
    nctx.imageSmoothingQuality = "high";
    nctx.drawImage(canvas, 0, 0, w, h, 0, 0, nw, nh);
    releaseCanvas(canvas);
    canvas = next;
    w = nw;
    h = nh;
  }
  return canvas;
}

/** Where an exported image sits inside its cell (mm). */
function imageBox(ex, cell) {
  if (state.settings.squareCrop) return { x: cell.x, y: cell.y, w: cell.w, h: cell.h };
  const k = Math.min(cell.w / ex.w, cell.h / ex.h);
  const w = ex.w * k, h = ex.h * k;
  return { x: cell.x + (cell.w - w) / 2, y: cell.y + (cell.h - h) / 2, w, h };
}

// ─── PDF ──────────────────────────────────────────────────────────────────

async function buildPdf(pages, images, footer) {
  const { jsPDF } = window.jspdf;
  const s = state.settings;
  const first = pages[0];
  const doc = new jsPDF({
    orientation: first.orientation,
    unit: "mm",
    format: [first.dims.w, first.dims.h],
    compress: true,
  });
  doc.setProperties({ title: footer?.text || "Cutline Studio", creator: "Cutline Studio" });

  pages.forEach((p, pi) => {
    if (pi > 0) doc.addPage([p.dims.w, p.dims.h], p.orientation);
    for (const c of p.cells) {
      if (c.imageIndex == null) continue;
      const im = state.images[c.imageIndex];
      const ex = im && images.get(im.id);
      if (!ex) continue;
      const box = imageBox(ex, c);
      doc.addImage(ex.bytes, "JPEG", box.x, box.y, box.w, box.h, `${im.id}|${ex.key}`, "NONE");
    }
    if (s.borderEnabled) Borders.drawPdf(doc, p.cells, s.borderStyle, s.borderColor);
    if (footer && p.footer) {
      const f = p.footer;
      const style = footer.bold && footer.italic ? "bolditalic" : footer.bold ? "bold" : footer.italic ? "italic" : "normal";
      const { r, g, b } = Borders.hexToRgb(footer.color);
      doc.setFont(footer.font.pdf, style);
      doc.setFontSize(fittedFooterPt(footer.text, f.maxWidth));
      doc.setTextColor(r, g, b);
      doc.text(footer.text, f.x, f.y, { align: f.align, baseline: "middle" });
    }
  });
  return doc.output("blob");
}

// ─── Word ─────────────────────────────────────────────────────────────────
//
// One section per page, so each page can have its own orientation. Each
// page is a fixed-layout table, centred like the preview, with narrow empty
// columns/rows for the gaps between photos.

async function buildDocx(pages, images, footer) {
  const D = window.docx;
  const s = state.settings;
  const tw = (mm) => Math.round((mm * 1440) / 25.4);  // mm → twips
  const px = (mm) => (mm * 96) / 25.4;                // mm → docx.js image units (96 dpi px)
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);

  const none = { style: D.BorderStyle.NONE, size: 0, color: "auto" };
  const noBorders = { top: none, bottom: none, left: none, right: none };
  const line = s.borderEnabled ? Borders.wordBorder(s.borderStyle, s.borderColor) : null;
  const cellBorders = line ? { top: line, bottom: line, left: line, right: line } : noBorders;
  const zero = { top: 0, bottom: 0, left: 0, right: 0 };
  const lineSpacing = { before: 0, after: 0, line: 240, lineRule: D.LineRuleType.AUTO };
  const emptyParagraph = () => new D.Paragraph({ children: [] });

  const sections = pages.map((p, pi) => {
    const cellMm = p.cellMm;
    const gap = p.spacingMm;
    const useGaps = gap >= 0.1;
    const colWidths = [];
    for (let c = 0; c < p.cols; c++) {
      colWidths.push(tw(cellMm));
      if (useGaps && c < p.cols - 1) colWidths.push(tw(gap));
    }
    const tableWidth = sum(colWidths);

    const rows = [];
    for (let r = 0; r < p.rows; r++) {
      const cells = [];
      for (let c = 0; c < p.cols; c++) {
        const slot = p.cells[r * p.cols + c];
        const im = slot && slot.imageIndex != null ? state.images[slot.imageIndex] : null;
        const ex = im ? images.get(im.id) : null;
        let children;
        if (ex) {
          const box = imageBox(ex, { x: 0, y: 0, w: cellMm, h: cellMm });
          children = [new D.Paragraph({
            alignment: D.AlignmentType.CENTER,
            spacing: lineSpacing,
            children: [new D.ImageRun({
              data: ex.bytes,
              transformation: { width: px(box.w), height: px(box.h) },
            })],
          })];
        } else {
          children = [emptyParagraph()];
        }
        cells.push(new D.TableCell({
          width: { size: tw(cellMm), type: D.WidthType.DXA },
          margins: zero,
          verticalAlign: D.VerticalAlign.CENTER,
          borders: cellBorders,
          children,
        }));
        if (useGaps && c < p.cols - 1) {
          cells.push(new D.TableCell({
            width: { size: tw(gap), type: D.WidthType.DXA },
            margins: zero,
            borders: noBorders,
            children: [emptyParagraph()],
          }));
        }
      }
      rows.push(new D.TableRow({
        height: { value: tw(cellMm), rule: D.HeightRule.EXACT },
        cantSplit: true,
        children: cells,
      }));
      if (useGaps && r < p.rows - 1) {
        rows.push(new D.TableRow({
          height: { value: tw(gap), rule: D.HeightRule.EXACT },
          cantSplit: true,
          children: [new D.TableCell({
            columnSpan: colWidths.length,
            width: { size: tableWidth, type: D.WidthType.DXA },
            margins: zero,
            borders: noBorders,
            children: [emptyParagraph()],
          })],
        }));
      }
    }

    const table = new D.Table({
      rows,
      columnWidths: colWidths,
      width: { size: tableWidth, type: D.WidthType.DXA },
      layout: D.TableLayoutType.FIXED,
      alignment: D.AlignmentType.CENTER,
      borders: D.TableBorders.NONE,
      margins: zero,
    });

    // Position the grid exactly as in the preview and PDF: an empty paragraph
    // of the right height above the table does the vertical centring (Word's
    // own "centre vertically" page setting is ignored by other word processors).
    const children = [];
    const offsetMm = p.block.y - p.margins.top;
    if (offsetMm >= 0.2) {
      children.push(new D.Paragraph({
        spacing: { before: 0, after: 0, line: tw(offsetMm), lineRule: D.LineRuleType.EXACT },
        children: [],
      }));
    }
    children.push(table);
    // Word needs a paragraph after a table at the very end of a document.
    if (pi === pages.length - 1) children.push(emptyParagraph());

    let footerDistance = 0;
    const sectionFooters = {};
    if (footer && p.footer) {
      const pt = fittedFooterPt(footer.text, p.footer.maxWidth);
      footerDistance = Math.max(0, p.footer.fromBottom - (pt * Layout.PT_TO_MM * 1.15) / 2);
      const indent = Math.max(0, p.footer.side - p.margins.left);
      sectionFooters.default = new D.Footer({
        children: [new D.Paragraph({
          alignment: { left: D.AlignmentType.LEFT, right: D.AlignmentType.RIGHT }[p.footer.align] || D.AlignmentType.CENTER,
          spacing: lineSpacing,
          indent: indent > 0 ? { left: tw(indent), right: tw(indent) } : undefined,
          children: [new D.TextRun({
            text: footer.text,
            font: footer.font.word,
            size: Math.max(2, Math.round(pt * 2)),
            color: footer.color.slice(1),
            bold: footer.bold,
            italics: footer.italic,
          })],
        })],
      });
    }

    return {
      properties: {
        page: {
          // docx.js swaps width/height itself for landscape, so pass the
          // portrait (short × long) size here.
          size: {
            width: tw(Math.min(p.dims.w, p.dims.h)),
            height: tw(Math.max(p.dims.w, p.dims.h)),
            orientation: p.orientation === "landscape" ? D.PageOrientation.LANDSCAPE : D.PageOrientation.PORTRAIT,
          },
          margin: {
            top: tw(p.margins.top),
            right: tw(p.margins.right),
            bottom: tw(p.margins.bottom),
            left: tw(p.margins.left),
            header: tw(Math.min(5, p.margins.top)),
            footer: tw(footerDistance),
            gutter: 0,
          },
        },
      },
      footers: sectionFooters,
      children,
    };
  });

  const doc = new D.Document({
    creator: "Cutline Studio",
    title: footer?.text || "Cutline Studio",
    // Empty paragraphs (between tables, in empty cells) are made 1 pt tall so
    // they never push a full grid onto an extra page.
    styles: {
      default: {
        document: {
          run: { size: 2 },
          paragraph: { spacing: { before: 0, after: 0, line: 20, lineRule: D.LineRuleType.EXACT } },
        },
      },
    },
    sections,
  });
  return D.Packer.toBlob(doc);
}
