'use strict';
/*
 * How he reacts to the computer, and the little things he does on his own. The choices only; the
 * events come from main.js (powerMonitor) and the overlay page (battery), and the moves from
 * hang-view.js.
 *
 * Plain Node, no Electron. random() is passed in so the tests can pin it.
 */

const WELCOME = ['Welcome back!', 'There you are!', 'Missed you!', 'Back in action!', 'Hey, good to see you!'];

/** 'YYYY-MM-DD' of a date, in local time. */
function dayKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * What he says when you come back: the first greeting of a day goes by the time of day
 * ("Good morning!" before noon), later ones are a "Welcome back!" or similar.
 * Returns { text, day } (day: what to keep as the last greeting).
 */
function greeting(now, lastGreeting, random = Math.random) {
  const day = dayKey(now);
  if (day !== lastGreeting) {
    const hour = new Date(now).getHours();
    const text = hour < 5 ? 'Up late? Me too!' : hour < 12 ? 'Good morning!' : hour < 17 ? 'Good afternoon!' : 'Good evening!';
    return { text, day };
  }
  return { text: WELCOME[Math.floor(random() * WELCOME.length) % WELCOME.length], day };
}

/** Battery levels (share of full) that bring a warning, each once on the way down. */
const BATTERY_LEVELS = [0.2, 0.1];

/**
 * Watches battery reports. report({ level, charging }) returns a line to say, or null:
 * a warning once each time the level drops below 20% and then 10% on battery power, and a thank
 * you on being plugged in after a warning. A level that comes back up (charged) clears the warnings.
 */
class BatteryWatch {
  constructor() {
    this.warned = new Set();
    this.charging = null;
  }

  report({ level, charging }) {
    if (typeof level !== 'number' || !Number.isFinite(level) || typeof charging !== 'boolean') {
      return null;
    }
    const wasCharging = this.charging;
    this.charging = charging;
    if (charging) {
      const thanks = wasCharging === false && this.warned.size > 0;
      this.warned.clear();
      return thanks ? 'Thanks for the power-up!' : null;
    }
    for (const mark of [...this.warned]) {
      if (level > mark + 0.02) {
        this.warned.delete(mark);
      }
    }
    // The lowest level passed that has not been warned about yet; the higher ones count as warned too.
    const passed = BATTERY_LEVELS.filter((mark) => level <= mark);
    const fresh = passed.filter((mark) => !this.warned.has(mark));
    if (fresh.length === 0) {
      return null;
    }
    passed.forEach((mark) => this.warned.add(mark));
    const percent = Math.round(level * 100);
    return Math.min(...fresh) <= 0.1
      ? `Battery at ${percent}%! Plug me in, quick!`
      : `Battery's getting low (${percent}%). Time to find a charger.`;
  }
}

/** The little things he does on his own. */
const ANTICS = ['wiggle', 'bungee', 'swing', 'say', 'web'];

const LINES = [
  'Just hanging around.',
  'Nice view from up here.',
  'Your friendly neighborhood desktop!',
  'Is it lunch yet?',
  'Hang in there!',
  'Looking good today.',
  'My spider-sense is quiet. All good.',
];

/** One antic, never the same twice in a row. */
function pickAntic(random = Math.random, last = null) {
  const choices = ANTICS.filter((a) => a !== last);
  return choices[Math.floor(random() * choices.length) % choices.length];
}

/** Something to say, never the same twice in a row. */
function pickLine(random = Math.random, last = null) {
  const choices = LINES.filter((l) => l !== last);
  return choices[Math.floor(random() * choices.length) % choices.length];
}

/** How long to wait before the next antic: 3 to 7 minutes, in ms. */
function anticDelay(random = Math.random) {
  return Math.round((3 + 4 * random()) * 60000);
}

module.exports = { greeting, dayKey, BatteryWatch, BATTERY_LEVELS, ANTICS, LINES, pickAntic, pickLine, anticDelay, WELCOME };
