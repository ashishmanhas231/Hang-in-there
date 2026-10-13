'use strict';
/*
 * Unit tests. Plain Node, no Electron and no screen:  node --test test/
 * Each test that touches files gets its own temporary ~/.spidey-hang (SPIDEY_HANG_HOME).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const D = path.join(__dirname, '..', 'src');
const { Rig, STEP } = require(path.join(D, 'renderer/shared/rig.js'));
const IM = require(path.join(D, 'renderer/shared/images.js'));
const { HeroLook, Stage } = require(path.join(D, 'renderer/shared/stage.js'));
const fixtures = require('./fixtures.js');

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spidey-test-'));
  process.env.SPIDEY_HANG_HOME = dir;
  return dir;
}

/** A medium Spidey as the snapshot test lays him out. */
function mediumRig() {
  const rig = new Rig();
  const body = 150;
  const rope = 280;
  const reach = rope + body * 1.32;
  rig.build(2 * reach + 40, reach + 30, reach + 20, rope, body);
  return rig;
}

function run(rig, seconds, autoSwing = false, each) {
  let t = 0;
  while (t < seconds) {
    rig.simulate(t, false, autoSwing, null, null);
    t += STEP;
    if (each) each(t);
  }
}

// ---- Physics ---------------------------------------------------------------------------------

test('rope holds its length through a hard swing', () => {
  const rig = mediumRig();
  rig.kick(3, 1);
  let worst = 1;
  run(rig, 10, false, () => (worst = Math.max(worst, rig.ropeStretch)));
  assert.ok(worst < 1.02, `rope stretched to ${worst}`);
});

test('he settles and goes still on his own', () => {
  const rig = mediumRig();
  rig.kick(1, 1);
  run(rig, 15);
  assert.ok(rig.motion() < 0.02, `still moving: ${rig.motion()}`);
  assert.ok(Math.abs(rig.ropeAngle) < 0.01);
});

test('swing on his own holds a steady swing of about 25-35 degrees', () => {
  const rig = mediumRig();
  rig.kick(0.8, 1);
  let peak = 0;
  run(rig, 40, true, (t) => {
    if (t > 25) peak = Math.max(peak, Math.abs(rig.ropeAngle));
  });
  const degrees = (peak * 180) / Math.PI;
  assert.ok(degrees > 20 && degrees < 36, `peak ${degrees.toFixed(1)} degrees`);
});

test('swing on his own stays small near a screen edge', () => {
  const rig = mediumRig();
  rig.visibleRight = rig.anchor.x + 120; // the screen ends just right of the web
  rig.kick(0.8, 1);
  let peak = 0;
  run(rig, 30, true, (t) => {
    if (t > 15) peak = Math.max(peak, Math.abs(rig.ropeAngle));
  });
  assert.ok(peak < rig.swingRoom() + 0.12, `peak ${peak} over room ${rig.swingRoom()}`);
});

test('roomToSwing slides the web in from the edges, or centres it on a narrow screen', () => {
  const work = { x: 0, width: 1920 };
  const needed = Rig.distanceForFullSwing(280, 150);
  assert.equal(Rig.roomToSwing(1900, 280, 150, work), 1920 - needed);
  assert.equal(Rig.roomToSwing(10, 280, 150, work), needed);
  assert.equal(Rig.roomToSwing(900, 280, 150, work), 900);
  assert.equal(Rig.roomToSwing(10, 280, 150, { x: 100, width: 300 }), 250);
});

test('picking: body ends, rope points, the knot, and empty space', () => {
  const rig = mediumRig();
  run(rig, 0.1);
  const head = rig.pick({ x: rig.head.x, y: rig.head.y - 10 });
  assert.equal(head, rig.head);
  assert.equal(rig.pick({ x: rig.ankle.x, y: rig.ankle.y + 5 }), rig.ankle);
  const mid = rig.particles[5];
  assert.equal(rig.pick({ x: mid.x + 3, y: mid.y }), mid);
  assert.equal(rig.pick({ x: rig.anchor.x + 300, y: 200 }), null);
  assert.ok(rig.nearAnchor({ x: rig.anchor.x + 5, y: 5 }));
  assert.ok(!rig.nearAnchor({ x: rig.anchor.x + 40, y: 5 }));
});

