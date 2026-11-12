'use strict';
/*
 * Reminders: "drink water" every WaterMinutes (30 by default) lined up with the clock, so every 30
 * minutes means :00 and :30; "lunch" every day at LunchTime (3:00 PM by default).
 * When both fall on the same moment, only lunch is shown.
 *
 * One-off reminders ("remind in 10 Tea is ready" on the command channel): { id, at, text }, kept in
 * memory only. One that came due while the computer slept is shown as soon as it wakes.
 *
 * Custom reminders (settings.CustomReminders), made in the Reminders window:
 *   { id, text, type: 'daily', time: 'HH:MM', days, on, style }      at that time of day
 *   { id, text, type: 'every', minutes: N, days, on, style }         every N minutes, counted from midnight
 * days lists the weekdays it runs on (0 = Sunday ... 6 = Saturday); all seven means every day.
 * style is how it shows while he is taken down: 'bubble' (he drops in and says it) or 'web' (he drops
 * in and shoots three webs to the middle of the screen, the text written in the big one). While he
 * is up, every reminder is a bubble. Water and lunch are bubbles.
 * Reminders due at the same moment are all shown, one after another.
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

const LUNCH_TIME = '15:00';
const MIN_WATER = 15;
const MAX_WATER = 120;
const WATER_CHOICES = [15, 20, 30, 45, 60, 90, 120];
const MAX_WAIT_MS = 60 * 1000;
const STALE_MS = 2 * 60 * 1000;

const MAX_TEXT = 120;
const MAX_CUSTOM = 50;
const MIN_EVERY = 5;
const MAX_EVERY = 24 * 60;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The next :00 or :30 strictly after now. */
function nextHalfHour(now) {
  return nextWater(now, 30);
}

/** Water minutes kept within 15..120. */
function cleanWaterMinutes(minutes) {
  const m = Math.round(Number(minutes));
  return Number.isFinite(m) ? Math.max(MIN_WATER, Math.min(MAX_WATER, m)) : 30;
}

/**
 * The next multiple of `minutes` counted from midnight, strictly after now: lined up with the clock.
 * Every 30 means :00 and :30, every 45 means 0:00, 0:45, 1:30 ... The day starts again at midnight.
 */
function nextWater(now, minutes) {
  const step = cleanWaterMinutes(minutes) * 60000;
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const at = new Date(+midnight + (Math.floor((now - midnight) / step) + 1) * step);
  const tomorrow = new Date(midnight);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return at < tomorrow ? at : tomorrow;
}

