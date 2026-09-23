/*
 * layout.js — page geometry for PhotoGrid. No DOM access, so it can be
 * unit-tested in Node.
 *
 * computePages() decides everything the preview, the PDF export and the Word
 * export need in order to place photos: each page's size and orientation, how
 * the grid is arranged on it, where every cell goes, and where the footer
 * sits. All measurements are in millimetres.
 */
(function (root) {
  "use strict";

  // Page sizes in mm (portrait).
  const PAGE_SIZES_MM = {
    A4:     { w: 210.0, h: 297.0 },
    Letter: { w: 215.9, h: 279.4 },
    Legal:  { w: 215.9, h: 355.6 },
  };

  const PT_TO_MM = 25.4 / 72;
  const FOOTER_LINE_HEIGHT = 1.15;   // line box = font size × this
  const FOOTER_PADDING_MM = 2;       // clear space above and below the footer text
  const FOOTER_MAX_CENTRE_MM = 10;   // footer never floats higher than this above the page edge
  const FOOTER_MIN_SIDE_MM = 6;      // keep left/right-aligned footers off the paper edge
  const EPS = 1e-6;

  function pageDims(pageSize, orientation) {
    const base = PAGE_SIZES_MM[pageSize] || PAGE_SIZES_MM.A4;
    const short = Math.min(base.w, base.h);
    const long = Math.max(base.w, base.h);
    return orientation === "landscape" ? { w: long, h: short } : { w: short, h: long };
  }

  function blockSize(rows, cols, cellMm, spacingMm) {
    return {
      w: cols * cellMm + Math.max(0, cols - 1) * spacingMm,
      h: rows * cellMm + Math.max(0, rows - 1) * spacingMm,
    };
  }

  /** How far (mm) a block spills out of an area, summed over both axes. */
  function overflowOf(block, area) {
    return Math.max(0, block.w - area.w - EPS) + Math.max(0, block.h - area.h - EPS);
  }

  function normaliseOrientation(o) {
    return o === "landscape" ? "landscape" : "portrait";
  }

  /** Orientation of page `index`: its own override if it has one, else the default. */
  function orientationFor(index, defaultOrientation, overrides) {
    const o = overrides ? overrides[index] : undefined;
    return o === "landscape" || o === "portrait" ? o : normaliseOrientation(defaultOrientation);
  }

  /**
   * Footer placement for one page. The footer is centred vertically in the
   * bottom margin. If the margin is too small for the text, the page reserves
   * a taller "footer zone" instead so the text never overlaps a photo.
   */
  function footerGeometry(dims, marginMm, footer) {
    const fontPt = footer.fontPt;
    const textH = fontPt * PT_TO_MM * FOOTER_LINE_HEIGHT;
    const zone = Math.max(marginMm, textH + 2 * FOOTER_PADDING_MM);
    const minCentre = textH / 2 + FOOTER_PADDING_MM;
    const centre = Math.min(Math.max(zone / 2, minCentre), Math.max(FOOTER_MAX_CENTRE_MM, minCentre));
    const side = Math.max(marginMm, FOOTER_MIN_SIDE_MM);
    const align = footer.align === "left" || footer.align === "right" ? footer.align : "center";
    const x = align === "left" ? side : align === "right" ? dims.w - side : dims.w / 2;
    return {
      zone,                      // bottom margin (mm) the page must keep free
      align, x,
      y: dims.h - centre,        // vertical centre of the text line, from the top edge
      fromBottom: centre,        // vertical centre of the text line, from the bottom edge
      textHeight: textH,
      side,                      // distance from each side edge to the text box
      maxWidth: dims.w - 2 * side,
      fontPt,
    };
  }

  /**
   * opts: {
   *   imageCount, rows, cols, cellMm, spacingMm, marginMm, pageSize,
   *   orientation,            // default orientation for pages without an override
   *   overrides,              // { pageIndex: "portrait" | "landscape" }
   *   trimEmptyRows,          // last page drops unused rows
   *   footer,                 // null, or { fontPt, align }
   * }
   */
  function computePages(opts) {
    const rows = Math.max(1, Math.floor(opts.rows) || 1);
    const cols = Math.max(1, Math.floor(opts.cols) || 1);
    const perPage = rows * cols;
    const n = Math.max(0, Math.floor(opts.imageCount) || 0);
    const pageCount = Math.max(1, Math.ceil(n / perPage));
    const cell = Math.max(0.1, +opts.cellMm || 0);
    const gap = Math.max(0, +opts.spacingMm || 0);
    const margin = Math.max(0, +opts.marginMm || 0);

    const pages = [];
    for (let i = 0; i < pageCount; i++) {
      const orientation = orientationFor(i, opts.orientation, opts.overrides);
      const dims = pageDims(opts.pageSize, orientation);
      const footer = opts.footer ? footerGeometry(dims, margin, opts.footer) : null;
      const bottom = footer ? footer.zone : margin;
      const area = { x: margin, y: margin, w: dims.w - 2 * margin, h: dims.h - margin - bottom };

      // Use the grid as set, unless turning it sideways fits this page better
      // (e.g. 4 across × 5 down becomes 5 across × 4 down on landscape).
      const asSet = blockSize(rows, cols, cell, gap);
      const sideways = blockSize(cols, rows, cell, gap);
      const turned = rows !== cols && overflowOf(sideways, area) < overflowOf(asSet, area);
      const gridRows = turned ? cols : rows;
      const gridCols = turned ? rows : cols;

      const start = i * perPage;
      const count = Math.min(perPage, Math.max(0, n - start));
      const isLast = i === pageCount - 1;
      const usedRows = isLast && opts.trimEmptyRows && count > 0
        ? Math.ceil(count / gridCols)
        : gridRows;

      const size = blockSize(usedRows, gridCols, cell, gap);
      const block = {
        x: area.x + Math.max(0, (area.w - size.w) / 2),
        y: area.y,
        w: size.w,
        h: size.h,
      };

      const cells = [];
      for (let slot = 0; slot < usedRows * gridCols; slot++) {
        const r = Math.floor(slot / gridCols);
        const c = slot % gridCols;
        cells.push({
          slot, row: r, col: c,
          x: block.x + c * (cell + gap),
          y: block.y + r * (cell + gap),
          w: cell, h: cell,
          imageIndex: slot < count ? start + slot : null,
        });
      }

      pages.push({
        index: i,
        orientation, dims,
        start, count, perPage,
        rows: usedRows, cols: gridCols,
        gridRows, gridCols, turned,
        cellMm: cell, spacingMm: gap,
        margins: { top: margin, right: margin, bottom, left: margin },
        area, block, cells,
        fits: overflowOf(size, area) === 0,
        footer,
      });
    }
    return pages;
  }

  function pageIndexOfImage(imageIndex, rows, cols) {
    const perPage = Math.max(1, Math.floor(rows) || 1) * Math.max(1, Math.floor(cols) || 1);
    return Math.max(0, Math.floor(imageIndex / perPage));
  }

  const api = {
    PAGE_SIZES_MM, PT_TO_MM,
    pageDims, blockSize, overflowOf, footerGeometry, computePages, pageIndexOfImage,
  };
  root.CutlineStudioLayout = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