test('moving the knot keeps him where he was', () => {
  const rig = mediumRig();
  const before = rig.head.x;
  rig.shiftAll(-50);
  rig.moveAnchor(rig.anchor.x - 50);
  assert.equal(rig.head.x, before - 50);
  assert.equal(rig.motion(), 0);
});

// ---- Pictures --------------------------------------------------------------------------------

test('a hanging picture ties on at the middle of its top edge and is sized to his body', () => {
  const p = fixtures.pixels(100, 200).rect(30, 20, 70, 180, [255, 0, 0, 255]);
  const m = IM.measureFigure(p.data, 100, 200, false, 150);
  assert.deepEqual(m.box, { x: 30, y: 20, width: 40, height: 160 });
  assert.equal(m.attachX, 19.5);
  assert.equal(m.attachY, 0);
  assert.ok(Math.abs(m.balanceDegrees) < 0.5);
  assert.ok(Math.abs(m.box.height * m.scale - 150 * 1.3) < 1e-9);
});

test('a lopsided picture tilts so its weight hangs below the tie-on point', () => {
  // A thin hook at top left, a heavy block lower right.
  const p = fixtures.pixels(200, 200).rect(10, 0, 20, 100, [0, 0, 0, 255]).rect(10, 100, 190, 190, [0, 0, 0, 255]);
  const m = IM.measureFigure(p.data, 200, 200, false, 150);
  assert.ok(m.balanceDegrees > 20, `tilt ${m.balanceDegrees}`);
});

test('flip ties an upright picture on at its bottom edge', () => {
  const p = fixtures.person([255, 0, 0, 255]);
  const m = IM.measureFigure(p.data, 200, 400, true, 150);
  assert.equal(m.attachY, m.box.height);
});

test('a completely transparent picture is refused', () => {
  const p = fixtures.pixels(10, 10);
  assert.throws(() => IM.measureFigure(p.data, 10, 10, false, 150), /transparent/);
});

test('a picture held by a grip ties on there, keeps its pose turned by tilt, and knows its face', () => {
  const p = fixtures.person([255, 0, 0, 255]); // box 10..190 x 20..390
  const hold = { grip: { x: 150, y: 300 }, tilt: -7, face: { x: 100, y: 50 }, faceSize: 30 };
  const m = IM.measureFigure(p.data, 200, 400, false, 150, 1.3, hold);
  assert.equal(m.attachX, 150 - m.box.x);
  assert.equal(m.attachY, 300 - m.box.y);
  assert.equal(m.balanceDegrees, -7, 'no tipping to balance under a grip');
  assert.ok(m.gripped);
  const figure = new IM.CustomFigure(m, false, null, 1);
  const face = figure.facePoint();
  // The face is above and left of the grip; turned 7 degrees anticlockwise it stays above it.
  assert.ok(face.y < 0 && face.x < 0, JSON.stringify(face));
  assert.ok(Math.abs(Math.hypot(face.x, face.y) - Math.hypot(50, 250) * m.scale) < 1e-6);
  assert.equal(face.r, 30 * m.scale);
  assert.equal(new IM.CustomFigure(IM.measureFigure(p.data, 200, 400, false, 150), false, null, 1).facePoint(), null);
});

// ---- Looks -----------------------------------------------------------------------------------

test('missing poses fall back: grab and fly to swing, swing to hang', () => {
  const hang = { name: 'hang' };
  const swing = { name: 'swing' };
  const look = new HeroLook('x', 'web', { hang, swing });
  assert.equal(look.pose('grab'), swing);
  assert.equal(look.pose('fly'), swing);
  assert.equal(look.pose('swing'), swing);
  assert.equal(new HeroLook('x', 'web', { hang }).pose('fly'), hang);
  assert.equal(new HeroLook('x', 'chain', { hang }).line, 'web', 'only the web is drawn');
});

