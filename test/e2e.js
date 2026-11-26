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

// Chromium's sandbox refuses to run as root (CI containers). SPIDEY_E2E_FLAGS adds Chromium switches,
// e.g. --force-prefers-reduced-motion to run the checks the way a CI machine with reduced motion does.
const extra = [
  ...(process.platform === 'linux' && process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : []),
  ...(process.env.SPIDEY_E2E_FLAGS || '').split(/\s+/).filter(Boolean),
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logText = () => (fs.existsSync(path.join(home, 'log.txt')) ? fs.readFileSync(path.join(home, 'log.txt'), 'utf8') : '');
// What the overlay printed to stderr, shown when a check fails: if it cannot start at all (no display,
// no usable sandbox), its log stays empty and this is the only place the reason appears.
let appStderr = '';

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    const stderr = appStderr.trim() ? `\n--- overlay stderr ---\n${appStderr.trim().split('\n').slice(-40).join('\n')}` : '';
    console.log(`not ok - ${name}\n  ${err.message}\n--- log ---\n${logText()}${stderr}`);
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

/** Closes the bubble showing and any waiting their turn (the next one shows 0.5 s after one closes). */
async function clearBubbles() {
  for (let i = 0; i < 5; i++) {
    await ipc.send('dismiss');
    await sleep(700);
  }
}

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

  const app = spawn(electron, [...extra, APP], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  app.stderr.on('data', (chunk) => {
    appStderr = (appStderr + chunk).slice(-20000);
  });
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

    await check('swing across: web to web to the other side, and the new spot is saved', async () => {
      const saved = () => JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).AnchorFraction;
      const before = saved();
      await ipc.send('travel');
      // With the system's reduced-motion setting on (as on some CI machines) he glides across instead.
      await logHas(/(Swinging across|Gliding across \(reduced motion\)): web from \d+ to \d+/);
      await logHas(/Swung across: web now at \d+/);
      await waitFor('the new spot saved', () => Math.abs(saved() - before) > 0.3);
    });

    await check('web-swing to a chosen spot: he lands there and the spot is saved', async () => {
      const saved = () => JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).AnchorFraction;
      const landings = () => (logText().match(/Swung across: web now at/g) || []).length;
      const before = landings();
      await ipc.send('web 0.3');
      await logHas(/Web-swing to 0\.3 \(\d+\)/);
      await waitFor('the landing', () => landings() > before, 12000);
      await waitFor('the new spot saved', () => Math.abs(saved() - 0.3) < 0.02);
      await ipc.send('web nowhere');
      await sleep(300);
      assert.doesNotMatch(logText(), /Web-swing to nowhere/);
    });

    await check('antics: wiggle, bungee, swing, a line in his bubble, a short web-hop', async () => {
      // An antic is skipped while a bubble shows or he is still on his way. With reduced motion (GitHub's
      // macOS and Windows runners) the last check's glide keeps his window moving for a few seconds after
      // he has landed, and longer on a slow machine: a frame counts for at most 0.05 s, so under 20 frames
      // a second the glide runs slower than the clock. So each antic is asked for again while he is busy,
      // and must run within the time allowed.
      const anticRuns = (kind) => waitFor(`antic ${kind} to run, not be skipped`, async () => {
        const from = logText().length;
        await ipc.send(`antic ${kind}`);
        await waitFor(`log line Antic: ${kind}`, () => logText().slice(from).includes(`Antic: ${kind}`));
        await sleep(600); // time for the page to say it skipped it
        return !logText().slice(from).includes(`Antic ${kind} skipped`);
      }, 15000);
      await ipc.send('dismiss');
      for (const kind of ['wiggle', 'bungee', 'swing']) {
        await anticRuns(kind);
        await sleep(kind === 'bungee' ? 2600 : 300);
      }
      const bubbles = (logText().match(/Reminder shown \(bubble\)/g) || []).length;
      await ipc.send('antic say');
      await waitFor('his line', () => (logText().match(/Reminder shown \(bubble\)/g) || []).length > bubbles);
      await clearBubbles();
      const hops = (logText().match(/Swung across: web now at/g) || []).length;
      await ipc.send('antic web');
      await waitFor('the hop', () => (logText().match(/Swung across: web now at/g) || []).length > hops, 12000);
    });

    await check('dozing and waking: z\'s while away, then a greeting, and the day is kept', async () => {
      await sleep(600);
      await ipc.send('sleep');
      await logHas(/Dozing \(the sleep command\)/);
      await logHas(/Dozing off/);
      await ipc.send('wake');
      await logHas(/Woke up/);
      await logHas(/Greeting: (Good morning!|Good afternoon!|Good evening!|Up late\? Me too!)/);
      await waitFor('the day saved', () => /^\d{4}-\d{2}-\d{2}$/.test(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).LastGreeting));
      await ipc.send('greet');
      await waitFor('a second greeting', () => (logText().match(/Greeting: /g) || []).length >= 2);
      await clearBubbles();
    });

    await check('focus timer: start, skip to the break, stop', async () => {
      await ipc.send('focus start 1');
      await logHas(/Focus started: Focus: 1 min left/);
      await ipc.send('focus skip');
      await logHas(/Reminder \(focus\): Focus done! Take a 5 minute break\./);
      await ipc.send('focus status');
      await logHas(/Focus status: Break: 5 min left \(1 focus done\)/);
      await ipc.send('focus stop');
      await logHas(/Focus stopped/);
      await clearBubbles();
    });

    await check('a one-off reminder ("remind in") is shown when due, once', async () => {
      await ipc.send('remind in 0.02 Tea is ready');
      await logHas(/One-off reminder at .+: Tea is ready/);
      await logHas(/Reminder \(once\): Tea is ready/);
      await sleep(1500);
      assert.equal(logText().match(/Reminder \(once\): Tea is ready/g).length, 1);
      await clearBubbles();
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

    await check('breeze on and off, and metrics writes CPU, memory and frames to the log', async () => {
      await ipc.send('breeze on');
      await logHas(/Breeze: true/);
      await ipc.send('metrics 1');
      await logHas(/Metrics over [\d.]+ s: CPU [\d.]+%, memory \d+ MB, processes \d+ \(.+\), page heap ([\d.]+ MB|-), frames \d+/);
      await ipc.send('breeze off');
      await logHas(/Breeze: false/);
    });

    await check('while he is up, every reminder is a bubble, even a Big web one', async () => {
      await ipc.send('dismiss');
      const bubbles = () => (logText().match(/Reminder shown \(bubble\)/g) || []).length;
      const before = bubbles();
      await ipc.send('remind-web Up here it is a bubble');
      await logHas(/Reminder \(note\): Up here it is a bubble/);
      await waitFor('a bubble', () => bubbles() > before, 15000);
      assert.doesNotMatch(logText(), /Reminder shown \(web\)/);
      await ipc.send('dismiss');
    });

    await check('take him down: he climbs out and his window closes; the app keeps running', async () => {
      await ipc.send('down');
      await logHas(/Taken down: he climbs out/);
      await logHas(/Climbed out/);
      await logHas(/Window closed/);
      assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).Down, true);
      assert.equal(await ipc.send('ping'), true);
    });

    await check('taken down, a bubble reminder: he drops in, says it, climbs out, the window closes', async () => {
      const closed = (logText().match(/Window closed/g) || []).length;
      await ipc.send('remind Drink some water');
      await logHas(/Visit: he drops in for a reminder \(bubble\)/);
      await logHas(/Dropped in/);
      await logHas(/Reminder shown \(bubble\)/);
      await ipc.send('dismiss');
      await waitFor('the window to close again', () => (logText().match(/Window closed/g) || []).length > closed, 10000);
    });

    await check('taken down, a Big web reminder: three webs in the middle, then he climbs out', async () => {
      const closed = (logText().match(/Window closed/g) || []).length;
      await ipc.send('remind-web Stand up and stretch');
      await logHas(/Visit: he drops in for a reminder \(web\)/);
      await logHas(/big web/);
      await logHas(/Reminder shown \(web\)/);
      await sleep(2500); // the three webs land and the text is written
      const file = path.join(home, 'web.png');
      await ipc.send(`snapshot ${file}`);
      await waitFor('snapshot of the webs', () => fs.existsSync(file));
      await ipc.send('dismiss');
      await waitFor('the window to close again', () => (logText().match(/Window closed/g) || []).length > closed, 10000);
    });

    await check('bring him back: he drops in and stays', async () => {
      const looks = (logText().match(/Look: /g) || []).length;
      await ipc.send('up');
      await logHas(/Brought back/);
      await waitFor('his look', () => (logText().match(/Look: /g) || []).length > looks);
      await logHas(/Dropped in/);
      assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).Down, false);
    });

    await check('a reminder due as he climbs out: he comes back down for it, then the one window closes', async () => {
      const closed = (logText().match(/Window closed/g) || []).length;
      await ipc.send('down');
      await ipc.send('remind Just one more thing');
      await logHas(/Visit: he comes back down for a reminder/);
      await waitFor('the reminder', () => /Just one more thing[\s\S]*Reminder shown \(bubble\)/.test(logText()), 10000);
      await sleep(400);
      await ipc.send('dismiss');
      await waitFor('the window to close', () => (logText().match(/Window closed/g) || []).length > closed, 10000);
      await ipc.send('up');
      await logHas(/Brought back[\s\S]*Brought back/);
    });

    await check('hide him: he climbs out, reminders become notifications, show brings him back', async () => {
      const closed = (logText().match(/Window closed/g) || []).length;
      await ipc.send('hide 5');
      await logHas(/Hidden for 5 min; reminders become notifications/);
      await waitFor('the window to close', () => (logText().match(/Window closed/g) || []).length > closed, 10000);
      await ipc.send('remind While you were out');
      await logHas(/Reminder \(note\): While you were out \[hidden: notification\]/);
      const looks = (logText().match(/Look: /g) || []).length;
      await ipc.send('show');
      await logHas(/Shown again/);
      await waitFor('his look', () => (logText().match(/Look: /g) || []).length > looks);
      assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).Down, false);
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
