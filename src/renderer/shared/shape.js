/*
 * Linux only: the part of the overlay window that catches the mouse, as a few rectangles.
 *
 * On Windows and macOS the window lets every click through and switches that off while the pointer is
 * over him, because those systems keep telling the page where the pointer is. On Linux they do not:
 * once the window lets clicks through, it hears nothing more of the pointer (on Wayland, X11 apps
 * cannot even see it over other apps). So there the window instead gets a shape that covers only
 * what is drawn, and the desktop itself sends clicks inside it to him and the rest to whatever is
 * underneath.
 *
 * The scene is drawn small, one pixel per CELL x CELL square of the window, and every square with
 * anything drawn in it, grown by a few squares all round (padCells), is covered. The shape also clips
 * what the window shows, and it reaches the screen a frame or two after the drawing it came from, so
 * the faster he moves the more it grows: enough that he never runs past its edge in the meantime.
 *
 * Loaded with a <script> tag in the overlay page, and with require() in the Node tests.
 */
(function (root) {
  'use strict';

  const CELL = 8;
  const PAD = 3;
  const MAX_PAD = 14;
  /** How many frames behind the drawing the shape can be on screen. */
  const LAG_FRAMES = 3;

  /** Cells to grow the shape by when he moved `moved` window units since the last frame. */
  function padCells(moved, cell = CELL) {
    return Math.min(MAX_PAD, PAD + Math.ceil((LAG_FRAMES * Math.max(0, moved)) / cell));
  }

  /**
   * Rectangles ({ x, y, width, height }, window units) covering every cell whose alpha is above zero,
   * grown by `pad` cells. alpha holds RGBA bytes for cols x rows cells, as getImageData returns them.
   * Rows of cells with the same runs are merged into one taller rectangle.
   */
  function rectsFromAlpha(alpha, cols, rows, cell = CELL, pad = PAD) {
    // Columns covered in each row, after growing sideways.
    const covered = [];
    for (let r = 0; r < rows; r++) {
      const line = new Uint8Array(cols);
      for (let c = 0; c < cols; c++) {
        if (alpha[(r * cols + c) * 4 + 3] > 0) {
          line.fill(1, Math.max(0, c - pad), Math.min(cols, c + pad + 1));
        }
      }
      covered.push(line);
    }
    // Then down and up: a row is covered where any row within pad of it is.
    const grown = [];
    for (let r = 0; r < rows; r++) {
      const line = new Uint8Array(cols);
      for (let k = Math.max(0, r - pad); k <= Math.min(rows - 1, r + pad); k++) {
        for (let c = 0; c < cols; c++) {
          line[c] |= covered[k][c];
        }
      }
      grown.push(line);
    }

    const rects = [];
    let open = new Map(); // "from-to" column run -> its rectangle, still growing downwards
    for (let r = 0; r < rows; r++) {
      const next = new Map();
      let c = 0;
      while (c < cols) {
        if (!grown[r][c]) {
          c++;
          continue;
        }
        const from = c;
        while (c < cols && grown[r][c]) {
          c++;
        }
        const key = from + '-' + c;
        const rect = open.get(key) || { x: from * cell, y: r * cell, width: (c - from) * cell, height: 0 };
        rect.height += cell;
        next.set(key, rect);
        if (!open.has(key)) {
          rects.push(rect);
        }
      }
      open = next;
    }
    return rects;
  }

  /** A rectangle with whole-unit edges that holds the given box ({ left, top, right, bottom }), grown by margin. */
  function rectAround(box, margin = 0) {
    const x = Math.floor(box.left - margin);
    const y = Math.floor(box.top - margin);
    return { x, y, width: Math.ceil(box.right + margin) - x, height: Math.ceil(box.bottom + margin) - y };
  }

  const api = { rectsFromAlpha, rectAround, padCells, CELL, PAD, MAX_PAD };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    (root.SH || (root.SH = {})).shape = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