test('hit testing never reads a pixel back when the pointer is far from him', () => {
  const rig = mediumRig();
  const stage = new Stage(rig, null);
  stage.look = new HeroLook('x', 'web', { hang: { size: { x: 60, y: 120 }, draw() {}, facePoint: () => null } });
  let reads = 0;
  const alphaAt = () => {
    reads++;
    return 255;
  };
  assert.equal(stage.hitTest({ x: 5, y: rig.ankle.y + 300 }, alphaAt), false);
  assert.equal(reads, 0);
  assert.equal(stage.hitTest({ x: rig.ankle.x + 20, y: rig.ankle.y + 40 }, alphaAt), true);
  assert.equal(reads, 1);
});

// ---- Heroes ----------------------------------------------------------------------------------

test('hero.json: comments, trailing commas, grip, tilt and face', () => {
  const home = tempHome();
  const heroes = require(path.join(D, 'lib/heroes.js'));
  const dir = path.join(home, 'Test hero');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hang.png'), fixtures.person([255, 0, 0, 255]).png());
  fs.writeFileSync(path.join(dir, 'Swing.PNG'), fixtures.person([0, 0, 255, 255]).png());
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a picture');
  fs.writeFileSync(path.join(dir, 'hero.json'), `{
    // a comment
    "line": "none", /* another */
    "poses": { "Hang": { "tilt": -7, "faceSize": 40, "points": { "grip": [1, 2], "face": [3, 4], } } },
  }`);
  const hero = heroes.readFolder(dir);
  assert.deepEqual(Object.keys(hero.poses).sort(), ['hang', 'swing']);
  assert.ok(hero.usable);
  assert.equal(hero.line, 'none');
  assert.deepEqual(hero.poseSettings.hang, { grip: { x: 1, y: 2 }, face: { x: 3, y: 4 }, tilt: -7, faceSize: 40 });
});

test('the iconic heroes ship with the app, each with its face marked', () => {
  const heroes = require(path.join(D, 'lib/heroes.js'));
  const list = heroes.scan();
  if (list.length === 0) {
    return; // a checkout without the (git-ignored) pictures
  }
  assert.deepEqual(list.map((h) => h.name), ['Iconic Spidey - Both', 'Iconic Spidey - Upside Down', 'Iconic Spidey - Web Swing']);
  assert.ok(list.every((h) => h.usable && h.poseSettings.hang && h.poseSettings.hang.face));
  assert.deepEqual(Object.keys(heroes.find('iconic spidey - both').poses).sort(), ['hang', 'swing']);
  assert.ok(heroes.find('Iconic Spidey - Web Swing').poseSettings.hang.grip, 'held by his fist');
  assert.equal(heroes.find('nobody'), null);
  assert.equal(heroes.scan(), list, 'read once, then kept');
});

// ---- Settings --------------------------------------------------------------------------------

test('settings: defaults, saving, sizes', () => {
  const home = tempHome();
  const { Settings } = require(path.join(D, 'lib/settings.js'));
  const s = Settings.load();
  assert.equal(s.Hero, 'Iconic Spidey - Upside Down');
  assert.equal(s.StartAutomatically, true);
  assert.equal(s.bodyLength, 150);
  s.Size = 'Large';
  s.Rope = 'Long';
  s.AnchorFraction = 0.3;
  s.save();
  const again = Settings.load();
  assert.equal(again.bodyLength, 200);
  assert.equal(again.ropeFraction, 0.42);
  assert.equal(again.AnchorFraction, 0.3);
});

