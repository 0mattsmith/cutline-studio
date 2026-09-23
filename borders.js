/*
 * borders.js — cell border styles for PhotoGrid. No DOM access.
 *
 * Each style is described once, as a list of strokes that run around the
 * edge of a cell. That description is drawn three ways:
 *   • svgMarkup()   → the on-screen preview
 *   • drawPdf()     → jsPDF drawing calls for the PDF export
 *   • wordBorder()  → a table-cell border setting for the Word export
 * Word has its own fixed set of border styles, so each style also names the
 * closest Word style (Word draws zig-zags as smooth waves).
 */
(function (root) {
  "use strict";

  const PT = 25.4 / 72; // 1 point in mm

  // Stroke fields (all in points):
  //   off   offset from the cell edge (+ = outward, − = inward)
  //   w     line width
  //   dash  dash pattern [on, off, …]
  //   cap   "round" for dotted lines
  //   zig   { amp, period } zig-zag instead of a straight line
  const STYLES = [
    { id: "single",       label: "Regular",       word: { style: "single", size: 6 },
      strokes: [{ off: 0, w: 0.75 }] },
    { id: "thick",        label: "Thick",         word: { style: "single", size: 18 },
      strokes: [{ off: 0, w: 2.25 }] },
    { id: "dashed",       label: "Dashed",        word: { style: "dashed", size: 6 },
      strokes: [{ off: 0, w: 0.75, dash: [3, 2] }] },
    { id: "dotted",       label: "Dotted",        word: { style: "dotted", size: 8 },
      strokes: [{ off: 0, w: 1, dash: [0, 2], cap: "round" }] },
    { id: "dashDot",      label: "Dash-dot",      word: { style: "dotDash", size: 6 },
      strokes: [{ off: 0, w: 0.75, dash: [4, 1.5, 1, 1.5] }] },
    { id: "double",       label: "Dual parallel", word: { style: "double", size: 4 },
      strokes: [{ off: -0.75, w: 0.5 }, { off: 0.75, w: 0.5 }] },
    { id: "triple",       label: "Tri-lined",     word: { style: "triple", size: 4 },
      strokes: [{ off: -1.25, w: 0.5 }, { off: 0, w: 0.5 }, { off: 1.25, w: 0.5 }] },
    { id: "thinThick",    label: "Thin-thick",    word: { style: "thinThickSmallGap", size: 12 },
      strokes: [{ off: -1, w: 0.5 }, { off: 0.75, w: 1.5 }] },
    { id: "zigzag",       label: "Zig-zag",       word: { style: "wave", size: 6 },
      strokes: [{ off: 0, w: 0.75, zig: { amp: 1.2, period: 4 } }] },
    { id: "doubleZigzag", label: "Dual zig-zag",  word: { style: "doubleWave", size: 6 },
      strokes: [
        { off: -1.1, w: 0.6, zig: { amp: 0.9, period: 4 } },
        { off: 1.1, w: 0.6, zig: { amp: 0.9, period: 4 } },
      ] },
  ];
  const BY_ID = Object.fromEntries(STYLES.map((s) => [s.id, s]));
  const DEFAULT_STYLE = "dashed";
  const DEFAULT_COLOR = "#BFBFBF";

  function getStyle(id) { return BY_ID[id] || BY_ID[DEFAULT_STYLE]; }

  function normaliseColor(c) {
    return /^#[0-9a-f]{6}$/i.test(c || "") ? c.toUpperCase() : DEFAULT_COLOR;
  }

  function hexToRgb(hex) {
    const n = parseInt(normaliseColor(hex).slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  /** Points of a zig-zag from (x1,y1) to (x2,y2). Both ends sit on the line
   *  so neighbouring sides meet cleanly at the corners. */
  function zigzagPoints(x1, y1, x2, y2, amp, period) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const teeth = Math.max(1, Math.round(len / period));
    const steps = teeth * 2;
    const pts = [];
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const o = k === 0 || k === steps ? 0 : (k % 2 ? amp : -amp);
      pts.push([x1 + dx * t + nx * o, y1 + dy * t + ny * o]);
    }
    return pts;
  }

  /**
   * Geometry (mm) of every stroke of one cell's border.
   * cell: { x, y, w, h } in mm. `unit` scales the result (1 = mm; pass a
   * px-per-mm factor to get pixels for the preview).
   */
  function cellStrokes(cell, styleId, unit) {
    const k = unit || 1;
    const style = getStyle(styleId);
    return style.strokes.map((s) => {
      const off = s.off * PT;
      const x = (cell.x - off) * k;
      const y = (cell.y - off) * k;
      const w = (cell.w + 2 * off) * k;
      const h = (cell.h + 2 * off) * k;
      const out = {
        width: s.w * PT * k,
        dash: s.dash ? s.dash.map((d) => d * PT * k) : null,
        cap: s.cap === "round" ? "round" : "butt",
      };
      if (s.zig) {
        const a = s.zig.amp * PT * k;
        const p = s.zig.period * PT * k;
        const L = x, T = y, R = x + w, B = y + h;
        out.lines = [
          zigzagPoints(L, T, R, T, a, p),
          zigzagPoints(R, T, R, B, a, p),
          zigzagPoints(R, B, L, B, a, p),
          zigzagPoints(L, B, L, T, a, p),
        ];
      } else {
        out.rect = { x, y, w, h };
      }
      return out;
    });
  }

  const f2 = (n) => (Math.round(n * 100) / 100).toString();

  function strokeAttrs(g, color, minWidth) {
    const width = Math.max(minWidth || 0, g.width);
    let a = `fill="none" stroke="${color}" stroke-width="${f2(width)}"`;
    if (g.dash) {
      // Keep dots visible: a zero-length dash with round caps draws a dot, but
      // the gap must be wider than the (possibly widened) line.
      const dash = g.dash.map((d, i) => (i % 2 ? Math.max(d, g.cap === "round" ? width * 1.6 : 0) : d));
      a += ` stroke-dasharray="${dash.map(f2).join(" ")}"`;
    }
    if (g.cap === "round") a += ` stroke-linecap="round"`;
    if (g.lines) a += ` stroke-linejoin="round"`;
    return a;
  }

  /** SVG elements (as a string) for the borders of the given cells.
   *  scale = px per mm; minWidth keeps hairlines visible on screen. */
  function svgMarkup(cells, styleId, color, scale, minWidth) {
    const c = normaliseColor(color);
    const parts = [];
    for (const cell of cells) {
      for (const g of cellStrokes(cell, styleId, scale)) {
        const attrs = strokeAttrs(g, c, minWidth);
        if (g.rect) {
          parts.push(`<rect x="${f2(g.rect.x)}" y="${f2(g.rect.y)}" width="${f2(g.rect.w)}" height="${f2(g.rect.h)}" ${attrs}/>`);
        } else {
          const d = g.lines.map((pts) => "M" + pts.map((p) => f2(p[0]) + " " + f2(p[1])).join("L")).join("");
          parts.push(`<path d="${d}" ${attrs}/>`);
        }
      }
    }
    return parts.join("");
  }

  /** A short horizontal sample of a style, for the style picker. */
  function sampleSvg(styleId, color, width, height) {
    const style = getStyle(styleId);
    const k = 1.9; // px per pt, exaggerated so thin styles read clearly
    const pad = 6;
    const mid = height / 2;
    const parts = [];
    for (const s of style.strokes) {
      const y = mid - s.off * k;
      const g = {
        width: s.w * k,
        dash: s.dash ? s.dash.map((d) => d * k) : null,
        cap: s.cap === "round" ? "round" : "butt",
      };
      if (s.zig) {
        g.lines = [zigzagPoints(pad, y, width - pad, y, s.zig.amp * k, s.zig.period * k)];
        const d = "M" + g.lines[0].map((p) => f2(p[0]) + " " + f2(p[1])).join("L");
        parts.push(`<path d="${d}" ${strokeAttrs(g, normaliseColor(color), 1)}/>`);
      } else {
        parts.push(`<line x1="${pad}" y1="${f2(y)}" x2="${width - pad}" y2="${f2(y)}" ${strokeAttrs(g, normaliseColor(color), 1)}/>`);
      }
    }
    return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true">${parts.join("")}</svg>`;
  }

  /** Draw the borders of the given cells onto the current jsPDF page (mm units). */
  function drawPdf(doc, cells, styleId, color) {
    const { r, g, b } = hexToRgb(color);
    doc.setDrawColor(r, g, b);
    for (const cell of cells) {
      for (const s of cellStrokes(cell, styleId, 1)) {
        doc.setLineWidth(s.width);
        doc.setLineCap(s.cap);
        doc.setLineJoin(s.lines ? "round" : "miter");
        doc.setLineDashPattern(s.dash || [], 0);
        if (s.rect) {
          doc.rect(s.rect.x, s.rect.y, s.rect.w, s.rect.h, "S");
        } else {
          for (const pts of s.lines) {
            const deltas = [];
            for (let i = 1; i < pts.length; i++) {
              deltas.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]);
            }
            doc.lines(deltas, pts[0][0], pts[0][1], [1, 1], "S", false);
          }
        }
      }
    }
    doc.setLineDashPattern([], 0);
    doc.setLineCap("butt");
    doc.setLineJoin("miter");
  }

  /** Border setting for a Word table cell ({ style, size, color } as docx.js expects). */
  function wordBorder(styleId, color) {
    const s = getStyle(styleId);
    return { style: s.word.style, size: s.word.size, color: normaliseColor(color).slice(1) };
  }

  const api = {
    STYLES, DEFAULT_STYLE, DEFAULT_COLOR,
    getStyle, normaliseColor, hexToRgb, zigzagPoints, cellStrokes,
    svgMarkup, sampleSvg, drawPdf, wordBorder,
  };
  root.CutlineStudioBorders = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
