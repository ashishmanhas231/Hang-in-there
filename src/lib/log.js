'use strict';
/** Appends to ~/.spidey-hang/log.txt. Starts the file again past 256 KB. Never throws. */
const fs = require('fs');
const paths = require('./paths');

const MAX_BYTES = 256 * 1024;

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function write(message) {
  try {
    fs.mkdirSync(paths.dataDir(), { recursive: true });
    const file = paths.logFile();
    try {
      if (fs.statSync(file).size > MAX_BYTES) {
        fs.unlinkSync(file);
      }
    } catch {
      // No log yet.
    }
    fs.appendFileSync(file, `${stamp()}  ${message}\n`);
  } catch {
    // Logging must never crash the overlay.
  }
}

module.exports = { write };
