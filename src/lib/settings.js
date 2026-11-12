'use strict';
/*
 * User choices from the menu, saved to ~/.spidey-hang/settings.json.
 * Key names match earlier versions, so existing settings carry over.
 */
const fs = require('fs');
const paths = require('./paths');
const log = require('./log');
const { cleanCustomList, cleanWaterMinutes, cleanLunchTime } = require('./reminders');

const DRAWN = 'Drawn Spider-Man';

const DEFAULTS = {
  /** Where the web is tied along the top of the screen. 0 = left edge, 1 = right edge. */
  AnchorFraction: 0.88,
  /** Small, Medium or Large. */
  Size: 'Medium',
  /** Short, Medium or Long. */
  Rope: 'Medium',
  /** A light breeze that keeps him swaying. Off by default so he can go still and use no CPU. */
  Breeze: false,
  /** Keep a steady swing going instead of settling. Uses CPU the whole time it is on. */
  AutoSwing: false,
  /** A hero folder name under src/heroes, or DRAWN. */
  Hero: 'Iconic Spidey - Upside Down',
  /** Change to the next hero every this many minutes. 0 = never. */
  RotateMinutes: 0,
  /** Start at sign-in. */
  StartAutomatically: true,
  /** A "drink water" bubble every half hour. */
  WaterReminder: true,
  /** A "lunch time" bubble every day at 3:00 PM. */
  LunchReminder: true,
  /** The user's own reminders, made in the Reminders window. See reminders.js for the fields. */
  CustomReminders: [],
  /**
   * Taken down: his window is closed and the app waits in the tray with the reminder clock. He drops
   * in to deliver each reminder, then climbs out again. Kept over a restart.
   */
  Down: false,
  /** Minutes between "drink water" bubbles (15..120), lined up with the clock. */
  WaterMinutes: 30,
  /** When the lunch bubble comes, 'HH:MM'. */
  LunchTime: '15:00',
  /** The focus timer (Pomodoro): focus, then a short break; every 4th break is a long one. Minutes. */
  FocusMinutes: 25,
  ShortBreakMinutes: 5,
  LongBreakMinutes: 15,
  /** Dozes when you are away, greets you when you come back, warns about a low battery. */
  Reactions: true,
  /** Minutes with no keyboard or mouse before he dozes off (2..30). */
  IdleMinutes: 5,
  /** Every few minutes at rest he does a little something on his own. */
  Antics: true,
  /** A "thwip" when a web shoots, a whoosh on a hard fling. */
  Sounds: false,
  /** Control+Option+Shift (Ctrl+Alt+Shift) with H, S, W, F, anywhere. */
  Hotkeys: true,
  /** macOS: not shown over apps in full screen. */
  HideInFullScreen: true,
  /** Which screen he hangs on: '' the main one, 'pointer' wherever the pointer is, or a screen's id. */
  Display: '',
  /** The day he last greeted you ('YYYY-MM-DD'), so the first greeting of a day is a "Good morning". Set by the app. */
  LastGreeting: '',
};

const clampInt = (value, lo, hi, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
};

const BODY_LENGTH = { Small: 110, Medium: 150, Large: 200 };
const ROPE_FRACTION = { Short: 0.15, Medium: 0.27, Long: 0.42 };

class Settings {
  constructor(values) {
    Object.assign(this, DEFAULTS, values || {});
    // Never share the defaults' list between copies.
    this.CustomReminders = cleanCustomList(this.CustomReminders);
    // Numbers out of range (a hand-edited file) are pulled back in.
    this.WaterMinutes = cleanWaterMinutes(this.WaterMinutes);
    this.LunchTime = cleanLunchTime(this.LunchTime);
    this.FocusMinutes = clampInt(this.FocusMinutes, 1, 180, DEFAULTS.FocusMinutes);
    this.ShortBreakMinutes = clampInt(this.ShortBreakMinutes, 1, 60, DEFAULTS.ShortBreakMinutes);
    this.LongBreakMinutes = clampInt(this.LongBreakMinutes, 1, 120, DEFAULTS.LongBreakMinutes);
    this.IdleMinutes = clampInt(this.IdleMinutes, 2, 30, DEFAULTS.IdleMinutes);
  }

  get bodyLength() {
    return BODY_LENGTH[this.Size] || BODY_LENGTH.Medium;
  }

  /** Rope length as a share of the screen height. */
  get ropeFraction() {
    return ROPE_FRACTION[this.Rope] || ROPE_FRACTION.Medium;
  }

  static load() {
    const file = paths.settingsFile();
    try {
      if (fs.existsSync(file)) {
        // Tolerate a byte-order mark (Windows PowerShell 5.1 adds one when it writes UTF-8).
        const json = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
        const raw = JSON.parse(json);
        const values = {};
        for (const key of Object.keys(DEFAULTS)) {
          if (raw[key] !== undefined && (raw[key] === null || typeof raw[key] === typeof DEFAULTS[key] || DEFAULTS[key] === null)) {
            values[key] = raw[key];
          }
        }
        return new Settings(values);
      }
    } catch (err) {
      // A broken settings file just means defaults.
      log.write('Settings file unreadable, using defaults. ' + err.message);
    }
    return new Settings();
  }

  save() {
    try {
      fs.mkdirSync(paths.dataDir(), { recursive: true });
      const out = {};
      for (const key of Object.keys(DEFAULTS)) {
        if (this[key] !== null && this[key] !== undefined) {
          out[key] = this[key];
        }
      }
      fs.writeFileSync(paths.settingsFile(), JSON.stringify(out, null, 2));
    } catch {
      // Failing to save settings must never crash the overlay.
    }
  }
}

module.exports = { Settings, DRAWN, DEFAULTS };
