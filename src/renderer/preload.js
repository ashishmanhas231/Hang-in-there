'use strict';
/*
 * The only bridge between the overlay page and the main process. The page gets window.spidey with
 * on(channel, handler) and send(channel, data), limited to the channels below. No Node in the page.
 */
const { contextBridge, ipcRenderer } = require('electron');

const IN = new Set(['setup', 'look', 'flags', 'push', 'snapshot', 'stats', 'test', 'cursor', 'remind']);
const OUT = new Set(['ready', 'ignore-mouse', 'menu', 'move-window', 'anchor-dropped', 'problem', 'log', 'snapshot-data', 'test-done']);

const mode = new URLSearchParams(location.search).get('mode') || 'hang';

contextBridge.exposeInMainWorld('spidey', {
  mode,
  on(channel, handler) {
    if (IN.has(channel)) {
      ipcRenderer.on(channel, (_event, data) => handler(data));
    }
  },
  send(channel, data) {
    if (OUT.has(channel)) {
      ipcRenderer.send(channel, data);
    }
  },
});
