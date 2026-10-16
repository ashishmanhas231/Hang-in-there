'use strict';
/*
 * The Reminders window: lists the user's reminders, adds and edits them, and switches the built-in
 * water and lunch reminders. Every change is saved straight away through window.reminders
 * (reminders-preload.js); main.js cleans and stores it, then sends back what it kept.
 */
(function () {
  const api = window.reminders;
  const $ = (id) => document.getElementById(id);
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // Monday first, as most calendars show the week.
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

  let state = { water: true, lunch: true, custom: [] };
  let editingId = null;
  let undo = null;

  // ---- Days picker ----------------------------------------------------------------------------

  for (const d of DAY_ORDER) {
    const label = document.createElement('label');
    label.className = 'day';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = String(d);
    box.checked = true;
    label.append(box, document.createTextNode(DAY_NAMES[d]));
    $('days').append(label);
  }
  const dayBoxes = () => [...$('days').querySelectorAll('input')];
  const pickedDays = () => dayBoxes().filter((b) => b.checked).map((b) => Number(b.value));
  const setDays = (days) => dayBoxes().forEach((b) => (b.checked = days.includes(Number(b.value))));

  document.querySelectorAll('[data-days]').forEach((button) =>
    button.addEventListener('click', () => setDays(button.dataset.days.split(',').map(Number))));

  // ---- Form -----------------------------------------------------------------------------------

  const typeValue = () => document.querySelector('input[name="type"]:checked').value;
  const styleValue = () => document.querySelector('input[name="style"]:checked').value;
  const setStyle = (style) => {
    document.querySelector(`input[name="style"][value="${style === 'web' ? 'web' : 'bubble'}"]`).checked = true;
  };

  function syncType() {
    // Dimmed rather than disabled, so clicking the other row's field still picks that row.
    const every = typeValue() === 'every';
    $('time').parentElement.classList.toggle('inactive', every);
    $('minutes').parentElement.classList.toggle('inactive', !every);
  }
  document.querySelectorAll('input[name="type"]').forEach((r) => r.addEventListener('change', syncType));
  // Clicking a field picks its row.
  $('time').addEventListener('focus', () => pick('daily'));
  $('minutes').addEventListener('focus', () => pick('every'));

  function pick(type) {
    document.querySelector(`input[name="type"][value="${type}"]`).checked = true;
    syncType();
  }

  function showError(message) {
    $('error').textContent = message;
    $('error').hidden = !message;
  }

  /** The form as a reminder, or null (with the reason shown) if it is not filled in right. */
  function readForm() {
    const text = $('text').value.trim();
    if (!text) {
      showError('Write a message for Spidey to say.');
      $('text').focus();
      return null;
    }
    const days = pickedDays();
    if (days.length === 0) {
      showError('Pick at least one day.');
      return null;
    }
    if (typeValue() === 'every') {
      const minutes = Number($('minutes').value);
      if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) {
        showError('Pick a number of minutes from 5 to 1440 (a day).');
        $('minutes').focus();
        return null;
      }
      return { text, type: 'every', minutes, days, style: styleValue() };
    }
    if (!/^\d{2}:\d{2}$/.test($('time').value)) {
      showError('Pick a time of day.');
      $('time').focus();
      return null;
    }
    return { text, type: 'daily', time: $('time').value, days, style: styleValue() };
  }

  function resetForm() {
    editingId = null;
    $('form').reset();
    $('time').value = '09:00';
    $('minutes').value = '60';
    setDays(DAY_ORDER);
    setStyle('bubble');
    syncType();
    showError('');
    $('form-title').textContent = 'Add a reminder';
    $('submit').textContent = 'Add reminder';
    $('cancel').hidden = true;
  }

  function startEdit(r) {
    editingId = r.id;
    $('text').value = r.text;
    pick(r.type);
    if (r.type === 'every') {
      $('minutes').value = String(r.minutes);
    } else {
      $('time').value = r.time;
    }
    setDays(r.days);
    setStyle(r.style);
    showError('');
    $('form-title').textContent = 'Edit reminder';
    $('submit').textContent = 'Save changes';
    $('cancel').hidden = false;
    $('form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    $('text').focus();
  }

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = readForm();
    if (!r) {
      return;
    }
    const custom = editingId
      ? state.custom.map((c) => (c.id === editingId ? { ...c, ...r } : c))
      : [...state.custom, { ...r, on: true }];
    await save({ ...state, custom });
    resetForm();
  });

  $('cancel').addEventListener('click', resetForm);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && editingId) {
      resetForm();
    }
  });

  $('try').addEventListener('click', () => {
    const text = $('text').value.trim();
    if (!text) {
      showError('Write a message first, then Spidey can say it.');
      $('text').focus();
      return;
    }
    showError('');
    api.test({ text, style: styleValue() });
  });

  // ---- List -----------------------------------------------------------------------------------

  function button(label, className, onClick, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = label;
    if (title) {
      b.title = title;
      b.setAttribute('aria-label', title);
    }
    b.addEventListener('click', onClick);
    return b;
  }

  function render() {
    const list = $('list');
    list.replaceChildren();
    for (const r of state.custom) {
      const li = document.createElement('li');
      li.className = 'card item' + (r.on ? '' : ' off');

      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = r.on;
      toggle.title = r.on ? 'On (click to switch off)' : 'Off (click to switch on)';
      toggle.setAttribute('aria-label', `${r.text}: ${r.on ? 'on' : 'off'}`);
      toggle.addEventListener('change', () =>
        save({ ...state, custom: state.custom.map((c) => (c.id === r.id ? { ...c, on: toggle.checked } : c)) }));

      const words = document.createElement('div');
      words.className = 'words';
      const text = document.createElement('div');
      text.className = 'text';
      text.textContent = r.text;
      const when = document.createElement('div');
      when.className = 'when-text';
      when.textContent = r.summary + (r.style === 'web' ? ' · Big web' : '') + (r.on ? '' : ' · off');
      words.append(text, when);

      const tools = document.createElement('div');
      tools.className = 'tools';
      tools.append(
        button('Show', 'small', () => api.test({ text: r.text, style: r.style }), `Show "${r.text}" now`),
        button('Edit', 'small', () => startEdit(r), `Edit "${r.text}"`),
        button('Delete', 'small danger', () => remove(r), `Delete "${r.text}"`)
      );

      li.append(toggle, words, tools);
      list.append(li);
    }
    $('empty').hidden = state.custom.length > 0;
    $('water').checked = state.water;
    $('lunch').checked = state.lunch;
    if (undo) {
      list.append(undo.el);
    }
  }

  async function remove(r) {
    const before = state.custom;
    if (editingId === r.id) {
      resetForm();
    }
    await save({ ...state, custom: before.filter((c) => c.id !== r.id) });
    const el = document.createElement('li');
    el.className = 'undo';
    el.append(document.createTextNode(`Deleted "${r.text}". `), button('Undo', 'link', async () => {
      clearUndo();
      await save({ ...state, custom: before });
    }));
    clearUndo();
    undo = { el, timer: setTimeout(() => { clearUndo(); render(); }, 8000) };
    render();
  }

  function clearUndo() {
    if (undo) {
      clearTimeout(undo.timer);
      undo = null;
    }
  }

  $('water').addEventListener('change', () => save({ ...state, water: $('water').checked }));
  $('lunch').addEventListener('change', () => save({ ...state, lunch: $('lunch').checked }));

  // ---- Saving ---------------------------------------------------------------------------------

  async function save(next) {
    try {
      state = await api.save(next);
    } catch (err) {
      showError('Could not save: ' + err.message);
    }
    render();
  }

  api.onChanged((next) => {
    state = next;
    render();
  });

  resetForm();
  api.get().then((s) => {
    state = s;
    render();
  });
})();
