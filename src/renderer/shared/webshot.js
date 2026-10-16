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
  const SHARES = [90 / 380, 200 / 380, 1];
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
   * A hand-spun web, size units across, drawn into a bitmap at pixel density dpr: twelve spokes a
   * little off even, and rings that sag between them. The same seed gives the same web.
   */
  function webBitmap(size, seed, dpr) {
    const pad = 4;
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
    const R = c * 0.97;
    const spokes = 12;
    const angles = [];
    for (let i = 0; i < spokes; i++) {
      angles.push(-Math.PI / 2 + (i * Math.PI * 2) / spokes + (rnd() - 0.5) * 0.2);
    }
    const reach = angles.map(() => R * (0.93 + rnd() * 0.07));
    const at = (radius, a) => [c + radius * Math.cos(a), c + radius * Math.sin(a)];
    const web = new Path2D();
    for (let i = 0; i < spokes; i++) {
      web.moveTo(c, c);
      web.lineTo(...at(reach[i], angles[i]));
    }
    for (const k of [0.1, 0.2, 0.31, 0.43, 0.56, 0.7, 0.85]) {
      for (let i = 0; i < spokes; i++) {
        const a1 = angles[i];
        let a2 = angles[(i + 1) % spokes];
        if (a2 < a1) a2 += Math.PI * 2;
        const r1 = Math.min(reach[i], R * k * (0.97 + rnd() * 0.06));
        const r2 = Math.min(reach[(i + 1) % spokes], R * k * (0.97 + rnd() * 0.06));
        web.moveTo(...at(r1, a1));
        web.quadraticCurveTo(...at(((r1 + r2) / 2) * 0.84, (a1 + a2) / 2), ...at(r2, a2));
      }
    }
    const strand = clamp(size / 220, 1, 1.8);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.save();
    ctx.translate(0.8, 1.4);
    ctx.strokeStyle = 'rgba(8, 10, 16, 0.38)';
    ctx.lineWidth = strand + 1.6;
    ctx.stroke(web);
    ctx.restore();
    ctx.strokeStyle = '#EEF1F5';
    ctx.lineWidth = strand;
    ctx.stroke(web);
    // Knots where the outer ring meets each spoke catch the light.
    ctx.fillStyle = '#FFFFFF';
    for (const a of angles) {
      const [x, y] = at(R * 0.85, a);
      ctx.beginPath();
      ctx.arc(x, y, strand * 1.2, 0, Math.PI * 2);
      ctx.fill();
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
        }
      }, at);
      if (!reduced) {
        letters.forEach((_, i) => {
          at += LETTER_MS + (/[.,!?]/.test(letters[i - 1] || '') ? PAUSE_MS : 0);
          this.later(() => {
            this.textEl.textContent = letters.slice(0, i + 1).join('');
          }, at);
        });
        this.later(() => this.note.classList.add('typed'), at + 200);
      }
      this.later(() => this.close(), at + STAY_MS);
      return true;
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
      return !this.active || (this.age >= TEXT_AT && !this.closing);
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
        ctx.save();
        ctx.globalAlpha *= fade;
        ctx.translate(x, y);
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
