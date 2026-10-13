'use strict';
/*
 * Where everything lives: ~/.spidey-hang on every system (%USERPROFILE%\.spidey-hang on Windows).
 *
 * Not %APPDATA% on Windows: apps installed from the Microsoft Store have their AppData writes silently
 * redirected to a private copy, and so does anything they start. A Spidey started from such an app then
 * saw different settings from one started by the user. The profile folder is not redirected.
 *
 * SPIDEY_HANG_HOME overrides the folder. The tests use it so they never touch real settings.
 */
const os = require('os');
const path = require('path');

function dataDir() {
  return process.env.SPIDEY_HANG_HOME || path.join(os.homedir(), '.spidey-hang');
}

module.exports = {
  dataDir,
  settingsFile: () => path.join(dataDir(), 'settings.json'),
  logFile: () => path.join(dataDir(), 'log.txt'),
};
