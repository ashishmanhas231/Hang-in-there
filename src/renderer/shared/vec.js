/*
 * Small 2D helpers shared by the physics, the hero moves and the drawing.
 * Loaded with a <script> tag in the overlay page, and with require() in the Node tests.
 *
 * Points and vectors are plain { x, y } objects. Matrices are canvas-style [a, b, c, d, e, f]:
 * (x, y) maps to (a x + c y + e, b x + d y + f), the same as ctx.setTransform(a, b, c, d, e, f).
 */
(function (root) {
  'use strict';

  const v = (x, y) => ({ x, y });
  const add = (a, b) => v(a.x + b.x, a.y + b.y);
  const sub = (a, b) => v(a.x - b.x, a.y - b.y);
  const mul = (a, k) => v(a.x * k, a.y * k);
  const len = (a) => Math.sqrt(a.x * a.x + a.y * a.y);
  const lenSq = (a) => a.x * a.x + a.y * a.y;
  const norm = (a) => {
    const l = len(a);
    return l > 1e-12 ? v(a.x / l, a.y / l) : v(a.x, a.y);
  };
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
  /** Same as C#'s Math.IEEERemainder(a, b): a - b * round(a / b), with ties to even. */
  const ieeeRemainder = (a, b) => {
    const q = a / b;
    let r = Math.round(q);
    if (Math.abs(q - Math.trunc(q)) === 0.5 && r % 2 !== 0) {
      r -= 1;
    }
    return a - b * r;
  };

  // ---- Rectangles { x, y, width, height } -------------------------------------------------
  const rect = (x, y, width, height) => ({ x, y, width, height });
  const rectUnion = (r, p) => {
    const left = Math.min(r.x, p.x);
    const top = Math.min(r.y, p.y);
    const right = Math.max(r.x + r.width, p.x);
    const bottom = Math.max(r.y + r.height, p.y);
    return rect(left, top, right - left, bottom - top);
  };
  const rectInflate = (r, dx, dy) => rect(r.x - dx, r.y - dy, r.width + 2 * dx, r.height + 2 * dy);
  const rectRight = (r) => r.x + r.width;
  const rectBottom = (r) => r.y + r.height;

  // ---- Matrices ---------------------------------------------------------------------------
  /** Applies m1 first, then m2. */
  const then = (m1, m2) => [
    m2[0] * m1[0] + m2[2] * m1[1],
    m2[1] * m1[0] + m2[3] * m1[1],
    m2[0] * m1[2] + m2[2] * m1[3],
    m2[1] * m1[2] + m2[3] * m1[3],
    m2[0] * m1[4] + m2[2] * m1[5] + m2[4],
    m2[1] * m1[4] + m2[3] * m1[5] + m2[5],
  ];
  const translateM = (x, y) => [1, 0, 0, 1, x, y];
  const scaleM = (sx, sy) => [sx, 0, 0, sy, 0, 0];
  /** Clockwise on screen (y down) for positive degrees, like WPF and the canvas. */
  const rotateM = (degrees) => {
    const r = (degrees * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    return [c, s, -s, c, 0, 0];
  };
  const rotateAtM = (degrees, cx, cy) => then(then(translateM(-cx, -cy), rotateM(degrees)), translateM(cx, cy));
  const applyM = (m, p) => v(m[0] * p.x + m[2] * p.y + m[4], m[1] * p.x + m[3] * p.y + m[5]);
  const applyVecM = (m, p) => v(m[0] * p.x + m[2] * p.y, m[1] * p.x + m[3] * p.y);

  // ---- Seeded random ----------------------------------------------------------------------
  /**
   * A small seeded random source with the parts of .NET's Random the moves use.
   * Seeded runs (the --scene test) repeat exactly. Unseeded uses Math.random.
   */
  function makeRandom(seed) {
    let next;
    if (seed === undefined || seed === null) {
      next = Math.random;
    } else {
      let s = seed >>> 0;
      // mulberry32
      next = () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    return {
      nextDouble: () => next(),
      /** next(max): 0..max-1. next(min, max): min..max-1. */
      next: (a, b) => {
        if (b === undefined) {
          return Math.floor(next() * a);
        }
        return a + Math.floor(next() * (b - a));
      },
    };
  }

  const api = {
    v, add, sub, mul, len, lenSq, norm, clamp, sign, ieeeRemainder,
    rect, rectUnion, rectInflate, rectRight, rectBottom,
    then, translateM, scaleM, rotateM, rotateAtM, applyM, applyVecM,
    makeRandom,
  };
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    (root.SH || (root.SH = {})).vec = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
