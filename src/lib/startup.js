'use strict';
/*
 * Starting at sign-in.
 *
 *   Windows  a "Spidey Hang" value in HKCU\Software\Microsoft\Windows\CurrentVersion\Run.
 *            It shows in Task Manager > Startup apps.
 *   macOS    a LaunchAgent, ~/Library/LaunchAgents/com.spideyhang.overlay.plist.
 *            It shows in System Settings > General > Login Items.
 *   Linux    ~/.config/autostart/spidey-hang.desktop.
 *
 * The app calls sync() each time it starts, so the entry always points at the copy that is running.
 * Plain Node, no Electron, so the unit tests can run it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const log = require('./log');

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE_NAME = 'Spidey Hang';
const AGENT_LABEL = 'com.spideyhang.overlay';

/** Quotes one argument for a Windows command line. */
function winQuote(arg) {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/** The command line Windows runs at sign-in. */
function windowsCommand(launch) {
  return [launch.exe, ...launch.args].map(winQuote).join(' ');
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function macPlist(launch) {
  const args = [launch.exe, ...launch.args].map((a) => `    <string>${xml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
</dict>
</plist>
`;
}

function linuxDesktopEntry(launch) {
  const exec = [launch.exe, ...launch.args].map((a) => (/[\s"\\]/.test(a) ? `"${a.replace(/(["\\`$])/g, '\\$1')}"` : a)).join(' ');
  return `[Desktop Entry]\nType=Application\nName=Spidey Hang\nExec=${exec}\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n`;
}

/** Writes a file only if its content changes. Returns true if it changed. */
function writeIfChanged(file, content) {
  try {
    if (fs.readFileSync(file, 'utf8') === content) {
      return false;
    }
  } catch {
    // Not there yet.
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return true;
}

function removeIfThere(file) {
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    return true;
  }
  return false;
}

function defaultReg(args) {
  return execFileSync('reg', args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

function readRunValue(reg) {
  try {
    const out = reg(['query', RUN_KEY, '/v', VALUE_NAME]);
    const line = out.split(/\r?\n/).find((l) => l.includes('REG_SZ') && l.includes(VALUE_NAME));
    return line ? line.slice(line.indexOf('REG_SZ') + 'REG_SZ'.length).trim() : null;
  } catch {
    return null; // not there
  }
}

/**
 * Adds, corrects or removes the sign-in entry to match the setting. Logs only real changes.
 * launch: { exe, args } to run at sign-in. options (for tests): { platform, home, reg }.
 */
function sync(on, launch, options = {}) {
  const platform = options.platform || process.platform;
  // With SPIDEY_HANG_HOME set (the tests), never touch the real sign-in settings: macOS and Linux
  // entries go under that folder instead, and the Windows registry is left alone.
  const testing = Boolean(process.env.SPIDEY_HANG_HOME) && !options.reg;
  const home = options.home || (testing ? process.env.SPIDEY_HANG_HOME : os.homedir());
  try {
    if (platform === 'win32' && testing) {
      log.write(`Start automatically: ${on ? 'on' : 'off'} (test mode: the Windows registry is not touched).`);
    } else if (platform === 'win32') {
      const reg = options.reg || defaultReg;
      const current = readRunValue(reg);
      if (on) {
        const wanted = windowsCommand(launch);
        if (!current || current.toLowerCase() !== wanted.toLowerCase()) {
          reg(['add', RUN_KEY, '/v', VALUE_NAME, '/t', 'REG_SZ', '/d', wanted, '/f']);
          log.write(`Start automatically: on. Windows will run ${wanted} at sign-in.`);
        }
      } else if (current !== null) {
        reg(['delete', RUN_KEY, '/v', VALUE_NAME, '/f']);
        log.write('Start automatically: off. Removed from Windows sign-in.');
      }
    } else if (platform === 'darwin') {
      const file = path.join(home, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
      if (on) {
        if (writeIfChanged(file, macPlist(launch))) {
          log.write(`Start automatically: on. macOS will run ${launch.exe} at sign-in (${file}).`);
        }
      } else if (removeIfThere(file)) {
        log.write('Start automatically: off. Removed the login item.');
      }
    } else {
      const file = path.join((!testing && process.env.XDG_CONFIG_HOME) || path.join(home, '.config'), 'autostart', 'spidey-hang.desktop');
      if (on) {
        if (writeIfChanged(file, linuxDesktopEntry(launch))) {
          log.write(`Start automatically: on (${file}).`);
        }
      } else if (removeIfThere(file)) {
        log.write('Start automatically: off. Removed the autostart entry.');
      }
    }
  } catch (err) {
    log.write('Could not change starting at sign-in: ' + err.message);
  }
}

module.exports = { sync, windowsCommand, macPlist, linuxDesktopEntry, RUN_KEY, VALUE_NAME, AGENT_LABEL };
