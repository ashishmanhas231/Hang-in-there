'use strict';
/*
 * End-to-end test: starts the real overlay (Electron) with a throwaway ~/.spidey-hang, drives it over
 * the command channel, and checks its log and the pictures it saves. Then runs the offline test
 * renders.
 *
 *   npm run test:e2e          (needs a display; on Linux CI use xvfb-run)
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const APP = ROOT; // electron . runs package.json "main"
const electron = process.env.ELECTRON_PATH || require('electron');
const fixtures = require('./fixtures.js');
const heroes = require(path.join(__dirname, '..', 'src/lib/heroes.js'));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spidey-e2e-'));
const env = { ...process.env, SPIDEY_HANG_HOME: home };
delete env.ELECTRON_RUN_AS_NODE;
process.env.SPIDEY_HANG_HOME = home;
const ipc = require(path.join(ROOT, 'src/lib/ipc.js'));

// Chromium's sandbox refuses to run as root (CI containers).
const extra = process.platform === 'linux' && process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logText = () => (fs.existsSync(path.join(home, 'log.txt')) ? fs.readFileSync(path.join(home, 'log.txt'), 'utf8') : '');

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.log(`not ok - ${name}\n  ${err.message}\n--- log ---\n${logText()}`);
    process.exitCode = 1;
    throw err;
  }
}

async function waitFor(what, test, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const logHas = (pattern) => waitFor(`log line ${pattern}`, () => pattern.test(logText()));

function isPng(file) {
  const head = fs.readFileSync(file).subarray(0, 4);
  return head[0] === 0x89 && head.toString('ascii', 1, 4) === 'PNG';
}

async function main() {
  // A hero folder for the offline renders, and one whose picture is broken.
  const testHero = path.join(home, 'Test hero');
  fs.mkdirSync(testHero, { recursive: true });
  fs.writeFileSync(path.join(testHero, 'hang.png'), fixtures.person([40, 160, 90, 255]).flipVertical().png());
  fs.writeFileSync(path.join(testHero, 'swing.png'), fixtures.person([40, 90, 200, 255]).flipVertical().png());
  const brokenHero = path.join(home, 'Broken hero');
  fs.mkdirSync(brokenHero, { recursive: true });
  fs.writeFileSync(path.join(brokenHero, 'hang.png'), 'not a picture');
  const bundled = heroes.scan().map((h) => h.name);

  const app = spawn(electron, [...extra, APP], { env, stdio: 'ignore' });
  let exited = null;
  app.on('exit', (code) => (exited = code));
  try {
    await check('starts and answers on the command channel', async () => {
      await waitFor('the overlay', () => ipc.send('ping'), 20000);
      await logHas(/Layout: screen/);
      // A fresh start shows the bundled iconic pose, or the drawing in a build without one.
      await logHas(bundled.length ? /Look: Iconic Spidey - Upside Down \(hang\), line web/ : /Look: drawn Spider-Man/);
    });

    await check('a second launch does not start a second overlay', async () => {
      const second = spawnSync(electron, [...extra, APP, '--push', '0.5'], { env, timeout: 20000 });
      assert.equal(second.status, 0);
      assert.equal(await ipc.send('ping'), true);
    });

    await check('swing on his own moves the web in from the edge and saves the spot', async () => {
      await ipc.send('swing on');
      await logHas(/Swing on his own: true/);
      await logHas(/Moved the web in from the screen edge/);
      await waitFor('the saved spot', () => JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).AnchorFraction < 0.88);
      await ipc.send('swing off');
    });

    await check('snapshot saves what he draws', async () => {
      const file = path.join(home, 'snap.png');
      await ipc.send(`snapshot ${file}`);
      await waitFor('snapshot', () => fs.existsSync(file));
      assert.ok(isPng(file));
      await ipc.send(`snapshot ${path.join(home, 'snap.txt')}`);
      await logHas(/Snapshot refused, not a \.png path/);
    });

    for (const name of bundled) {
      await check(`${name} hangs from his web`, async () => {
        await ipc.send(`hero ${name}`);
        await logHas(new RegExp(`Look: ${name} \\((hang|hang, swing)\\), line web`));
      });
    }

    await check('a hero from an older version (gone now) falls back to the default', async () => {
      await ipc.send('hero My picture');
      await logHas(bundled.length ? /No "My picture" hero any more, so Iconic Spidey - Upside Down is shown/ : /No "My picture" hero in this build/);
    });

    await check('a reminder is shown and logged', async () => {
      await ipc.send('remind water');
      await logHas(/Reminder \(water\): Time to drink some water/);
    });

    await check('the Reminders window opens from a command, and only once', async () => {
      await ipc.send('reminders');
      await logHas(/Reminders window opened/);
      await ipc.send('reminders');
      await sleep(500);
      assert.equal(logText().match(/Reminders window opened/g).length, 1);
    });

    await check('the drawing, hero rotation on and off, next hero, stats, reset', async () => {
      await ipc.send('hero Drawn Spider-Man');
      await logHas(/Look: drawn Spider-Man/);
      await ipc.send('rotate 5');
      await logHas(/Change hero every: 5 min/);
      await ipc.send('rotate 0');
      await ipc.send('hero next');
      await logHas(bundled.length ? new RegExp(`Hero: ${bundled[0]}`) : /Hero: Drawn Spider-Man\n[\s\S]*Hero: Drawn Spider-Man/);
      await ipc.send('stats');
      await logHas(/Frames: \d+/);
      await ipc.send('reset');
    });

    await check('start automatically wrote a sign-in entry (under the test folder, never the real one)', async () => {
      await logHas(/Start automatically: on/);
      const where = process.platform === 'darwin' ? path.join(home, 'Library', 'LaunchAgents', 'com.spideyhang.overlay.plist')
        : process.platform === 'linux' ? path.join(home, '.config', 'autostart', 'spidey-hang.desktop')
        : null;
      if (where) {
        assert.ok(fs.existsSync(where), `missing ${where}`);
      } else {
        await logHas(/test mode: the Windows registry is not touched/);
      }
    });

    await check('exit closes him', async () => {
      await ipc.send('exit');
      await waitFor('exit', () => exited !== null);
      assert.equal(exited, 0);
      assert.equal(await ipc.send('ping', 300), false);
    });
  } finally {
    if (exited === null) app.kill();
  }

  // ---- Offline renders ------------------------------------------------------------------------
  const render = (args) => spawnSync(electron, [...extra, APP, ...args], { env, timeout: 60000, encoding: 'utf8' });

  await check('--snapshot of the drawing, a hero folder and a long swing', async () => {
    const cases = [
      ['drawn', ['1.5', '1']],
      ['hero', ['2', '1.5', testHero]],
      ['swing', ['20', '0.8', '-', '-', 'swing']],
    ];
    for (const [name, args] of cases) {
      const out = path.join(home, `snapshot-${name}.png`);
      const r = render(['--snapshot', out, ...args]);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(isPng(out));
    }
    const poses = new Set(fs.readFileSync(path.join(home, 'snapshot-hero.png.log'), 'utf8').trim().split('\n').slice(1).map((l) => l.trim().split(/\s+/)[2]));
    assert.ok(poses.has('swing') && poses.has('hang'), `poses seen: ${[...poses]}`);
    const swing = fs.readFileSync(path.join(home, 'snapshot-swing.png.log'), 'utf8').trim().split('\n').slice(-120);
    const peak = Math.max(...swing.map((l) => Math.abs(Number(l.trim().split(/\s+/)[3]))));
    assert.ok(peak > 15 && peak < 40, `steady swing peak ${peak}`);
  });

  await check('--snapshot refuses a broken picture with a clear error', async () => {
    const r = render(['--snapshot', path.join(home, 'bad.png'), '1', '0', brokenHero]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not a picture this app can read/);
  });

  await check('--export-figure', async () => {
    const out = path.join(home, 'figure-export.png');
    assert.equal(render(['--export-figure', out]).status, 0);
    assert.ok(isPng(out));
  });

  console.log(`\n${passed} end-to-end checks passed. Files in ${home}`);
}

main().catch(() => {
  process.exitCode = 1;
});
