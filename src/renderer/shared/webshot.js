/*
 * The Big web reminder, while he is taken down: he shoots three webs from his hand into the middle
 * of the screen, a small one, a bigger one over it, then a big one, and the reminder is written in
 * the big one. A click on it closes it; otherwise it closes after STAY_MS.
 *
 * Each web is drawn once, into a bitmap, when the reminder starts; a frame only scales those bitmaps
 * as they land. The text is a page element (sharp, and read out by screen readers). Once the text is
 * showing nothing moves, so the page draws nothing until it closes.
 */
(function (root) {
  'use strict';

  /** When each web is shot (seconds from the start), how long it flies, and how long it springs open. */
  const SHOTS = [0, 0.55, 1.1];
  const FLIGHT = 0.16;
  const GROW = 0.24;
  /** Each web's size, as a share of the big one. */
  const SHARES = [0.3, 0.62, 1];
  const TEXT_AT = SHOTS[2] + FLIGHT + GROW + 0.1;
  const LETTER_MS = 55;
  const PAUSE_MS = 260; // after . , ! ?
  const STAY_MS = 12000;
  const FADE = 0.35;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const graphemes = (text) => (typeof Intl !== 'undefined' && Intl.Segmenter
    ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (s) => s.segment)
    : Array.from(text));

  /**
   * A web like the films' (size units across), drawn into a bitmap at pixel density dpr: no outlined
   * tubes, but bundles of hair-thin translucent fibres. Spokes are bundles that drift apart and fray
   * into loose fibres at the rim; the capture threads between them are looser bundles that sag; the
   * middle is a dense mat of crossing fibres; small glints catch the light. The same seed gives the
   * same web. Drawn once per reminder, so the detail costs nothing per frame.
   */
  function webBitmap(size, seed, dpr) {
    const pad = 6;
    const px = Math.ceil((size + pad * 2) * dpr);
    const canvas = new OffscreenCanvas(px, px);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.translate(pad, pad);
    let r = (seed * 7919) % 233280;
    const rnd = () => {
      r = (r * 9301 + 49297) % 233280;
      return r / 233280;
    };
    const c = size / 2;
    const R = c * 0.9;
    const spokes = 28;
    const turns = 15;
    const fine = Math.max(0.35, size / 900); // one fibre
    const angles = [];
    for (let i = 0; i < spokes; i++) {
      angles.push(-Math.PI / 2 + (i * Math.PI * 2) / spokes + (rnd() - 0.5) * 0.12);
    }
    const reach = angles.map(() => R * (0.86 + rnd() * 0.14));
    const at = (radius, a) => [c + radius * Math.cos(a), c + radius * Math.sin(a)];
    // Fibres by brightness, so each set is stroked once.
    const bright = new Path2D();
    const soft = new Path2D();
    const faint = new Path2D();

    // Spokes: 4-5 fibres each, drifting apart along the way, fraying out past the rim.
    for (let i = 0; i < spokes; i++) {
      const a = angles[i];
      const nx = -Math.sin(a);
      const ny = Math.cos(a);
      const count = 4 + Math.floor(rnd() * 2);
      for (let f = 0; f < count; f++) {
        const spread = (rnd() - 0.5) * fine * 2.4;
        const wave = rnd() * Math.PI * 2;
        const fray = rnd() < 0.5 ? (rnd() - 0.5) * 0.25 : 0;
        const end = reach[i] * (0.95 + rnd() * 0.12);
        const path = f < 2 ? bright : f < 4 ? soft : faint;
        const n = 36;
        for (let k = 0; k <= n; k++) {
          const t = k / n;
          const along = end * t;
          const drift = spread * t + Math.sin(t * 9 + wave) * fine * 0.5 * t;
          const turn = a + fray * Math.max(0, t - 0.85) * 4;
          const x = c + Math.cos(turn) * along + nx * drift;
          const y = c + Math.sin(turn) * along + ny * drift;
          if (k === 0) path.moveTo(x, y);
          else path.lineTo(x, y);
        }
      }
    }
    // Capture threads: a spiral of 2-fibre bundles, sagging between spokes, now and then missing.
    const steps = turns * spokes;
    const radiusAt = (j) => R * (0.14 + 0.8 * Math.pow(j / steps, 1.08)) * (1 + (rnd() - 0.5) * 0.04);
    const radii = Array.from({ length: steps + 1 }, (_, j) => radiusAt(j));
    for (const [path, shift] of [[bright, 0], [faint, fine * 0.6]]) {
      for (let j = 0; j < steps; j++) {
        if (rnd() < 0.04) continue; // a missing thread
        const i = j % spokes;
        const a1 = angles[i];
        let a2 = angles[(i + 1) % spokes];
        if (a2 < a1) a2 += Math.PI * 2;
        const r1 = Math.min(reach[i] * 0.97, radii[j] + shift);
        const r2 = Math.min(reach[(i + 1) % spokes] * 0.97, radii[j + 1] + shift);
        const sag = 0.86 + rnd() * 0.06;
        path.moveTo(...at(r1, a1));
        path.quadraticCurveTo(...at(((r1 + r2) / 2) * sag, (a1 + a2) / 2), ...at(r2, a2));
      }
    }
    // The middle: a dense mat of short crossing fibres.
    for (let k = 0; k < 420; k++) {
      const rr = R * 0.17 * Math.sqrt(rnd());
      const a0 = rnd() * Math.PI * 2;
      const [x, y] = at(rr, a0);
      const da = rnd() * Math.PI * 2;
      const len = R * (0.03 + rnd() * 0.08);
      const path = k % 3 === 0 ? bright : k % 3 === 1 ? soft : faint;
      path.moveTo(x, y);
      path.quadraticCurveTo(x + Math.cos(da + 0.6) * len * 0.5, y + Math.sin(da + 0.6) * len * 0.5, x + Math.cos(da) * len, y + Math.sin(da) * len);
    }
    // Loose wisps all over, and a few hanging below the rim.
    for (let k = 0; k < spokes * 6; k++) {
      const i = Math.floor(rnd() * spokes);
      const [x, y] = at(reach[i] * (0.2 + rnd() * 0.85), angles[i]);
      const da = angles[i] + (rnd() - 0.5) * 2;
      const len = fine * (8 + rnd() * 22);
      faint.moveTo(x, y);
      faint.quadraticCurveTo(x + Math.cos(da) * len * 0.5, y + Math.sin(da) * len * 0.5 + len * 0.3, x + Math.cos(da) * len, y + Math.sin(da) * len + len * 0.2);
    }
    for (let k = 0; k < 5; k++) {
      const [x, y] = at(R * (0.85 + rnd() * 0.12), Math.PI * (0.2 + rnd() * 0.6));
      const len = R * (0.06 + rnd() * 0.12);
      faint.moveTo(x, y);
      faint.bezierCurveTo(x + len * 0.25, y + len * 0.35, x - len * 0.2, y + len * 0.7, x + len * 0.08, y + len);
    }

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // A faint haze of silk under it all.
    ctx.save();
    ctx.filter = `blur(${Math.max(1, fine * 3)}px)`;
    ctx.strokeStyle = 'rgba(230, 238, 248, 0.07)';
    ctx.lineWidth = fine * 5;
    ctx.stroke(bright);
    ctx.stroke(soft);
    ctx.restore();
    // The fibres, with a soft shadow so they read on light wallpapers too.
    ctx.save();
    ctx.shadowColor = 'rgba(10, 14, 22, 0.3)';
    ctx.shadowBlur = 1.2;
    ctx.shadowOffsetY = 0.5;
    for (const [path, style, w] of [[faint, 'rgba(226, 233, 242, 0.45)', 0.8], [soft, 'rgba(236, 241, 247, 0.72)', 1], [bright, 'rgba(250, 252, 255, 0.95)', 1.15]]) {
      ctx.strokeStyle = style;
      ctx.lineWidth = fine * w;
      ctx.stroke(path);
    }
    ctx.restore();
    // Glints where the light catches a fibre.
    for (let k = 0; k < 90; k++) {
      const i = Math.floor(rnd() * spokes);
      const [x, y] = at(reach[i] * (0.15 + rnd() * 0.8), angles[i]);
      const g = ctx.createRadialGradient(x, y, 0, x, y, fine * 3.5);
      g.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
      g.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - fine * 4, y - fine * 4, fine * 8, fine * 8);
    }
    return { bitmap: canvas.transferToImageBitmap(), size: size + pad * 2 };
  }

  class WebShot {
    /** note: the page element the text goes in (overlay.html #webnote). */
    constructor(note) {
      this.note = note;
      this.textEl = note.querySelector('.webnote-text');
      this.place = null;
      this.webs = null;
      this.active = false;
      this.age = 0;
      this.closing = null;
      this.timers = [];
      /** Called once it has closed and faded. */
      this.onDone = null;
      /** Called when something starts moving again (a close), so the page draws. */
      this.onChange = null;
      /** Called once the whole text is showing. */
      this.onTyped = null;
    }

    /** Where the webs land, { x, y, size } in window units, and the screen's pixel density. */
    prepare(place, dpr) {
      this.free();
      this.place = place;
      this.dpr = dpr;
    }

    /** Shoots the webs and writes text in the big one. With reduced motion it is all there at once. */
    start(text, reduced) {
      if (!this.place) {
        return false;
      }
      this.webs = SHARES.map((share, i) => webBitmap(Math.round(this.place.size * share), i + 2, this.dpr));
      this.active = true;
      this.closing = null;
      this.age = reduced ? TEXT_AT : 0;
      const { x, y, size } = this.place;
      Object.assign(this.note.style, { width: `${size}px`, height: `${size}px`, transform: `translate(${Math.round(x - size / 2)}px, ${Math.round(y - size / 2)}px)` });
      this.note.className = 'webnote';
      this.textEl.textContent = '';
      this.note.hidden = true;
      const letters = graphemes(String(text));
      let at = reduced ? 0 : TEXT_AT * 1000;
      this.later(() => {
        this.note.hidden = false;
        requestAnimationFrame(() => this.note.classList.add('in'));
        if (reduced) {
          this.textEl.textContent = letters.join('');
          this.note.classList.add('typed');
          this.typed();
        }
      }, at);
      if (!reduced) {
        letters.forEach((_, i) => {
          at += LETTER_MS + (/[.,!?]/.test(letters[i - 1] || '') ? PAUSE_MS : 0);
          this.later(() => {
            this.textEl.textContent = letters.slice(0, i + 1).join('');
          }, at);
        });
        this.later(() => {
          this.note.classList.add('typed');
          this.typed();
        }, at + 200);
      }
      this.later(() => this.close(), at + STAY_MS);
      return true;
    }

    typed() {
      if (this.onTyped) {
        this.onTyped();
      }
    }

    later(fn, ms) {
      this.timers.push(setTimeout(fn, ms));
    }

    /** Fades the webs and the text out, then calls onDone. */
    close() {
      if (!this.active || this.closing) {
        return;
      }
      this.timers.forEach(clearTimeout);
      this.timers = [];
      this.closing = { age: 0 };
      this.note.classList.add('out');
      if (this.onChange) {
        this.onChange();
      }
    }

    advance(dt) {
      if (!this.active) {
        return;
      }
      this.age += dt;
      if (this.closing) {
        this.closing.age += dt;
        if (this.closing.age >= FADE) {
          this.finish();
        }
      }
    }

    finish() {
      this.active = false;
      this.closing = null;
      this.note.hidden = true;
      this.note.className = 'webnote';
      this.free();
      if (this.onDone) {
        this.onDone();
      }
    }

    /** Lets the web bitmaps go: they are only needed while it shows. */
    free() {
      if (this.webs) {
        this.webs.forEach((w) => w.bitmap.close());
        this.webs = null;
      }
    }

    /** True when nothing is moving: no web in flight or opening, and not fading out. */
    get settled() {
      return !this.active || (this.age >= Math.max(TEXT_AT, SHOTS[2] + FLIGHT + 0.6) && !this.closing);
    }

    /** The webs that have landed, springing open, and fading when it closes. */
    drawWebs(ctx) {
      if (!this.active || !this.webs) {
        return;
      }
      const { x, y } = this.place;
      const fade = this.closing ? 1 - clamp(this.closing.age / FADE, 0, 1) : 1;
      this.webs.forEach((web, i) => {
        const g = clamp((this.age - SHOTS[i] - FLIGHT) / GROW, 0, 1);
        if (g <= 0) {
          return;
        }
        // Lands and springs out to full size, overshooting a little.
        const k = g === 1 ? 1 : Math.max(0.02, 1 + 2.2 * (g - 1) ** 3 + 1.2 * (g - 1) ** 2);
        // Covered by the next web once it has landed: this one fades away under it.
        const next = i + 1 < this.webs.length ? clamp((this.age - SHOTS[i + 1] - FLIGHT - GROW) / 0.3, 0, 1) : 0;
        if (next >= 1) {
          return;
        }
        ctx.save();
        ctx.globalAlpha *= fade * (1 - next);
        ctx.translate(x, y);
        // It wobbles a moment as it takes hold.
        const since = this.age - SHOTS[i] - FLIGHT;
        if (since < 0.6) {
          ctx.rotate(0.035 * Math.sin(since * 22) * Math.exp(-since * 7));
        }
        ctx.scale(k, k);
        ctx.drawImage(web.bitmap, -web.size / 2, -web.size / 2, web.size, web.size);
        ctx.restore();
      });
    }

    /** The web on its way from his hand, as { to, share }, or null. */
    inFlight() {
      if (!this.active || this.closing) {
        return null;
      }
      for (const s of SHOTS) {
        const t = this.age - s;
        if (t >= 0 && t < FLIGHT) {
          return { to: { x: this.place.x, y: this.place.y }, share: t / FLIGHT };
        }
      }
      return null;
    }
  }

  (root.SH || (root.SH = {})).webshot = { WebShot, SHOTS, FLIGHT, GROW, TEXT_AT, STAY_MS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