test('settings: a byte-order mark is tolerated, old keys are dropped, and a broken file means defaults', () => {
  const home = tempHome();
  const { Settings } = require(path.join(D, 'lib/settings.js'));
  fs.writeFileSync(path.join(home, 'settings.json'), '\uFEFF{ "AnchorFraction": 0.5, "Size": "Small", "Hero": "My picture", "ImageFile": "C:\\\\x\\\\figure.png" }');
  const s = Settings.load();
  assert.equal(s.Hero, 'My picture');
  assert.equal(s.Size, 'Small');
  assert.equal(s.ImageFile, undefined, 'settings from older versions are left behind');
  fs.writeFileSync(path.join(home, 'settings.json'), '{ broken');
  assert.equal(Settings.load().Hero, 'Iconic Spidey - Upside Down', 'a broken file means defaults');
});

// ---- Starting at sign-in ---------------------------------------------------------------------

test('Windows: the Run value is added, left alone when right, and removed', () => {
  tempHome();
  const startup = require(path.join(D, 'lib/startup.js'));
  let value = null;
  const calls = [];
  const reg = (args) => {
    calls.push(args[0]);
    if (args[0] === 'query') {
      if (value === null) throw new Error('not found');
      return `\r\nHKEY_CURRENT_USER\\...\\Run\r\n    Spidey Hang    REG_SZ    ${value}\r\n`;
    }
    if (args[0] === 'add') value = args[args.indexOf('/d') + 1];
    if (args[0] === 'delete') value = null;
    return '';
  };
  const launch = { exe: 'C:\\Users\\A B\\AppData\\Local\\Programs\\spidey-hang\\Spidey Hang.exe', args: ['--at-login'] };
  startup.sync(true, launch, { platform: 'win32', reg });
  assert.equal(value, '"C:\\Users\\A B\\AppData\\Local\\Programs\\spidey-hang\\Spidey Hang.exe" --at-login');
  startup.sync(true, launch, { platform: 'win32', reg });
  assert.deepEqual(calls, ['query', 'add', 'query'], 'no second write when already right');
  startup.sync(false, launch, { platform: 'win32', reg });
  assert.equal(value, null);
});

test('macOS: a LaunchAgent is written with escaped paths, and removed', () => {
  const home = tempHome();
  const startup = require(path.join(D, 'lib/startup.js'));
  const launch = { exe: '/Users/a&b/Applications/Spidey Hang.app/Contents/MacOS/Spidey Hang', args: ['--at-login'] };
  startup.sync(true, launch, { platform: 'darwin', home });
  const file = path.join(home, 'Library', 'LaunchAgents', 'com.spideyhang.overlay.plist');
  const plist = fs.readFileSync(file, 'utf8');
  assert.match(plist, /<string>\/Users\/a&amp;b\/Applications\/Spidey Hang\.app\/Contents\/MacOS\/Spidey Hang<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  startup.sync(false, launch, { platform: 'darwin', home });
  assert.ok(!fs.existsSync(file));
});

test('Linux: an autostart entry is written and removed', () => {
  const home = tempHome();
  const startup = require(path.join(D, 'lib/startup.js'));
  startup.sync(true, { exe: '/opt/e lectron', args: ['/home/u/app', '--at-login'] }, { platform: 'linux', home });
  const file = path.join(home, '.config', 'autostart', 'spidey-hang.desktop');
  assert.match(fs.readFileSync(file, 'utf8'), /Exec="\/opt\/e lectron" \/home\/u\/app --at-login/);
  startup.sync(false, { exe: 'x', args: [] }, { platform: 'linux', home });
  assert.ok(!fs.existsSync(file));
});

test('with SPIDEY_HANG_HOME set, sign-in entries stay inside it and the registry is never run', () => {
  const home = tempHome();
  const startup = require(path.join(D, 'lib/startup.js'));
  const launch = { exe: '/e', args: ['/a', '--at-login'] };
  startup.sync(true, launch, { platform: 'darwin' });
  assert.ok(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'com.spideyhang.overlay.plist')));
  startup.sync(true, launch, { platform: 'win32' }); // would throw if it tried to run reg.exe on this system
  assert.match(fs.readFileSync(path.join(home, 'log.txt'), 'utf8'), /test mode: the Windows registry is not touched/);
});

// ---- Command channel -------------------------------------------------------------------------

