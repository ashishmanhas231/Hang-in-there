'use strict';
/*
 * The focus timer (Pomodoro): FocusMinutes of focus, then a short break; every 4th break is a long
 * one. Then focus again, and so on until it is stopped.
 *
 * Everything is worked out from the wall clock (when the current part ends), never by counting
 * ticks, so a computer that slept comes back to the right part at the right time.
 *
 * Plain Node, no Electron and no timers of its own: main.js asks update(now) when the part is due
 * to end, and once a minute (once a second in the last minute) to redraw the countdown.
 */

const LONG_EVERY = 4;

class Focus {
  /** lengths() returns { focus, short, long } in minutes, read fresh at the start of each part. */
  constructor(lengths) {
    this.lengths = lengths;
    /** 'idle', 'focus', 'short' or 'long'. */
    this.phase = 'idle';
    this.endsAt = 0;
    /** Focus parts finished since it was started. */
    this.done = 0;
  }

  get running() {
    return this.phase !== 'idle';
  }

  /** Starts a focus part now, of `minutes` (or the usual length). */
  start(now, minutes) {
    const length = Number(minutes) > 0 ? Math.min(180, Number(minutes)) : this.lengths().focus;
    this.phase = 'focus';
    this.done = 0;
    this.endsAt = +now + length * 60000;
  }

  stop() {
    this.phase = 'idle';
    this.endsAt = 0;
    this.done = 0;
  }

  /** Ends the current part now and starts the next. Returns what update() would. */
  skip(now) {
    if (!this.running) {
      return null;
    }
    this.endsAt = +now;
    return this.update(now);
  }

  /**
   * Moves on past every part that has ended by now. Returns null, or the last change:
   * { ended: 'focus' | 'short' | 'long', next: 'focus' | 'short' | 'long', done, minutes }.
   * A computer that slept through several parts lands in the right one, with one change reported.
   */
  update(now) {
    let change = null;
    for (let guard = 0; this.running && this.endsAt <= +now && guard < 1000; guard++) {
      const ended = this.phase;
      const lengths = this.lengths();
      if (ended === 'focus') {
        this.done++;
        this.phase = this.done % LONG_EVERY === 0 ? 'long' : 'short';
      } else {
        this.phase = 'focus';
      }
      const minutes = this.phase === 'focus' ? lengths.focus : this.phase === 'long' ? lengths.long : lengths.short;
      this.endsAt += minutes * 60000;
      change = { ended, next: this.phase, done: this.done, minutes };
    }
    return change;
  }

  /** Milliseconds left in this part (0 when idle). */
  remaining(now) {
    return this.running ? Math.max(0, this.endsAt - now) : 0;
  }

  /** The countdown as shown by the menu bar icon: '24m', in the last minute '45s'; '' when idle. */
  label(now) {
    if (!this.running) {
      return '';
    }
    const ms = this.remaining(now);
    const seconds = Math.ceil(ms / 1000);
    const time = seconds < 60 ? `${seconds}s` : `${Math.ceil(ms / 60000)}m`;
    return this.phase === 'focus' ? time : `Break ${time}`;
  }

  /** How long until the countdown next changes, so the timer wakes only then (ms, at least 200). */
  nextTick(now) {
    const ms = this.remaining(now);
    if (ms <= 0) {
      return 200;
    }
    const unit = ms <= 60000 ? 1000 : 60000;
    // The label shows whole units rounded up: it changes when the time left crosses a multiple of the unit.
    return Math.max(200, Math.min(ms, (ms % unit) || unit));
  }

  /** In words, for the menu and the "focus status" command. */
  describe(now) {
    if (!this.running) {
      return 'Not running';
    }
    const left = Math.ceil(this.remaining(now) / 60000);
    const what = this.phase === 'focus' ? 'Focus' : this.phase === 'long' ? 'Long break' : 'Break';
    return `${what}: ${left} min left (${this.done} focus${this.done === 1 ? '' : 'es'} done)`;
  }
}

/** What he says when a part ends. */
function focusMessage(change) {
  if (change.ended === 'focus') {
    return change.next === 'long'
      ? `Great focus! Take a long break: ${change.minutes} minutes.`
      : `Focus done! Take a ${change.minutes} minute break.`;
  }
  return 'Break over. Back to it!';
}

module.exports = { Focus, focusMessage, LONG_EVERY };
