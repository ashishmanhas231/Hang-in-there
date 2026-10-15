'use strict';
/*
 * "npm run dist", "dist:win", "dist:mac" and "dist:linux": runs electron-builder with the given
 * arguments, then starts the app that was just built, so Spidey appears as soon as the build is done.
 * electron-builder only writes the installer; this starts the unpacked copy it builds on the way
 * (dist/win-unpacked on Windows, dist/mac-arm64 or dist/mac on a Mac, dist/linux-unpacked on Linux).
 *
 * A Spidey that is already running (an older installed copy, or the last build) is closed first,
 * because only one runs at a time and a second start would just give the old one a swing.
 *
 * Skipped on CI (CI is set), where there is no one to see him and he would keep the job from ending,
 * and when SPIDEY_NO_LAUNCH is set.
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PRODUCT = 'Spidey Hang';
const DIST = path.join(__dirname, '..', 'dist');

/**
 * The executable of the build for this system in distDir, or null. On a Mac the one for this
 * processor is preferred (mac-arm64 or mac-universal on Apple silicon, mac or mac-universal on Intel).
 */
function findBuiltApp(distDir, platform = process.platform, arch = process.arch) {
  const exists = (p) => fs.existsSync(p);
  if (platform === 'win32') {
    const exe = path.join(distDir, 'win-unpacked', `${PRODUCT}.exe`);
    return exists(exe) ? exe : null;
  }
  if (platform === 'darwin') {
    const dirs = arch === 'arm64' ? ['mac-arm64', 'mac-universal'] : ['mac', 'mac-x64', 'mac-universal'];
    for (const dir of dirs) {
      const exe = path.join(distDir, dir, `${PRODUCT}.app`, 'Contents', 'MacOS', PRODUCT);
      if (exists(exe)) {
        return exe;
      }
    }
    return null;
  }
  const exe = path.join(distDir, 'linux-unpacked', 'spidey-hang');
  return exists(exe) ? exe : null;
}

/** The .app folder an executable inside Contents/MacOS belongs to. */
const appBundleOf = (exe) => path.resolve(exe, '..', '..', '..');

function main() {
  const builder = spawnSync(process.execPath, [require.resolve('electron-builder/cli.js'), ...process.argv.slice(2)], { stdio: 'inherit' });
  if (builder.status !== 0) {
    process.exit(builder.status === null ? 1 : builder.status);
  }

  if (process.env.CI || process.env.SPIDEY_NO_LAUNCH) {
    console.log('Build done. Not starting Spidey (CI or SPIDEY_NO_LAUNCH is set).');
    return;
  }
  const exe = findBuiltApp(DIST);
  if (!exe) {
    console.log(`Build done, but no unpacked ${PRODUCT} for this system was found in ${DIST}, so Spidey was not started.`);
    return;
  }

  // Close any Spidey that is already running. With nothing running this returns straight away.
  spawnSync(exe, ['--exit'], { stdio: 'ignore', timeout: 15000 });

  // Give the old one a moment to let go of the single-instance lock before the new one starts.
  setTimeout(() => {
    console.log(`Starting ${exe}`);
    const child = process.platform === 'darwin'
      ? spawn('open', ['-n', appBundleOf(exe)], { detached: true, stdio: 'ignore' })
      : spawn(exe, [], { detached: true, stdio: 'ignore' });
    child.on('error', (err) => console.error(`Could not start Spidey: ${err.message}`));
    child.unref();
  }, 1500);
}

if (require.main === module) {
  main();
}

module.exports = { findBuiltApp };
