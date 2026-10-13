'use strict';
/*
 * User choices from the menu, saved to ~/.spidey-hang/settings.json.
 * Key names match earlier versions, so existing settings carry over.
 */
const fs = require('fs');
const paths = require('./paths');
const log = require('./log');

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
};

const BODY_LENGTH = { Small: 110, Medium: 150, Large: 200 };
const ROPE_FRACTION = { Short: 0.15, Medium: 0.27, Long: 0.42 };

class Settings {
  constructor(values) {
    Object.assign(this, DEFAULTS, values || {});
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