test('commands reach a listening overlay; nothing is sent when none is running', async () => {
  tempHome();
  const ipc = require(path.join(D, 'lib/ipc.js'));
  assert.equal(await ipc.send('ping', 300), false);
  const got = [];
  const server = await ipc.listen((line) => got.push(line));
  try {
    assert.equal(await ipc.send('push 1'), true);
    assert.equal(await ipc.send('image /a path/with spaces.png'), true);
    assert.equal(await ipc.send('x'.repeat(2000)), true);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(got, ['push 1', 'image /a path/with spaces.png'], 'over-long lines are dropped');
  } finally {
    server.close();
  }
});

test('a socket left behind by a crash is cleared on the next start', { skip: process.platform === 'win32' }, async () => {
  const home = tempHome();
  const ipc = require(path.join(D, 'lib/ipc.js'));
  fs.writeFileSync(path.join(home, 'spidey.sock'), '');
  const server = await ipc.listen(() => {});
  server.close();
});

test('reminders: water on the half hour, lunch at 3 PM, lunch wins when they meet', () => {
  const R = require(path.join(D, 'lib/reminders.js'));
  const at = (h, m, s = 0) => new Date(2026, 9, 13, h, m, s);
  const hm = (d) => `${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

  assert.equal(hm(R.nextHalfHour(at(10, 17))), '13 10:30');
  assert.equal(hm(R.nextHalfHour(at(10, 30))), '13 11:00');
  assert.equal(hm(R.nextHalfHour(at(23, 45))), '14 0:00');
  assert.equal(hm(R.nextDaily(at(14, 59), 15, 0)), '13 15:00');
  assert.equal(hm(R.nextDaily(at(15, 0), 15, 0)), '14 15:00');

  const both = { water: true, lunch: true };
  assert.deepEqual(R.nextReminder(at(14, 40), both), { kind: 'lunch', at: at(15, 0) });
  assert.deepEqual(R.nextReminder(at(15, 0, 1), both), { kind: 'water', at: at(15, 30) });
  assert.deepEqual(R.nextReminder(at(14, 40), { water: true, lunch: false }), { kind: 'water', at: at(15, 0) });
  assert.deepEqual(R.nextReminder(at(16, 0), { water: false, lunch: true }), { kind: 'lunch', at: new Date(2026, 9, 14, 15, 0) });
  assert.equal(R.nextReminder(at(16, 0), { water: false, lunch: false }), null);
});

test('reminders: the clock fires when due and skips one missed while asleep', (t) => {
  const R = require(path.join(D, 'lib/reminders.js'));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = new Date(2026, 9, 13, 14, 59, 30).getTime();
  const shown = [];
  const clock = new R.ReminderClock(() => ({ water: true, lunch: true }), (r) => shown.push(r.kind), () => new Date(now));
  clock.start();
  now += 30 * 1000;
  t.mock.timers.tick(30 * 1000);
  assert.deepEqual(shown, ['lunch']);

  // Asleep from 15:00 to 15:45: the 15:30 water reminder is late by 15 minutes and is skipped.
  now += 45 * 60 * 1000;
  t.mock.timers.tick(60 * 1000);
  assert.deepEqual(shown, ['lunch']);
  assert.equal(clock.next.items[0].kind, 'water');
  assert.equal(new Date(clock.next.at).getMinutes(), 0);
  clock.stop();
});

test('after a build, the unpacked app for this system is found to start', () => {
  const { findBuiltApp } = require(path.join(__dirname, '..', 'scripts', 'dist.js'));
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'spidey-dist-'));
  const touch = (...parts) => {
    const file = path.join(dist, ...parts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    return file;
  };
  assert.equal(findBuiltApp(dist, 'win32', 'x64'), null);
  const exe = touch('win-unpacked', 'Spidey Hang.exe');
  assert.equal(findBuiltApp(dist, 'win32', 'x64'), exe);

  const macBin = ['Spidey Hang.app', 'Contents', 'MacOS', 'Spidey Hang'];
  const intel = touch('mac', ...macBin);
  assert.equal(findBuiltApp(dist, 'darwin', 'arm64'), null);
  assert.equal(findBuiltApp(dist, 'darwin', 'x64'), intel);
  const arm = touch('mac-arm64', ...macBin);
  assert.equal(findBuiltApp(dist, 'darwin', 'arm64'), arm);
  assert.equal(findBuiltApp(dist, 'darwin', 'x64'), intel);
});

test('custom reminders: messages, times and days are cleaned, broken ones dropped', () => {
  const R = require(path.join(D, 'lib/reminders.js'));
  assert.equal(R.cleanCustom({ text: '   ' }), null);
  assert.equal(R.cleanCustom('stretch'), null);
  assert.deepEqual(R.cleanCustom({ id: 'a1', text: '  Stand   up ', type: 'daily', time: '7:05', days: [5, 1, 1, 9], on: false }),
    { id: 'a1', text: 'Stand up', type: 'daily', time: '07:05', days: [1, 5], on: false });
  assert.equal(R.cleanCustom({ text: 'x', time: '25:00' }).time, '09:00');
  assert.deepEqual(R.cleanCustom({ text: 'x', days: [] }).days, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(R.cleanCustom({ text: 'x', type: 'every', minutes: 1 }).minutes, R.MIN_EVERY);
  assert.equal(R.cleanCustom({ text: 'x', type: 'every', minutes: 99999 }).minutes, R.MAX_EVERY);
  assert.equal(R.cleanCustom({ text: 'x'.repeat(500) }).text.length, R.MAX_TEXT);
  assert.match(R.cleanCustom({ id: 'bad id!', text: 'x' }).id, /^[A-Za-z0-9_-]+$/);

  const list = R.cleanCustomList([{ id: 'same', text: 'a' }, { id: 'same', text: 'b' }, null, { text: '' }]);
  assert.equal(list.length, 2);
  assert.notEqual(list[0].id, list[1].id);
  assert.deepEqual(R.cleanCustomList('nope'), []);
  assert.equal(R.cleanCustomList(Array.from({ length: 80 }, (_, i) => ({ text: 'r' + i }))).length, R.MAX_CUSTOM);
});

test('custom reminders: daily at a time, every N minutes from midnight, only on chosen days', () => {
  const R = require(path.join(D, 'lib/reminders.js'));
  // 13 October 2026 is a Tuesday.
  const at = (d, h, m) => new Date(2026, 9, d, h, m);
  const daily = R.cleanCustom({ text: 'Standup', type: 'daily', time: '10:30' });
  assert.deepEqual(R.nextCustom(at(13, 9, 0), daily), at(13, 10, 30));
  assert.deepEqual(R.nextCustom(at(13, 10, 30), daily), at(14, 10, 30));

  // Weekdays only: from Friday afternoon the next one is Monday.
  const weekdays = { ...daily, days: [1, 2, 3, 4, 5] };
  assert.deepEqual(R.nextCustom(at(16, 12, 0), weekdays), at(19, 10, 30));

  const every = R.cleanCustom({ text: 'Stretch', type: 'every', minutes: 45 });
  assert.deepEqual(R.nextCustom(at(13, 10, 0), every), at(13, 10, 30));
  assert.deepEqual(R.nextCustom(at(13, 10, 30), every), at(13, 11, 15));
  // The last one of the day, then it starts again at midnight.
  assert.deepEqual(R.nextCustom(at(13, 23, 10), every), at(13, 23, 15));
  assert.deepEqual(R.nextCustom(at(13, 23, 20), every), at(14, 0, 0));
  // Only on Sundays: from Tuesday, the first is Sunday at midnight.
  assert.deepEqual(R.nextCustom(at(13, 9, 0), { ...every, days: [0] }), at(18, 0, 0));
});

test('custom reminders: due together with water or lunch, all are shown; switched off ones never', () => {
  const R = require(path.join(D, 'lib/reminders.js'));
  const at = (h, m) => new Date(2026, 9, 13, h, m);
  const stretch = R.cleanCustom({ id: 's', text: 'Stretch', type: 'every', minutes: 60 });
  const standup = R.cleanCustom({ id: 'u', text: 'Standup', type: 'daily', time: '10:15' });

  let next = R.nextReminders(at(10, 5), { water: true, lunch: true, custom: [stretch, standup] });
  assert.deepEqual(next, { at: at(10, 15), items: [{ kind: 'custom', text: 'Standup', id: 'u' }] });

  next = R.nextReminders(at(10, 40), { water: true, lunch: true, custom: [stretch, standup] });
  assert.deepEqual(next.at, at(11, 0));
  assert.deepEqual(next.items.map((i) => i.text), [R.TEXT.water, 'Stretch']);

  // At 3 PM lunch still replaces water, and the custom one comes too.
  next = R.nextReminders(at(14, 40), { water: true, lunch: true, custom: [stretch] });
  assert.deepEqual(next.items.map((i) => i.kind), ['lunch', 'custom']);

  next = R.nextReminders(at(10, 5), { water: false, lunch: false, custom: [{ ...standup, on: false }] });
  assert.equal(next, null);
  assert.deepEqual(R.nextReminder(at(10, 5), { water: false, lunch: false, custom: [standup] }), { kind: 'custom', at: at(10, 15) });
});

test('custom reminders: described in words, and the clock shows every one that is due', (t) => {
  const R = require(path.join(D, 'lib/reminders.js'));
  assert.equal(R.describeCustom({ type: 'every', minutes: 45, days: [0, 1, 2, 3, 4, 5, 6] }), 'Every 45 minutes');
  assert.equal(R.describeCustom({ type: 'every', minutes: 60, days: [1, 2, 3, 4, 5] }), 'Every hour on weekdays');
  assert.equal(R.describeCustom({ type: 'every', minutes: 120, days: [0, 6] }), 'Every 2 hours on weekends');
  assert.match(R.describeCustom({ type: 'daily', time: '10:30', days: [0, 1, 2, 3, 4, 5, 6] }), /^Every day at .*10.30/);
  assert.match(R.describeCustom({ type: 'daily', time: '08:00', days: [1, 3] }), /^On Mon, Wed at /);

  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = new Date(2026, 9, 13, 10, 59, 30).getTime();
  const shown = [];
  const custom = [R.cleanCustom({ text: 'Stretch', type: 'every', minutes: 30 })];
  const clock = new R.ReminderClock(() => ({ water: true, lunch: false, custom }), (r) => shown.push(r.text), () => new Date(now));
  clock.start();
  now += 30 * 1000;
  t.mock.timers.tick(30 * 1000);
  assert.deepEqual(shown, [R.TEXT.water, 'Stretch']);
  clock.stop();
});

test('settings: custom reminders are saved, and broken ones in the file are dropped', () => {
  tempHome();
  const { Settings, DEFAULTS } = require(path.join(D, 'lib/settings.js'));
  const s = new Settings();
  assert.deepEqual(s.CustomReminders, []);
  s.CustomReminders = [{ id: 'w', text: 'Water the plants', type: 'daily', time: '18:00', days: [6], on: true }];
  s.save();
  assert.deepEqual(Settings.load().CustomReminders, s.CustomReminders);
  assert.deepEqual(DEFAULTS.CustomReminders, []);

  const raw = JSON.parse(fs.readFileSync(path.join(process.env.SPIDEY_HANG_HOME, 'settings.json'), 'utf8'));
  raw.CustomReminders = [{ text: '' }, { text: 'Ok', type: 'every', minutes: '30' }, 42];
  fs.writeFileSync(path.join(process.env.SPIDEY_HANG_HOME, 'settings.json'), JSON.stringify(raw));
  const loaded = Settings.load().CustomReminders;
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].minutes, 30);
  raw.CustomReminders = 'not a list';
  fs.writeFileSync(path.join(process.env.SPIDEY_HANG_HOME, 'settings.json'), JSON.stringify(raw));
  assert.deepEqual(Settings.load().CustomReminders, []);
});