/** 'HH:MM' from what the user typed ("9:05", "15:00", "3pm", "3:30 PM"), or null. */
function parseClock(text) {
  const match = /^\s*(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?m?\.?\s*$/i.exec(String(text || ''));
  if (!match) {
    return null;
  }
  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const half = match[3] && match[3].toLowerCase();
  if (half) {
    if (hour < 1 || hour > 12) {
      return null;
    }
    hour = (hour % 12) + (half === 'p' ? 12 : 0);
  } else if (match[2] === undefined) {
    return null; // a bare number is not a time of day
  }
  if (hour > 23 || minute > 59) {
    return null;
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** A lunch time kept as 'HH:MM' (the default if it cannot be read). */
function cleanLunchTime(time) {
  return parseClock(time) || LUNCH_TIME;
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

/**
 * A custom reminder as it is safe to keep and schedule, or null if it cannot be used.
 * Anything missing or out of range is fixed up rather than refused, except an empty message.
 */
function cleanCustom(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const text = typeof raw.text === 'string' ? raw.text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT) : '';
  if (!text) {
    return null;
  }
  const id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(raw.id) ? raw.id : newId();
  let days = Array.isArray(raw.days) ? [...new Set(raw.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : ALL_DAYS;
  if (days.length === 0) {
    days = ALL_DAYS;
  }
  const on = raw.on !== false;
  const style = cleanStyle(raw.style);
  if (raw.type === 'every') {
    const minutes = Math.round(Number(raw.minutes));
    return { id, text, type: 'every', minutes: Number.isFinite(minutes) ? Math.max(MIN_EVERY, Math.min(MAX_EVERY, minutes)) : 60, days: [...days], on, style };
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(typeof raw.time === 'string' ? raw.time.trim() : '');
  const hour = match ? Number(match[1]) : NaN;
  const minute = match ? Number(match[2]) : NaN;
  const time = hour <= 23 && minute <= 59 ? `${String(hour).padStart(2, '0')}:${match[2]}` : '09:00';
  return { id, text, type: 'daily', time, days: [...days], on, style };
}

/** 'web' or 'bubble' (anything else). */
function cleanStyle(style) {
  return style === 'web' ? 'web' : 'bubble';
}

/** How a reminder shows: a 'web' only when he is taken down and it asks for one, else a 'bubble'. */
function reminderRoute({ down, style }) {
  return down && style === 'web' ? 'web' : 'bubble';
}

/** A list of custom reminders, cleaned, without repeated ids, and no longer than MAX_CUSTOM. */
function cleanCustomList(list) {
  const out = [];
  const ids = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const r = cleanCustom(raw);
    if (r && out.length < MAX_CUSTOM) {
      if (ids.has(r.id)) {
        r.id = newId();
      }
      ids.add(r.id);
      out.push(r);
    }
  }
  return out;
}

function newId() {
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** The next moment strictly after now that a custom reminder is due, or null. */
function nextCustom(now, r) {
  const days = new Set(r.days && r.days.length ? r.days : ALL_DAYS);
  for (let ahead = 0; ahead <= 7; ahead++) {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() + ahead);
    if (!days.has(day.getDay())) {
      continue;
    }
    const at = new Date(day);
    if (r.type === 'every') {
      // The first multiple of r.minutes since midnight that is after now (midnight itself on later days).
      const step = ahead === 0 ? Math.floor((now - day) / (r.minutes * 60000)) + 1 : 0;
      at.setMinutes(step * r.minutes);
    } else {
      const [hour, minute] = r.time.split(':').map(Number);
      at.setHours(hour, minute, 0, 0);
    }
    if (at > now && at.getDate() === day.getDate()) {
      return at;
    }
  }
  return null;
}

/**
 * { at, items: [{ kind, text, id? }] } for the next moment any reminder that is switched on is due,
 * with every reminder due then, or null if none are on. options: { water, lunch, custom }.
 */
function nextReminders(now, options) {
  const candidates = [];
  const [lunchHour, lunchMinute] = cleanLunchTime(options.lunchTime).split(':').map(Number);
  const lunch = options.lunch ? nextDaily(now, lunchHour, lunchMinute) : null;
  if (lunch) {
    candidates.push({ at: lunch, item: { kind: 'lunch', text: TEXT.lunch } });
  }
  const water = options.water ? nextWater(now, options.waterMinutes || 30) : null;
  // Lunch replaces the water reminder that falls at the same moment.
  if (water && !(lunch && +lunch === +water)) {
    candidates.push({ at: water, item: { kind: 'water', text: TEXT.water } });
  }
  for (const r of options.custom || []) {
    const at = r.on ? nextCustom(now, r) : null;
    if (at) {
      candidates.push({ at, item: { kind: 'custom', text: r.text, id: r.id, style: cleanStyle(r.style) } });
    }
  }
  for (const o of options.once || []) {
    // Due while the computer slept: shown as soon as it is awake again, rather than lost.
    const at = new Date(Math.max(+o.at, +now + 1));
    candidates.push({ at, item: { kind: 'once', text: o.text, id: o.id } });
  }
  if (candidates.length === 0) {
    return null;
  }
  const first = Math.min(...candidates.map((c) => +c.at));
  return { at: new Date(first), items: candidates.filter((c) => +c.at === first).map((c) => c.item) };
}

/** { kind, at } for the next reminder that is switched on, or null if none are. */
function nextReminder(now, options) {
  const next = nextReminders(now, options);
  return next && { kind: next.items[0].kind, at: next.at };
}

/**
 * A one-off reminder from "in <minutes> <text>" or "at <time> <text>" (the words after "remind"),
 * as { at, text }, or null if it is not one. Minutes 1..1440; a time already past today means tomorrow.
 */
function parseOnce(words, now) {
  const inMatch = /^in\s+(\d+(?:\.\d+)?)\s*(?:m|min|mins|minutes?)?\s+(\S.*)$/i.exec(words);
  if (inMatch) {
    const minutes = Number(inMatch[1]);
    const text = inMatch[2].replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    if (minutes > 0 && minutes <= 24 * 60 && text) {
      return { at: new Date(+now + minutes * 60000), text };
    }
    return null;
  }
  const atMatch = /^at\s+(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m?\.?)?)\s+(\S.*)$/i.exec(words);
  if (atMatch) {
    const time = parseClock(atMatch[1]);
    const text = atMatch[2].replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    if (time && text) {
      const [hour, minute] = time.split(':').map(Number);
      return { at: nextDaily(now, hour, minute), text };
    }
  }
  return null;
}

/** "10:30 AM", in the system's own clock style. */
function clockTime(time) {
  const [hour, minute] = time.split(':').map(Number);
  return new Date(2000, 0, 1, hour, minute).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** When a custom reminder is due, in words: "Every day at 10:30 AM", "Every 45 minutes on weekdays". */
function describeCustom(r) {
  const days = r.days && r.days.length ? r.days : ALL_DAYS;
  const key = days.join(',');
  const on = key === ALL_DAYS.join(',') ? '' : key === '1,2,3,4,5' ? 'weekdays' : key === '0,6' ? 'weekends' : days.map((d) => DAY_NAMES[d]).join(', ');
  if (r.type === 'every') {
    const m = r.minutes;
    const every = m % 60 === 0 ? (m === 60 ? 'Every hour' : `Every ${m / 60} hours`) : `Every ${m} minutes`;
    return on ? `${every} on ${on}` : every;
  }
  return `${on ? 'On ' + on : 'Every day'} at ${clockTime(r.time)}`;
}

class ReminderClock {
  /**
   * options() returns { water, waterMinutes, lunch, lunchTime, custom, once }, read fresh each time.
   * onRemind({ kind, text }) is called for each reminder when it is due.
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
    this.next = nextReminders(this.now(), this.options());
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
    // Shown before looking ahead, so a one-off reminder is gone from options().once by then.
    if (late <= STALE_MS) {
      for (const item of due.items) {
        try {
          this.onRemind(item);
        } catch {
          // One reminder failing to show must not stop the clock.
        }
      }
    }
    this.start();
  }
}

module.exports = {
  TEXT, nextHalfHour, nextWater, nextDaily, parseClock, parseOnce, cleanWaterMinutes, cleanLunchTime, clockTime,
  WATER_CHOICES, MIN_WATER, MAX_WATER, LUNCH_TIME, nextReminder, nextReminders, nextCustom, cleanCustom, cleanCustomList, describeCustom,
  cleanStyle, reminderRoute,
  ReminderClock, STALE_MS, MAX_TEXT, MAX_CUSTOM, MIN_EVERY, MAX_EVERY,
};
