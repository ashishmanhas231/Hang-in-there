'use strict';
/*
 * The bridge for the Reminders window. The page gets window.reminders and nothing else; no Node.
 *   get()          -> { water, lunch, custom: [...] } with a "summary" on each custom reminder
 *   save(state)    -> the same, as saved (main.js cleans what it is given)
 *   test(text)     shows that text in his speech bubble now
 *   onChanged(fn)  fn(state) when the reminders change somewhere else (his menu)
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('reminders', {
  get: () => ipcRenderer.invoke('reminders:get'),
  save: (state) => ipcRenderer.invoke('reminders:save', state),
  test: (text) => ipcRenderer.invoke('reminders:test', text),
  onChanged(fn) {
    ipcRenderer.on('reminders:changed', (_event, state) => fn(state));
  },
});
