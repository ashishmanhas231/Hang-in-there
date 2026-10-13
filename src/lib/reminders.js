'use strict';
/*
 * Reminders: "drink water" on every half hour of the clock, "lunch" every day at 3:00 PM.
 * When both fall on the same moment (3:00 PM), only lunch is shown.
 *
 * Custom reminders (settings.CustomReminders), made in the Reminders window:
 *   { id, text, type: 'daily', time: 'HH:MM', days, on }      at that time of day
 *   { id, text, type: 'every', minutes: N, days, on }         every N minutes, counted from midnight
 * days lists the weekdays it runs on (0 = Sunday ... 6 = Saturday); all seven means every day.
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

const LUNCH_HOUR = 15;
const LUNCH_MINUTE = 0;
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
  if (raw.type === 'every') {
    const minutes = Math.round(Number(raw.minutes));
    return { id, text, type: 'every', minutes: Number.isFinite(minutes) ? Math.max(MIN_EVERY, Math.min(MAX_EVERY, minutes)) : 60, days: [...days], on };
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(typeof raw.time === 'string' ? raw.time.trim() : '');
  const hour = match ? Number(match[1]) : NaN;
  const minute = match ? Number(match[2]) : NaN;
  const time = hour <= 23 && minute <= 59 ? `${String(hour).padStart(2, '0')}:${match[2]}` : '09:00';
  return { id, text, type: 'daily', time, days: [...days], on };
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
  const lunch = options.lunch ? nextDaily(now, LUNCH_HOUR, LUNCH_MINUTE) : null;
  if (lunch) {
    candidates.push({ at: lunch, item: { kind: 'lunch', text: TEXT.lunch } });
  }
  const water = options.water ? nextHalfHour(now) : null;
  // Lunch replaces the water reminder that falls at the same moment.
  if (water && !(lunch && +lunch === +water)) {
    candidates.push({ at: water, item: { kind: 'water', text: TEXT.water } });
  }
  for (const r of options.custom || []) {
    const at = r.on ? nextCustom(now, r) : null;
    if (at) {
      candidates.push({ at, item: { kind: 'custom', text: r.text, id: r.id } });
    }
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
   * options() returns { water, lunch, custom }, read fresh each time.
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
    this.start();
    if (late <= STALE_MS) {
      for (const item of due.items) {
        this.onRemind(item);
      }
    }
  }
}

module.exports = {
  TEXT, nextHalfHour, nextDaily, nextReminder, nextReminders, nextCustom, cleanCustom, cleanCustomList, describeCustom,
  ReminderClock, STALE_MS, MAX_TEXT, MAX_CUSTOM, MIN_EVERY, MAX_EVERY,
};
