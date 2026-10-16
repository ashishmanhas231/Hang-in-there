'use strict';
/*
 * "npm run perf": how much CPU and memory Spidey uses, case by case, measured on the real app.
 *
 * Starts a throwaway copy of the app (its own ~/.spidey-hang and Chromium profile, so it runs beside
 * an installed copy) at the sizes most people see most: Large, a Long rope, the "Both" hero. It then
 * drives it over the command channel and reads the "metrics" lines it writes to its log (main.js).
 *
 *   npm run perf                        every case, about two minutes
 *   npm run perf -- --long              also 90 s of breeze, to see whether memory keeps growing
 *   npm run perf -- --label before      a name for this run in the results
 *   npm run perf -- --hero "Iron Spider - Web Swing"
 *   SPIDEY_APP=<another checkout> npm run perf     measure that copy instead (say, the code before a
 *                                                   change, from git worktree add), with this script
 *
 * He appears on screen while it runs. Don't touch him or his menu meanwhile: that is not what is
 * being measured. Results go to perf-<label>.json in the throwaway folder, printed at the end.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const APP = process.env.SPIDEY_APP ? path.resolve(process.env.SPIDEY_APP) : ROOT;
const electron = process.env.ELECTRON_PATH || require('electron');

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const LABEL = option('--label', path.basename(APP));
const HERO = option('--hero', 'Iconic Spidey - Both');
const LONG = argv.includes('--long');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spidey-perf-'));
process.env.SPIDEY_HANG_HOME = home;
const ipc = require(path.join(ROOT, 'src/lib/ipc.js'));
const env = { ...process.env, SPIDEY_HANG_HOME: home };
delete env.ELECTRON_RUN_AS_NODE;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logText = () => (fs.existsSync(path.join(home, 'log.txt')) ? fs.readFileSync(path.join(home, 'log.txt'), 'utf8') : '');
const count = (pattern) => (logText().match(new RegExp(pattern.source, 'g')) || []).length;

async function waitFor(what, test, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return true;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const METRICS = /Metrics over ([\d.]+) s: CPU ([\d.]+)%, memory (\d+) MB, processes (\d+) \(([^)]*)\)(?:, page heap ([\d.]+|-)(?: MB)?, frames (\d+))?/;

/** Runs "metrics <seconds>" and returns what it logged. */
async function measure(seconds) {
  const before = count(/Metrics over/);
  await ipc.send(`metrics ${seconds}`);
  await waitFor('the metrics line', () => count(/Metrics over/) > before, (seconds + 10) * 1000);
  const lines = logText().split('\n').filter((l) => METRICS.test(l));
  const m = METRICS.exec(lines[lines.length - 1]);
  return {
    seconds: Number(m[1]),
    cpu: Number(m[2]),
    memoryMB: Number(m[3]),
    processes: Number(m[4]),
    byType: m[5],
    heapMB: m[6] && m[6] !== '-' ? Number(m[6]) : null,
    frames: m[7] !== undefined ? Number(m[7]) : null,
  };
}

/** Waits until the page says it has stopped drawing (the "stats" line: animating false). */
async function settle(ms = 45000) {
  await waitFor('him to go still', async () => {
    const before = count(/Frames: /);
    await ipc.send('stats');
    await waitFor('stats', () => count(/Frames: /) > before, 3000);
    const lines = logText().split('\n').filter((l) => l.includes('Frames: '));
    return lines[lines.length - 1].includes('animating false');
  }, ms);
}

async function main() {
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({
    AnchorFraction: 0.5, Size: 'Large', Rope: 'Long', Breeze: false, AutoSwing: false, Hero: HERO,
    RotateMinutes: 0, StartAutomatically: false, WaterReminder: false, LunchReminder: false, CustomReminders: [],
  }, null, 2));

  console.log(`Measuring ${APP} (${LABEL}), hero ${HERO}, Large, Long rope. Leave him alone until it ends.`);
  const app = spawn(electron, [APP], { env, stdio: 'ignore' });
  let exited = false;
  app.on('exit', () => (exited = true));
  const results = { label: LABEL, app: APP, hero: HERO, when: new Date().toISOString(), platform: `${process.platform} ${process.arch}`, cases: {} };
  const record = (name, r) => {
    results.cases[name] = r;
    console.log(`  ${name.padEnd(16)} CPU ${String(r.cpu.toFixed(1)).padStart(5)}%   memory ${String(r.memoryMB).padStart(4)} MB   frames ${r.frames === null ? '-' : r.frames}`);
  };
  try {
    await waitFor('the app', () => ipc.send('ping'), 30000);
    await waitFor('his look', () => /Look: /.test(logText()), 20000);

    await settle();
    record('still', await measure(10));

    await ipc.send('breeze on');
    await sleep(3000);
    record('breeze', await measure(10));
    await ipc.send('breeze off');

    await ipc.send('swing on');
    await sleep(4000);
    record('auto-swing', await measure(10));
    await ipc.send('swing off');
    await ipc.send('reset');
    await settle();

    await ipc.send('push 2');
    record('after a push', await measure(6));
    await settle();

    await ipc.send('travel');
    record('swinging across', await measure(4));
    await settle();

    // Taken down (newer versions): no drawing window at all.
    await ipc.send('down');
    const down = await waitFor('taken down', () => /Taken down/.test(logText()), 5000).catch(() => false);
    if (down) {
      await sleep(2000);
      record('taken down', await measure(10));
      await ipc.send('up');
      await sleep(2000);
    }

    if (LONG) {
      await ipc.send('breeze on');
      const samples = [];
      for (let i = 0; i < 9; i++) {
        const r = await measure(10);
        samples.push(r.memoryMB);
        process.stdout.write(`  breeze ${(i + 1) * 10} s: ${r.memoryMB} MB, heap ${r.heapMB === null ? '-' : r.heapMB.toFixed(1)} MB\n`);
      }
      results.cases['90 s of breeze'] = { memoryMB: samples, growthMB: samples[samples.length - 1] - samples[0] };
      await ipc.send('breeze off');
    }
  } finally {
    await ipc.send('exit');
    await sleep(1000);
    if (!exited) app.kill();
  }
  const out = path.join(home, `perf-${LABEL.replace(/[^\w.-]+/g, '_')}.json`);
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`\nResults: ${out}`);
}

main().catch((err) => {
  console.error(`perf failed: ${err.message}\n--- log ---\n${logText()}`);
  process.exitCode = 1;
});
