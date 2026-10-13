'use strict';
/*
 * The reminder speech bubble, iMessage style: it pops in, shows the "..." typing dots, types the
 * message out one letter at a time behind a caret, waits, and fades away. Clicking it closes it.
 *
 * The page places it with place(x, y, side): (x, y) is its bottom corner on the tail's side, and the
 * bubble sits to the left or right of that point. Styles are in overlay.css.
 */
(function (root) {
  const DOTS_MS = 1100;
  const LETTER_MS = 55;
  const PAUSE_MS = 260; // after . , ! ?
  const STAY_MS = 9000;
  const FADE_MS = 400;

  const graphemes = (text) => (typeof Intl !== 'undefined' && Intl.Segmenter
    ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (s) => s.segment)
    : Array.from(text));

  class Bubble {
    constructor(el) {
      this.el = el;
      this.textEl = el.querySelector('.bubble-text');
      this.timers = [];
      this.visible = false;
      this.side = 'left';
      /** Its height, measured when the text changes, so placing it each frame never forces a layout. */
      this.height = 0;
      /** Called once it has faded away. */
      this.onHidden = null;
    }

    measure() {
      this.height = this.el.offsetHeight;
    }

    later(fn, ms) {
      this.timers.push(setTimeout(fn, ms));
    }

    clear() {
      this.timers.forEach(clearTimeout);
      this.timers = [];
    }

    show(text) {
      this.clear();
      const reduced = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const letters = graphemes(String(text));
      this.visible = true;
      this.el.hidden = false;
      this.el.className = 'bubble ' + this.side + (reduced ? ' typed done' : ' dots');
      this.textEl.textContent = reduced ? letters.join('') : '';
      // Two frames so the pop-in transition starts from its "before" state.
      this.measure();
      requestAnimationFrame(() => requestAnimationFrame(() => this.el.classList.add('in')));

      let at = reduced ? 0 : DOTS_MS;
      if (!reduced) {
        this.later(() => {
          this.el.classList.remove('dots');
          this.measure();
        }, at);
        letters.forEach((_, i) => {
          at += LETTER_MS + Math.random() * 30 + (/[.,!?]/.test(letters[i - 1] || '') ? PAUSE_MS : 0);
          this.later(() => {
            this.textEl.textContent = letters.slice(0, i + 1).join('');
            this.measure();
          }, at);
        });
        this.later(() => this.el.classList.add('done'), at + 300);
        this.later(() => this.el.classList.add('typed'), at + 1400);
      }
      this.later(() => this.hide(), at + STAY_MS);
    }

    hide() {
      if (!this.visible) {
        return;
      }
      this.clear();
      this.el.classList.add('out');
      this.later(() => {
        this.visible = false;
        this.el.hidden = true;
        if (this.onHidden) {
          this.onHidden();
        }
      }, FADE_MS);
    }

    /** Puts the tip of the tail at (x, y), the bubble on the given side of it ('left' or 'right'). */
    place(x, y, side) {
      if (side !== this.side) {
        this.side = side;
        this.el.classList.toggle('left', side === 'left');
        this.el.classList.toggle('right', side === 'right');
      }
      const shift = side === 'left' ? '-100%' : '0px';
      this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(${shift}, -100%)`;
    }

    contains(pt) {
      if (!this.visible) {
        return false;
      }
      const r = this.el.getBoundingClientRect();
      return pt.x >= r.left && pt.x <= r.right && pt.y >= r.top && pt.y <= r.bottom;
    }
  }

  (root.SH || (root.SH = {})).bubble = { Bubble, MAX_WIDTH: 240 };
})(window);
