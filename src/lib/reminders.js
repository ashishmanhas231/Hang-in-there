'use strict';
/*
 * Reminders: "drink water" on every half hour of the clock, "lunch" every day at 3:00 PM.
 * When both fall on the same moment (3:00 PM), only lunch is shown.
 *
 * The timer never waits more than a minute before looking at the clock again, so a Mac that slept
 * or a clock that changed does not throw it off. A reminder that is more than two minutes late
 * (the computer was asleep) is skipped instead of shown at the wrong time.
 *
 * Plain Node, no Electron.
 */

const TEXT = {
  water: 'Time to drink some water',
  lunch: "It's your lunch time",
};

const LUNCH_HOUR = 15;
const LUNCH_MINUTE = 0;
const MAX_WAIT_MS = 60 * 1000;
const STALE_MS = 2 * 60 * 1000;

/** The next :00 or :30 strictly after now. */
function nextHalfHour(now) {
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60);
  return d;
}

/** The next hour:minute today, or tomorrow if that has passed. */
function nextDaily(now, hour, minute) {
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  if (d <= now) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

/** { kind, at } for the next reminder that is switched on, or null if none are. */
function nextReminder(now, options) {
  const water = options.water ? nextHalfHour(now) : null;
  const lunch = options.lunch ? nextDaily(now, LUNCH_HOUR, LUNCH_MINUTE) : null;
  if (lunch && (!water || lunch <= water)) {
    return { kind: 'lunch', at: lunch };
  }
  return water ? { kind: 'water', at: water } : null;
}

class ReminderClock {
  /**
   * options() returns { water, lunch } (booleans), read fresh each time.
   * onRemind({ kind, text }) is called when one is due.
   */
  constructor(options, onRemind, now = () => new Date()) {
    this.options = options;
    this.onRemind = onRemind;
    this.now = now;
    this.timer = null;
    this.next = null;
  }

  /** (Re)starts from the current settings. */
  start() {
    this.stop();
    this.next = nextReminder(this.now(), this.options());
    if (this.next) {
      this.arm();
    }
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    this.next = null;
  }

  arm() {
    const wait = Math.max(0, Math.min(MAX_WAIT_MS, this.next.at - this.now()));
    this.timer = setTimeout(() => this.tick(), wait);
  }

  tick() {
    const late = this.now() - this.next.at;
    if (late < 0) {
      this.arm();
      return;
    }
    const due = this.next;
    this.start();
    if (late <= STALE_MS) {
      this.onRemind({ kind: due.kind, text: TEXT[due.kind] });
    }
  }
}

module.exports = { TEXT, nextHalfHour, nextDaily, nextReminder, ReminderClock, STALE_MS };
