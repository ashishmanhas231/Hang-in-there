'use strict';
/*
 * Spidey Hang: Electron main process. Runs on Windows, macOS and Linux (built and tested for Ubuntu).
 *
 *   npm start  /  the installed app       start the overlay; if it is already running, give him a swing
 *   ... --push [n] | --reset | --exit      send that to the running overlay
 *   ... --at-login                         what sign-in runs: waits a few seconds for the taskbar or Dock
 *   ... --reminders                        open the Reminders window (starting the overlay if needed)
 *   npm run spidey -- <command>            send any command below (scripts/spidey.js)
 * Development only (not in the installed app), nothing appears on screen:
 *   ... --snapshot f.png [seconds] [kick] [hero folder|-] [-] [swing|-] [edge]
 *   ... --export-figure f.png
 */
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Tray, Menu, screen, ipcMain, nativeImage, nativeTheme, Notification, globalShortcut, powerMonitor, dialog, shell } = require('electron');

const paths = require('./lib/paths');
const log = require('./lib/log');
const ipc = require('./lib/ipc');
const heroes = require('./lib/heroes');
const startup = require('./lib/startup');
const reminders = require('./lib/reminders');
const { Focus, focusMessage } = require('./lib/focus');
const reactions = require('./lib/reactions');
const linux = require('./lib/linux');
const { Settings, DRAWN } = require('./lib/settings');
const { Rig, REACH_PAST_HEAD } = require('./renderer/shared/rig.js');

const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';

/** The default hero (settings.js), shipped in src/heroes. Keep the two names the same. */
const DEFAULT_BUNDLED_HERO = 'Iconic Spidey - Upside Down';

// Arguments after the app folder (electron <folder> ...), or after the executable when packaged.
const args = process.argv.slice(process.defaultApp ? 2 : 1).filter((a) => !a.startsWith('--no-sandbox') && !a.startsWith('--enable-') && !a.startsWith('--disable-') && !a.startsWith('--ozone-'));
const has = (flag) => args.includes(flag);

app.setName('Spidey Hang');
if (process.env.SPIDEY_HANG_HOME) {
  // A test copy (the tests, npm run perf): its own Chromium profile too, so it runs beside the
  // installed app instead of handing its arguments over to it as a second launch.
  app.setPath('userData', path.join(process.env.SPIDEY_HANG_HOME, 'electron'));
}

/** The command a launch with --push/--reset/--exit asks for, or '' for a plain start. */
function commandFromArgs(list) {
  const i = list.findIndex((a) => ['--push', '--reset', '--exit'].includes(a));
  if (i < 0) {
    return '';
  }
  if (list[i] === '--push') {
    const n = list[i + 1];
    return 'push ' + (n && !n.startsWith('--') ? n : '1');
  }
  return list[i].slice(2);
}

// ---- Start-up. Test modes (development only) get no single-instance lock and no tray ----------

if (!commandFromArgs(args) && linux.needsX11Restart()) {
  // On a Wayland desktop: start again under X11 (see lib/linux.js), with the same arguments.
  // Not for --push, --reset or --exit: those only pass the command on and never show a window.
  app.relaunch({ args: [...process.argv.slice(1), linux.X11_SWITCH] });
  app.exit(0);
} else if (!app.isPackaged && (has('--snapshot') || has('--export-figure'))) {
  app.whenReady().then(runTest);
} else if (!app.requestSingleInstanceLock()) {
  // Another overlay is running. It receives our arguments through 'second-instance'.
  app.exit(0);
} else {
  const command = commandFromArgs(args);
  if (command) {
    // Nothing is running, so there is nothing to push, reset or close.
    app.exit(0);
  } else {
    app.on('second-instance', (_event, argv) => {
      handleCommand(commandFromArgs(argv) || (argv.includes('--reminders') ? 'reminders' : 'push 1'));
    });
    app.whenReady().then(async () => {
      if (has('--at-login')) {
        // At sign-in the taskbar or Dock may not be there yet, and the work area comes out wrong.
        await new Promise((r) => setTimeout(r, 4000));
      }
      start();
      if (has('--reminders')) {
        openReminders();
      }
    });
  }
}

// Keep running with no windows (the tray stays).
app.on('window-all-closed', () => {});

// ---- State -----------------------------------------------------------------------------------

let settings = null;
let tray = null;
let hangWin = null;
let remindersWin = null;
let server = null;
const ready = new WeakMap(); // window -> true once its page listens
const queued = new WeakMap(); // window -> messages sent before that
let rotateTimer = null;
let layoutTimer = null;
let lastLayout = null;
let reminderClock = null;
const unseenProblems = [];
/** True while his window is open only to deliver reminders while he is taken down (a visit). */
let visiting = false;
/** Reminders due at the same moment while he is down, gathered so one visit delivers them all. */
let visitItems = [];
/** Closes his window if the page never says he has climbed out. */
let leaveTimer = null;
/** Hidden for a while (Hide him): { until } (until 0 = until brought back), or null. Not kept over a restart. */
let hidden = null;
let hiddenTimer = null;
/** One-off reminders ("remind in 10 Tea is ready"): { id, at, text }. Kept in memory only. */
let onceReminders = [];
/** The focus timer, and the timer that wakes for its countdown and its ends. */
let focus = null;
let focusTimer = null;
/** The focus part the Linux tray menu was last built for. */
let focusMenuPhase = 'idle';
/** Away from the computer (idle, locked, asleep): he dozes. */
let dozing = false;
/** When he dozed off (ms), so only keyboard or mouse use after that wakes him. */
let dozedAt = 0;
let idleTimer = null;
/** The next little thing he does on his own. */
let anticTimer = null;
let lastAntic = null;
let lastLine = null;
const batteryWatch = new reactions.BatteryWatch();
/** The screen he hangs on now (its id), and the timer that follows the pointer between screens. */
let shownDisplay = null;
let displayTimer = null;

/** What sign-in should run: this app (from source, Electron plus the project folder). */
function signInCommand() {
  return { exe: process.execPath, args: process.defaultApp ? [app.getAppPath(), '--at-login'] : ['--at-login'] };
}

function start() {
  settings = Settings.load();
  // Before the tray: its menu (built at once on Linux) shows the focus timer.
  focus = new Focus(() => ({ focus: settings.FocusMinutes, short: settings.ShortBreakMinutes, long: settings.LongBreakMinutes }));
  log.write(`Start ${app.getVersion()} (Electron ${process.versions.electron}, ${process.platform} ${process.arch}) from ${app.getAppPath()}${has('--at-login') ? ' at sign-in' : ''}. ` +
    `Settings: size ${settings.Size}, rope ${settings.Rope}, hero ${settings.Hero}, change hero every ${settings.RotateMinutes} min, start automatically ${settings.StartAutomatically}, ` +
    `custom reminders ${settings.CustomReminders.length}, taken down ${settings.Down}`);
  if (isMac && app.dock) {
    app.dock.hide();
  }
  process.on('uncaughtException', (err) => log.write('CRASH ' + (err && err.stack ? err.stack : err)));

  // Keep the sign-in entry in step with the setting, and pointing at the right copy.
  startup.sync(settings.StartAutomatically, signInCommand());

  ipc.listen((line) => handleCommand(line)).then(
    (s) => {
      server = s;
    },
    (err) => log.write(`Could not open the command channel (${ipc.endpoint()}): ${err.message}`)
  );

  createTray();
  if (settings.Down) {
    log.write('Taken down: waiting in the tray; he drops in for reminders');
  } else {
    hangWin = createOverlay('hang');
    applyLayout();
  }
  startRotateTimer();
  reminderClock = new reminders.ReminderClock(() => ({
    water: settings.WaterReminder, waterMinutes: settings.WaterMinutes,
    lunch: settings.LunchReminder, lunchTime: settings.LunchTime,
    custom: settings.CustomReminders, once: onceReminders,
  }), remind);
  reminderClock.start();
  applyHotkeys();
  watchPower();
  startIdleWatch();
  scheduleAntic();
  watchDisplays();
  app.on('will-quit', () => globalShortcut.unregisterAll());

  for (const event of ['display-metrics-changed', 'display-added', 'display-removed']) {
    screen.on(event, () => {
      clearTimeout(layoutTimer);
      // Not in the middle of a visit: he leaves again in a moment anyway.
      layoutTimer = setTimeout(() => {
        if (!visiting) {
          applyLayout();
        }
        watchDisplays();
      }, 300);
    });
  }
}

// ---- Windows ---------------------------------------------------------------------------------

/** A borderless, transparent, always-on-top window that never takes the keyboard focus. */
function createOverlay(mode, show = true) {
  const win = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    enableLargerThanScreen: true,
    roundedCorners: false,
    title: 'Spidey Hang',
    // A non-activating panel on macOS: clicking him does not take focus from the app you are using.
    type: isMac ? 'panel' : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  if (isMac) {
    win.setAlwaysOnTop(true, 'floating');
    // Over apps in full screen only if asked: macOS then keeps him off their space by itself.
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: !(settings && settings.HideInFullScreen) });
  } else {
    win.setAlwaysOnTop(true, 'screen-saver');
  }
  if (isLinux) {
    // Stays put when you switch workspaces, as on a Mac.
    win.setVisibleOnAllWorkspaces(true);
  }
  // Clicks fall through until the page says the pointer is over him. Moves are still forwarded.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.webContents.on('render-process-gone', (_e, details) => log.write(`Overlay page (${mode}) stopped: ${details.reason}`));
  win.webContents.on('console-message', (event) => {
    const level = event.level !== undefined ? event.level : 'info';
    if (level === 'error' || level === 3) {
      log.write(`Overlay page (${mode}) error: ${event.message}`);
    }
  });
  ready.set(win, false);
  queued.set(win, []);
  win.loadFile(path.join(__dirname, 'renderer', 'overlay.html'), { query: { mode } });
  if (show && mode !== 'test') {
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) {
        win.showInactive();
      }
    });
  }
  return win;
}

/** Sends to a page, holding the message until the page is listening. */
function post(win, channel, data) {
  if (!win || win.isDestroyed()) {
    return;
  }
  if (ready.get(win)) {
    win.webContents.send(channel, data);
  } else {
    queued.get(win).push([channel, data]);
  }
}

const windowOf = (event) => BrowserWindow.fromWebContents(event.sender);

ipcMain.on('ready', (event) => {
  const win = windowOf(event);
  if (!win) {
    return;
  }
  ready.set(win, true);
  for (const [channel, data] of queued.get(win) || []) {
    win.webContents.send(channel, data);
  }
  queued.set(win, []);
});

ipcMain.on('ignore-mouse', (event, ignore) => {
  const win = windowOf(event);
  // Not on Linux, which shapes the window instead ('mouse-shape').
  if (win && !isLinux) {
    win.setIgnoreMouseEvents(!!ignore, { forward: true });
  }
});

/**
 * Linux: the parts of the window that catch the mouse (renderer/shared/shape.js). Linux does not pass
 * on mouse moves to a window that lets clicks through, so the page could never tell when the pointer
 * came over him; instead the desktop sends clicks inside this shape to him and the rest straight on.
 */
ipcMain.on('mouse-shape', (event, rects) => {
  const win = windowOf(event);
  if (!win || !isLinux || !Array.isArray(rects) || rects.length > 2000) {
    return;
  }
  const clean = rects
    .map((r) => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }))
    .filter((r) => [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0);
  if (clean.length === 0) {
    // Nothing drawn. An empty shape would make the whole window catch the mouse.
    win.setIgnoreMouseEvents(true);
    return;
  }
  win.setShape(clean);
  win.setIgnoreMouseEvents(false);
});

ipcMain.on('menu', (event) => showMenuAtCursor(windowOf(event)));

ipcMain.on('move-window', (_event, data) => {
  if (hangWin && lastLayout && Number.isFinite(data.left)) {
    lastLayout.left = data.left;
    hangWin.setBounds({ x: Math.round(data.left), y: lastLayout.top, width: lastLayout.width, height: lastLayout.height });
  }
});

/**
 * The page wants `extra` units of room below the usual window for a bungee drop, or none again
 * (extra 0). Only the bottom edge moves, so nothing shifts on screen.
 */
ipcMain.on('room-below', (event, data) => {
  if (windowOf(event) !== hangWin || !lastLayout || lastLayout.web || !data || !Number.isFinite(data.extra)) {
    return;
  }
  const area = lastLayout.work;
  const height = Math.round(Math.min(area.height, lastLayout.baseHeight + Math.max(0, Math.min(600, data.extra))));
  if (height !== lastLayout.height) {
    lastLayout.height = height;
    hangWin.setBounds({ x: Math.round(lastLayout.left), y: lastLayout.top, width: lastLayout.width, height });
  }
  post(hangWin, 'grow', { left: lastLayout.left, width: lastLayout.width, height, web: null });
});

ipcMain.on('anchor-dropped', (_event, data) => {
  if (settings && Number.isFinite(data.fraction)) {
    settings.AnchorFraction = Math.max(0, Math.min(1, data.fraction));
    settings.save();
  }
});

ipcMain.on('problem', (_event, message) => raiseProblem(String(message)));
ipcMain.on('log', (_event, message) => log.write(String(message)));

ipcMain.on('snapshot-data', (_event, data) => {
  try {
    fs.writeFileSync(data.path, Buffer.from(data.bytes));
    log.write(`Snapshot saved: ${data.path} (hero ${settings.Hero}, ${data.status})`);
  } catch (err) {
    log.write(`Snapshot failed: ${err.message}`);
  }
});

// ---- Layout and looks ------------------------------------------------------------------------

/** The screen he hangs on: the main one, the one named in settings.Display, or the pointer's. */
function targetDisplay() {
  if (settings.Display === 'pointer') {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }
  if (settings.Display) {
    const named = screen.getAllDisplays().find((d) => String(d.id) === settings.Display);
    if (named) {
      return named;
    }
  }
  return screen.getPrimaryDisplay();
}

/** The work area of his screen. During a visit or after a layout, the one he is on. */
function workArea() {
  return lastLayout && lastLayout.work && hangWin && !hangWin.isDestroyed() ? lastLayout.work : targetDisplay().workArea;
}

/**
 * "Follow the pointer" with more than one screen: every 2.5 s, if the pointer is on another screen,
 * he drops in there. Nothing runs with one screen or another choice.
 */
function watchDisplays() {
  clearInterval(displayTimer);
  displayTimer = null;
  if (settings.Display !== 'pointer' || screen.getAllDisplays().length < 2) {
    return;
  }
  displayTimer = setInterval(() => {
    if (!hangWin || hangWin.isDestroyed() || visiting || hidden) {
      return;
    }
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    if (shownDisplay !== null && d.id !== shownDisplay) {
      log.write(`Pointer moved to screen ${d.id}: he follows`);
      applyLayout({ arrive: true });
    }
  }, 2500);
}

function setDisplay(value) {
  settings.Display = value;
  settings.save();
  log.write(`Screen: ${value || 'main'}`);
  applyLayout({ arrive: true });
  watchDisplays();
}

/**
 * Room for a Big web reminder: where the webs land and the window grown to take them in.
 * In the middle of the screen, unless he hangs there: then beside him, on the side with more room.
 */
function webRoom(area, anchorX, body, left, right, tall) {
  const size = Math.round(520 * Math.min(1, (area.height * 0.72) / 520, (area.width * 0.5) / 520));
  let cx = area.x + area.width / 2;
  const clear = size / 2 + body * 0.8 + 30;
  if (Math.abs(anchorX - cx) < clear) {
    cx = anchorX + (anchorX - area.x < area.x + area.width - anchorX ? clear : -clear);
    cx = Math.max(area.x + size / 2 + 10, Math.min(area.x + area.width - size / 2 - 10, cx));
  }
  cx = Math.round(cx);
  const cy = Math.round(area.y + area.height * 0.45);
  left = Math.round(Math.min(left, cx - size / 2 - 40));
  right = Math.round(Math.max(right, cx + size / 2 + 40));
  tall = Math.round(Math.max(tall, Math.min(area.height, cy - area.y + size / 2 + 40)));
  return { left, right, tall, web: { x: cx - left, y: cy - area.y, size } };
}

/** A Big web reminder came during a visit whose window has no room for it: the window grows, he stays put. */
function growForWeb() {
  if (!hangWin || hangWin.isDestroyed() || !lastLayout || lastLayout.web) {
    return;
  }
  const area = workArea();
  const room = webRoom(area, lastLayout.anchorX, lastLayout.body, lastLayout.left, lastLayout.left + lastLayout.width, lastLayout.height);
  hangWin.setBounds({ x: room.left, y: area.y, width: room.right - room.left, height: room.tall });
  lastLayout = { ...lastLayout, left: room.left, width: room.right - room.left, height: room.tall, web: room.web };
  log.write(`Window grown for a big web: ${room.left}..${room.right}`);
  post(hangWin, 'grow', { left: room.left, width: room.right - room.left, height: room.tall, web: room.web });
}

/**
 * Sizes and places the hanging window from the settings, then hangs him straight with a small swing.
 * extra: { arrive } he drops in from the top; { visit } his window is open only to deliver reminders;
 * { web } a Big web reminder may come, so the window also reaches the middle of the screen.
 */
function applyLayout(extra = {}) {
  if (!hangWin || hangWin.isDestroyed()) {
    return;
  }
  const display = targetDisplay();
  shownDisplay = display.id;
  const area = display.workArea;
  const body = settings.bodyLength;
  const hang = body * (1 + REACH_PAST_HEAD);
  let rope = Math.max(60, settings.ropeFraction * area.height);
  rope = Math.min(rope, Math.max(60, area.height - hang - 30));
  const reach = rope + hang;
  // Wide enough for a full sideways swing. Not capped at the screen width: a squeezed window means
  // walls he can hit, and hitting them flung him over the top.
  const width = Math.round(2 * reach + 40);
  // Just tall enough. A bungee drop (an antic) grows it for those two seconds only (room-below):
  // a taller window costs more to draw on every frame he moves.
  const height = Math.round(Math.min(area.height, reach + 30));
  let anchorX = area.x + Math.max(0, Math.min(1, settings.AnchorFraction)) * area.width;
  anchorX = Math.max(area.x + 20, Math.min(area.x + area.width - 20, anchorX));
  const asked = anchorX;
  if (settings.AutoSwing) {
    anchorX = Rig.roomToSwing(anchorX, rope, body, area);
  }
  // Always centred on the anchor, even if that runs past the screen edge.
  let left = Math.round(anchorX - width / 2);
  let right = left + width;
  let tall = height;
  let web = null;
  if (extra.web) {
    ({ left, right, tall, web } = webRoom(area, anchorX, body, left, right, tall));
  }
  hangWin.setBounds({ x: left, y: area.y, width: right - left, height: tall });
  lastLayout = { left, top: area.y, width: right - left, height: tall, baseHeight: tall, web, work: { x: area.x, y: area.y, width: area.width, height: area.height }, anchorX, rope, body };
  log.write(`Layout: screen ${area.x}..${area.x + area.width}, web at ${Math.round(anchorX)} (saved spot ${Math.round(asked)}), ` +
    `window ${left}..${right}, rope ${Math.round(rope)}, swing on his own ${settings.AutoSwing}${extra.visit ? ', a visit' : ''}${web ? ', big web' : ''}`);
  post(hangWin, 'setup', {
    layout: { ...lastLayout }, flags: flags(), look: buildLook(), shapeMouse: isLinux,
    arrive: Boolean(extra.arrive), visit: Boolean(extra.visit), web, doze: dozing,
  });
}

const flags = () => ({ breeze: settings.Breeze, autoSwing: settings.AutoSwing, sounds: settings.Sounds });

/** Picture bytes by file. The pictures ship with the app and never change, so each is read once. */
const pictureCache = new Map();

function readBytes(file) {
  let bytes = pictureCache.get(file);
  if (!bytes) {
    bytes = new Uint8Array(fs.readFileSync(file));
    pictureCache.set(file, bytes);
  }
  return bytes;
}

/**
 * What settings.Hero names, ready to send to the page. A name that is not one of the heroes the app
 * ships with (from an older version's settings) means the default hero; the drawing if even that
 * is missing from this build.
 */
function buildLook() {
  const hero = settings.Hero;
  if (hero.toLowerCase() === DRAWN.toLowerCase()) {
    return { kind: 'drawn' };
  }
  const info = heroes.find(hero) || heroes.find(DEFAULT_BUNDLED_HERO);
  if (!info || !info.usable) {
    log.write(`No "${hero}" hero in this build, so the drawn Spider-Man is shown.`);
    return { kind: 'drawn' };
  }
  if (info.name.toLowerCase() !== hero.toLowerCase()) {
    log.write(`No "${hero}" hero any more, so ${info.name} is shown.`);
  }
  return heroLook(info);
}

function heroLook(info) {
  const poses = {};
  for (const [pose, { file }] of Object.entries(info.poses)) {
    try {
      // From hero.json: where the web ties on (grip), how far he is turned (tilt), where reminder
      // bubbles point (face, with its radius faceSize), the hand new webs shoot from (hand), and
      // which way he heads in the picture (faces: -1 left, 1 right).
      const { grip, tilt, face, faceSize, hand, faces } = info.poseSettings[pose] || {};
      poses[pose] = { bytes: readBytes(file), file: path.basename(file), grip, tilt, face, faceSize, hand, faces };
    } catch (err) {
      raiseProblem(`${info.name}: could not load ${path.basename(file)}. ${err.message}`);
    }
  }
  return { kind: 'hero', name: info.name, line: info.line, poses };
}

function reloadLook() {
  post(hangWin, 'look', { look: buildLook() });
}

// ---- Actions (menu, tray, commands) ----------------------------------------------------------

function swing(strength = 1) {
  post(hangWin, 'push', { strength });
}

function setHero(name) {
  settings.Hero = name;
  settings.save();
  log.write(`Hero: ${name}`);
  reloadLook();
}

/** Hero > Add a hero from a picture…: copies the picture into a new folder of yours and switches to it. */
async function addHeroFromPicture() {
  if (isMac) {
    app.focus({ steal: true }); // no Dock icon: the dialog only comes to the front this way
  }
  const result = await dialog.showOpenDialog({
    title: 'Pick a picture of your hero',
    buttonLabel: 'Add hero',
    properties: ['openFile'],
    filters: [{ name: 'Pictures', extensions: heroes.PICTURE_TYPES.map((e) => e.slice(1)) }],
  });
  if (result.canceled || !result.filePaths[0]) {
    return;
  }
  try {
    const hero = heroes.addFromPicture(result.filePaths[0]);
    log.write(`Hero added from a picture: ${hero.name} (${hero.folderPath})`);
    pictureCache.clear();
    setHero(hero.name);
  } catch (err) {
    raiseProblem(`Could not add that picture as a hero. ${err.message}`);
  }
}

function openHeroesFolder() {
  const dir = heroes.ensureUserDir();
  shell.openPath(dir).then((error) => error && log.write(`Could not open ${dir}: ${error}`));
}

/** Hero > Reload heroes: reads the folders again, and the pictures, without a restart. */
function reloadHeroes() {
  const list = heroes.refresh();
  pictureCache.clear();
  log.write(`Heroes reloaded: ${list.length} (${list.filter((h) => h.user).length} yours)`);
  reloadLook();
  if (isLinux) {
    refreshTrayMenu();
  }
}

/** The next hero (alphabetical, then the drawing, wrapping round). */
function nextHero() {
  const usable = [...heroes.scan().filter((h) => h.usable).map((h) => h.name), DRAWN];
  const at = usable.findIndex((n) => n.toLowerCase() === settings.Hero.toLowerCase());
  setHero(usable[(at + 1) % usable.length]);
}

function setRotate(minutes) {
  settings.RotateMinutes = Math.max(0, minutes);
  settings.save();
  log.write(`Change hero every: ${minutes > 0 ? minutes + ' min' : 'off'}`);
  startRotateTimer();
}

function startRotateTimer() {
  clearInterval(rotateTimer);
  rotateTimer = null;
  if (settings.RotateMinutes > 0) {
    rotateTimer = setInterval(nextHero, settings.RotateMinutes * 60 * 1000);
  }
}

/**
 * Shows a reminder. While he is up: in his speech bubble, always. While he is taken down: he drops in
 * to deliver it, in his bubble or (style 'web') in three webs in the middle of the screen, then
 * climbs out again (a visit). A system notification only if his window cannot be opened.
 */
function remind({ kind, text, style, id }) {
  if (kind === 'once') {
    onceReminders = onceReminders.filter((o) => o.id !== id);
  }
  const route = reminders.reminderRoute({ down: settings.Down, style });
  log.write(`Reminder (${kind}): ${text}${settings.Down ? ` [visit, ${route}]` : hidden ? ' [hidden: notification]' : ''}`);
  if (hidden) {
    // Hidden: out of sight altogether, so the system shows it.
    notify(text);
    return;
  }
  if (!settings.Down) {
    if (hangWin && !hangWin.isDestroyed()) {
      post(hangWin, 'remind', { kind, text, style: 'bubble' });
    } else {
      notify(text);
    }
    return;
  }
  if (visiting && hangWin && !hangWin.isDestroyed()) {
    // Already here: it waits its turn in the same visit.
    clearTimeout(leaveTimer);
    if (route === 'web') {
      growForWeb();
    }
    post(hangWin, 'remind', { kind, text, style: route });
    return;
  }
  // Reminders due at the same moment arrive one after another: gather them for one visit.
  visitItems.push({ kind, text, style: route });
  if (visitItems.length === 1) {
    setImmediate(startVisit);
  }
}

/** Opens his window and drops him in to deliver the gathered reminders. */
function startVisit() {
  const items = visitItems;
  visitItems = [];
  if (!settings.Down || items.length === 0) {
    return;
  }
  if (hangWin && !hangWin.isDestroyed()) {
    // Still climbing out after being taken down: he comes back down for these, in the same window.
    clearTimeout(leaveTimer);
    visiting = true;
    if (items.some((item) => item.style === 'web')) {
      growForWeb();
    }
    log.write(`Visit: he comes back down for ${items.length === 1 ? 'a reminder' : `${items.length} reminders`}`);
    for (const item of items) {
      post(hangWin, 'remind', item);
    }
    return;
  }
  try {
    hangWin = createOverlay('hang');
  } catch (err) {
    log.write(`Could not open his window for a reminder: ${err.message}`);
    items.forEach((item) => notify(item.text));
    return;
  }
  visiting = true;
  const web = items.some((item) => item.style === 'web');
  log.write(`Visit: he drops in for ${items.length === 1 ? 'a reminder' : `${items.length} reminders`} (${web ? 'web' : 'bubble'})`);
  applyLayout({ arrive: true, visit: true, web });
  for (const item of items) {
    post(hangWin, 'remind', item);
  }
}

function notify(text) {
  if (Notification.isSupported()) {
    new Notification({ title: 'Spidey Hang', body: text }).show();
  }
}

/** Takes him down: he climbs out of sight and his window closes. The tray and the reminder clock stay. */
function takeDown() {
  if (settings.Down) {
    return;
  }
  settings.Down = true;
  settings.save();
  // Taken down replaces hidden: reminders are visits again, not notifications.
  clearTimeout(hiddenTimer);
  hiddenTimer = null;
  const wasHidden = Boolean(hidden);
  hidden = null;
  log.write('Taken down: he climbs out; the tray and the reminders stay');
  if (wasHidden) {
    return; // already out of sight, his window closed
  }
  leave();
}

/** Asks the page to climb out of sight; it says 'gone' when he has. */
function leave() {
  if (!hangWin || hangWin.isDestroyed()) {
    closeOverlay();
    return;
  }
  post(hangWin, 'leave');
  clearTimeout(leaveTimer);
  leaveTimer = setTimeout(closeOverlay, 4000);
}

/** Closes his window, which frees its page (most of the app's memory). */
function closeOverlay() {
  stopPointerWatch();
  clearTimeout(leaveTimer);
  leaveTimer = null;
  visiting = false;
  if (hangWin && !hangWin.isDestroyed()) {
    hangWin.destroy();
    log.write('Window closed: no drawing until the next reminder');
  }
  hangWin = null;
}

/**
 * Hides him for `minutes` (0 = until brought back): he climbs out and his window closes, as when
 * taken down, but reminders become system notifications until he is back.
 */
function hide(minutes = 0) {
  if (settings.Down) {
    return;
  }
  clearTimeout(hiddenTimer);
  hiddenTimer = null;
  const already = Boolean(hidden);
  hidden = { until: minutes > 0 ? Date.now() + minutes * 60000 : 0 };
  if (minutes > 0) {
    hiddenTimer = setTimeout(showAgain, minutes * 60000);
  }
  log.write(`Hidden ${minutes > 0 ? `for ${minutes} min` : 'until brought back'}; reminders become notifications`);
  if (!already) {
    leave();
  }
  refreshTrayIfLinux();
}

/** Ends Hide him: he drops back in. */
function showAgain() {
  if (!hidden) {
    return;
  }
  clearTimeout(hiddenTimer);
  hiddenTimer = null;
  hidden = null;
  log.write('Shown again');
  if (settings.Down) {
    return;
  }
  clearTimeout(leaveTimer);
  const here = hangWin && !hangWin.isDestroyed();
  if (!here) {
    hangWin = createOverlay('hang');
  }
  applyLayout({ arrive: !here });
  refreshTrayIfLinux();
}

/** ⌃⌥⇧H: hides him, or brings him back from hiding or from being taken down. */
function toggleHidden() {
  if (settings.Down) {
    bringBack();
  } else if (hidden) {
    showAgain();
  } else {
    hide(0);
  }
}

function refreshTrayIfLinux() {
  if (isLinux) {
    refreshTrayMenu();
  }
}

/** Brings him back for good: he drops in at his spot, and reminders are bubbles again. */
function bringBack() {
  if (hidden) {
    showAgain();
    return;
  }
  if (!settings.Down) {
    return;
  }
  settings.Down = false;
  settings.save();
  log.write('Brought back');
  clearTimeout(leaveTimer);
  const here = hangWin && !hangWin.isDestroyed();
  if (!here) {
    hangWin = createOverlay('hang');
  }
  // In the middle of a visit he is already here: he just stays, in an ordinary window.
  applyLayout({ arrive: !here });
  visiting = false;
}

/** Reminders that were still waiting when he was taken down: delivered in a visit once he is gone. */
let requeued = [];

ipcMain.on('requeue', (event, items) => {
  if (windowOf(event) === hangWin && Array.isArray(items)) {
    requeued = items.slice(0, 5)
      .filter((i) => i && typeof i.text === 'string' && i.text.trim())
      .map((i) => ({ text: i.text.slice(0, reminders.MAX_TEXT), style: reminders.cleanStyle(i.style) }));
  }
});

ipcMain.on('gone', (event) => {
  // He has climbed out: close his window, unless he was brought back meanwhile.
  if (windowOf(event) === hangWin && (settings.Down || hidden)) {
    closeOverlay();
    const items = requeued;
    requeued = [];
    for (const item of items) {
      remind({ kind: 'waiting', text: item.text, style: item.style });
    }
  }
});

/**
 * A Big web reminder's text is all there: moving the mouse anywhere now closes it. The overlay only
 * hears the mouse over itself, so the pointer is checked 5 times a second, only until it closes.
 */
let pointerWatch = null;

function stopPointerWatch() {
  clearInterval(pointerWatch);
  pointerWatch = null;
}

ipcMain.on('web-typed', (event) => {
  const win = windowOf(event);
  if (win !== hangWin) {
    return;
  }
  stopPointerWatch();
  const from = screen.getCursorScreenPoint();
  const until = Date.now() + 15000; // it closes by itself well before this
  pointerWatch = setInterval(() => {
    if (!hangWin || hangWin.isDestroyed() || hangWin !== win || Date.now() > until) {
      stopPointerWatch();
      return;
    }
    const now = screen.getCursorScreenPoint();
    if (Math.hypot(now.x - from.x, now.y - from.y) > 4) {
      stopPointerWatch();
      log.write('Mouse moved: Big web reminder closed');
      post(hangWin, 'dismiss');
    }
  }, 200);
});

ipcMain.on('visit-done', (event) => {
  // The last reminder of a visit has closed: he climbs out again.
  if (windowOf(event) === hangWin && settings.Down && visiting) {
    leave();
  }
});

function toggleReminder(key) {
  settings[key] = !settings[key];
  remindersChanged();
}

function setWaterMinutes(minutes) {
  settings.WaterMinutes = reminders.cleanWaterMinutes(minutes);
  remindersChanged();
}

function setLunchTime(time) {
  settings.LunchTime = reminders.cleanLunchTime(time);
  remindersChanged();
}

/** "remind in 10 Tea is ready" / "remind at 15:30 Call back": true if it was a one-off reminder. */
function addOnce(words) {
  const once = reminders.parseOnce(words, new Date());
  if (!once) {
    return false;
  }
  if (onceReminders.length >= 20) {
    log.write('One-off reminder refused: 20 are waiting already');
    return true;
  }
  onceReminders.push({ id: 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: once.at, text: once.text });
  log.write(`One-off reminder at ${once.at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}: ${once.text}`);
  reminderClock.start();
  return true;
}

function toggleCustomReminder(id) {
  settings.CustomReminders = settings.CustomReminders.map((r) => (r.id === id ? { ...r, on: !r.on } : r));
  remindersChanged();
}

/** Saves the reminder settings, restarts the reminder clock, and updates the Reminders window. */
function remindersChanged() {
  settings.save();
  const on = settings.CustomReminders.filter((r) => r.on).length;
  log.write(`Reminders: water ${settings.WaterReminder} every ${settings.WaterMinutes} min, lunch ${settings.LunchReminder} at ${settings.LunchTime}, ` +
    `custom ${settings.CustomReminders.length} (${on} on)`);
  reminderClock.start();
  if (remindersWin && !remindersWin.isDestroyed()) {
    remindersWin.webContents.send('reminders:changed', reminderState());
  }
}

/** What the Reminders window shows. */
function reminderState() {
  return {
    water: settings.WaterReminder,
    lunch: settings.LunchReminder,
    waterMinutes: settings.WaterMinutes,
    lunchTime: settings.LunchTime,
    waterChoices: reminders.WATER_CHOICES,
    custom: settings.CustomReminders.map((r) => ({ ...r, summary: reminders.describeCustom(r) })),
  };
}

// ---- Reminders window ------------------------------------------------------------------------

/** Opens the Reminders window, or brings it to the front if it is already open. */
function openReminders() {
  if (remindersWin && !remindersWin.isDestroyed()) {
    if (remindersWin.isMinimized()) {
      remindersWin.restore();
    }
    remindersWin.show();
    remindersWin.focus();
    return;
  }
  remindersWin = new BrowserWindow({
    width: 560,
    height: 720,
    minWidth: 400,
    minHeight: 460,
    show: false,
    title: 'Spidey Hang Reminders',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f5f5f7',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'reminders-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  if (!isMac) {
    remindersWin.removeMenu();
  }
  const win = remindersWin;
  // Links or new windows have no place here.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.once('ready-to-show', () => {
    if (isMac) {
      // The app has no Dock icon, so it has to be brought to the front for the window to show there.
      app.focus({ steal: true });
    }
    win.show();
    win.focus();
  });
  win.on('closed', () => {
    if (remindersWin === win) {
      remindersWin = null;
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'reminders.html'));
  log.write('Reminders window opened');
}

/** Only the Reminders window may read or change the reminders. */
const fromRemindersWindow = (event) => remindersWin && !remindersWin.isDestroyed() && event.sender === remindersWin.webContents;

ipcMain.handle('reminders:get', (event) => (fromRemindersWindow(event) ? reminderState() : null));

ipcMain.handle('reminders:save', (event, data) => {
  if (!fromRemindersWindow(event) || !data || typeof data !== 'object') {
    return null;
  }
  if (typeof data.water === 'boolean') {
    settings.WaterReminder = data.water;
  }
  if (typeof data.lunch === 'boolean') {
    settings.LunchReminder = data.lunch;
  }
  if (data.waterMinutes !== undefined) {
    settings.WaterMinutes = reminders.cleanWaterMinutes(data.waterMinutes);
  }
  if (typeof data.lunchTime === 'string' && reminders.parseClock(data.lunchTime)) {
    settings.LunchTime = reminders.parseClock(data.lunchTime);
  }
  if (Array.isArray(data.custom)) {
    // Cleaned like settings.json, which also drops the "summary" the window was given.
    settings.CustomReminders = reminders.cleanCustomList(data.custom);
  }
  remindersChanged();
  return reminderState();
});

ipcMain.handle('reminders:test', (event, data) => {
  const raw = data && typeof data === 'object' ? data.text : data;
  const clean = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, reminders.MAX_TEXT) : '';
  if (fromRemindersWindow(event) && clean) {
    remind({ kind: 'test', text: clean, style: reminders.cleanStyle(data && data.style) });
  }
});

function setAutoSwing(on) {
  settings.AutoSwing = on;
  settings.save();
  log.write(`Swing on his own: ${on}`);
  post(hangWin, 'flags', flags());
}

function toggleBreeze() {
  settings.Breeze = !settings.Breeze;
  settings.save();
  log.write(`Breeze: ${settings.Breeze}`);
  post(hangWin, 'flags', flags());
}

/** Turns one of the true/false settings over, saves it, and logs it. */
function toggleSetting(key, after) {
  settings[key] = !settings[key];
  settings.save();
  log.write(`${key}: ${settings[key]}`);
  if (after) {
    after();
  }
}

// ---- Web-swinging ------------------------------------------------------------------------

/**
 * Where a web-swing goes, in screen units on his screen: 'left', 'center', 'right', 'random'
 * (somewhere at least a quarter of the screen away), 'pointer', or a share of the width (0..1).
 * null if it cannot be worked out.
 */
function webTarget(where) {
  const area = workArea();
  const share = (f) => area.x + Math.max(0, Math.min(1, f)) * area.width;
  if (where === 'left') return share(0.12);
  if (where === 'center') return share(0.5);
  if (where === 'right') return share(0.88);
  if (where === 'pointer') return share((screen.getCursorScreenPoint().x - area.x) / area.width);
  if (where === 'random') {
    const now = lastLayout ? (lastLayout.anchorX - area.x) / area.width : settings.AnchorFraction;
    for (let i = 0; i < 20; i++) {
      const f = 0.08 + Math.random() * 0.84;
      if (Math.abs(f - now) > 0.25) return share(f);
    }
    return share(now < 0.5 ? 0.85 : 0.15);
  }
  const f = Number(where);
  return where !== '' && Number.isFinite(f) ? share(f) : null;
}

function webSwing(where) {
  const targetX = webTarget(where);
  if (targetX === null || !hangWin || hangWin.isDestroyed() || visiting) {
    return;
  }
  log.write(`Web-swing to ${where} (${Math.round(targetX)})`);
  post(hangWin, 'web-swing', { targetX });
}

// ---- Focus timer -------------------------------------------------------------------------

function startFocus(minutes) {
  focus.start(Date.now(), minutes);
  log.write(`Focus started: ${focus.describe(Date.now())}`);
  if (hangWin && !hangWin.isDestroyed() && !visiting && !hidden) {
    post(hangWin, 'remind', { kind: 'focus', text: "Focus time. I'll keep watch!", style: 'bubble' });
  }
  focusChanged();
}

function stopFocus() {
  if (!focus.running) {
    return;
  }
  focus.stop();
  log.write('Focus stopped');
  focusChanged();
}

function skipFocus() {
  const change = focus.skip(Date.now());
  if (change) {
    log.write(`Focus skipped to ${change.next}`);
    announceFocus(change);
  }
  focusChanged();
}

/** A part of the focus timer ended: he says so, and swings big at the end of a focus. */
function announceFocus(change) {
  remind({ kind: 'focus', text: focusMessage(change), style: 'bubble' });
  if (change.ended === 'focus' && !settings.Down && !hidden) {
    setTimeout(() => swing(1.6), 200);
  }
}

/** Shows the countdown and sets the timer for its next change, or clears both when it is off. */
function focusChanged() {
  clearTimeout(focusTimer);
  focusTimer = null;
  const now = Date.now();
  const label = focus.label(now);
  if (tray && !tray.isDestroyed()) {
    if (isMac) {
      tray.setTitle(label ? ' ' + label : '');
    }
    tray.setToolTip(label ? `Spidey Hang: ${label.startsWith('Break') ? label : 'Focus ' + label}` : 'Spidey Hang');
  }
  if (focus.running) {
    focusTimer = setTimeout(() => {
      const change = focus.update(Date.now());
      if (change) {
        log.write(`Focus: ${change.ended} ended, ${change.next} for ${change.minutes} min`);
        announceFocus(change);
      }
      focusChanged();
    }, focus.nextTick(now));
  }
  // Linux hands the whole menu over again to change it, which closes it if open: only when the part changes.
  if (focus.phase !== focusMenuPhase) {
    focusMenuPhase = focus.phase;
    refreshTrayIfLinux();
  }
}

function setFocusLength(key, minutes) {
  settings[key] = minutes;
  settings.save();
  log.write(`${key}: ${minutes}`);
}

// ---- Reacting to the computer ------------------------------------------------------------

/** Lock, unlock, sleep and wake. Only sets the state; whether he reacts is checked when it changes. */
function watchPower() {
  powerMonitor.on('lock-screen', () => doze('screen locked'));
  powerMonitor.on('unlock-screen', () => wakeUp('screen unlocked'));
  powerMonitor.on('suspend', () => doze('computer asleep'));
  powerMonitor.on('resume', () => {
    // Awake again, but maybe at a lock screen: the next look at the idle time decides.
    startIdleWatch(1000);
  });
}

/**
 * Looks at how long the keyboard and mouse have been untouched: every 30 s while you are here, every
 * 2 s while he dozes (so he greets you promptly). A main-process call; nothing is drawn.
 */
function startIdleWatch(wait) {
  clearTimeout(idleTimer);
  idleTimer = null;
  if (!settings.Reactions) {
    return;
  }
  idleTimer = setTimeout(checkIdle, wait !== undefined ? wait : dozing ? 3000 : 30000);
}

function checkIdle() {
  let state = 'unknown';
  let idleSeconds = 0;
  try {
    state = powerMonitor.getSystemIdleState(settings.IdleMinutes * 60);
    idleSeconds = powerMonitor.getSystemIdleTime();
  } catch {
    // Not available here: no dozing.
  }
  // Woken only by the keyboard or mouse used after he dozed off (not by the key press that sent "sleep").
  const usedSinceDoze = idleSeconds + 1 < (Date.now() - dozedAt) / 1000;
  if (state === 'locked') {
    doze('screen locked');
  } else if (!dozing && state === 'idle') {
    doze(`no keyboard or mouse for ${settings.IdleMinutes} min`);
  } else if (dozing && state === 'active' && usedSinceDoze) {
    wakeUp('you are back');
  }
  startIdleWatch();
}

/** forced: the "sleep" command, which works with reactions off too. */
function doze(why, forced = false) {
  if (dozing || (!settings.Reactions && !forced)) {
    return;
  }
  dozing = true;
  dozedAt = Date.now();
  log.write(`Dozing (${why})`);
  post(hangWin, 'mood', { doze: true });
  startIdleWatch();
}

function wakeUp(why, forced = false) {
  if (!dozing) {
    return;
  }
  dozing = false;
  log.write(`Awake (${why})`);
  post(hangWin, 'mood', { doze: false });
  greet(forced);
  startIdleWatch();
  scheduleAntic();
}

/** He stretches and greets you, if he is on screen. forced: the "wake" and "greet" commands. */
function greet(forced = false) {
  if ((!settings.Reactions && !forced) || !hangWin || hangWin.isDestroyed() || visiting || hidden || settings.Down) {
    return;
  }
  const { text, day } = reactions.greeting(new Date(), settings.LastGreeting);
  if (settings.LastGreeting !== day) {
    settings.LastGreeting = day;
    settings.save();
  }
  log.write(`Greeting: ${text}`);
  post(hangWin, 'remind', { kind: 'greet', text, style: 'bubble' });
}

/** From the overlay page: { level 0..1, charging }. A warning when it drops below 20% and 10%. */
ipcMain.on('battery', (event, data) => {
  if (windowOf(event) !== hangWin || !data || !settings.Reactions) {
    return;
  }
  const line = batteryWatch.report({ level: Number(data.level), charging: Boolean(data.charging) });
  if (line) {
    remind({ kind: 'battery', text: line, style: 'bubble' });
  }
});

function setReactions(on) {
  settings.Reactions = on;
  settings.save();
  log.write(`React to the computer: ${on}`);
  if (!on && dozing) {
    dozing = false;
    post(hangWin, 'mood', { doze: false });
  }
  startIdleWatch();
}

// ---- Little things he does on his own ----------------------------------------------------

/** Sets the timer for the next antic, 3 to 7 minutes away (nothing while they are off). */
function scheduleAntic() {
  clearTimeout(anticTimer);
  anticTimer = null;
  if (settings.Antics) {
    anticTimer = setTimeout(() => {
      doAntic(null, false);
      scheduleAntic();
    }, reactions.anticDelay());
  }
}

/**
 * Asks the page for one antic. Not while he dozes, is hidden or taken down, or during a focus
 * (forced: the "antic" command and "Do something now" ignore all but his window being there).
 */
function doAntic(kind, forced) {
  if (!hangWin || hangWin.isDestroyed() || visiting || hidden || settings.Down) {
    return;
  }
  if (!forced && (dozing || (focus && focus.phase === 'focus'))) {
    return;
  }
  const what = reactions.ANTICS.includes(kind) ? kind : reactions.pickAntic(Math.random, lastAntic);
  lastAntic = what;
  const data = { kind: what };
  if (what === 'say') {
    data.text = lastLine = reactions.pickLine(Math.random, lastLine);
  }
  log.write(`Antic: ${what}`);
  post(hangWin, 'antic', data);
}

// ---- Keyboard shortcuts ------------------------------------------------------------------

/** Control+Option+Shift (Ctrl+Alt+Shift) and a letter, anywhere. One another app has is skipped. */
const HOTKEYS = {
  H: () => toggleHidden(),
  S: () => swing(),
  W: () => webSwing('pointer'),
  F: () => (focus.running ? stopFocus() : startFocus()),
};

function applyHotkeys() {
  globalShortcut.unregisterAll();
  if (!settings.Hotkeys) {
    return;
  }
  for (const [key, fn] of Object.entries(HOTKEYS)) {
    const accelerator = `Control+Alt+Shift+${key}`;
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, fn);
    } catch {
      ok = false;
    }
    if (!ok) {
      log.write(`Keyboard shortcut ${accelerator} is taken by another app; skipped`);
    }
  }
}

function setHideInFullScreen(on) {
  settings.HideInFullScreen = on;
  settings.save();
  log.write(`Hide over full-screen apps: ${on}`);
  if (isMac && hangWin && !hangWin.isDestroyed()) {
    hangWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: !on });
  }
}

// ---- Measuring (the "metrics" command, npm run perf) -------------------------------------

let metricsId = 0;

/**
 * Writes to the log how much CPU (share of one core) and memory every process of the app used over
 * the next `seconds`, by process type, with the page's own heap and how many frames it drew.
 */
async function logMetrics(seconds) {
  const id = ++metricsId;
  const page = hangWin && !hangWin.isDestroyed() ? hangWin : null;
  const before = new Map(app.getAppMetrics().map((m) => [m.pid, m]));
  const startedAt = Date.now();
  post(page, 'metrics', { id, phase: 'start' });
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const after = app.getAppMetrics();
  const wall = (Date.now() - startedAt) / 1000;
  const fromPage = page ? await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 1000);
    const listener = (_event, data) => {
      if (data && data.id === id) {
        clearTimeout(timer);
        ipcMain.removeListener('metrics-data', listener);
        resolve(data);
      }
    };
    ipcMain.on('metrics-data', listener);
    post(page, 'metrics', { id, phase: 'end' });
  }) : null;

  const byType = new Map();
  let cpu = 0;
  let memory = 0;
  for (const m of after) {
    const old = before.get(m.pid);
    // Cumulative CPU seconds where Electron gives them, otherwise the average since the first sample.
    const share = old && Number.isFinite(m.cpu.cumulativeCPUUsage) && Number.isFinite(old.cpu.cumulativeCPUUsage)
      ? ((m.cpu.cumulativeCPUUsage - old.cpu.cumulativeCPUUsage) / wall) * 100
      : m.cpu.percentCPUUsage;
    const mb = (m.memory.workingSetSize || 0) / 1024;
    const t = byType.get(m.type) || { cpu: 0, memory: 0 };
    t.cpu += share;
    t.memory += mb;
    byType.set(m.type, t);
    cpu += share;
    memory += mb;
  }
  const parts = [...byType].map(([type, t]) => `${type} ${t.cpu.toFixed(1)}% ${Math.round(t.memory)} MB`).join(', ');
  const pageText = fromPage
    ? `, page heap ${fromPage.heapMB === null ? '-' : fromPage.heapMB.toFixed(1) + ' MB'}, frames ${fromPage.frames} (${(fromPage.frames / wall).toFixed(1)} per second)`
    : ', no page';
  log.write(`Metrics over ${wall.toFixed(1)} s: CPU ${cpu.toFixed(1)}%, memory ${Math.round(memory)} MB, processes ${after.length} (${parts})${pageText}`);
}

function toggleStartAutomatically() {
  settings.StartAutomatically = !settings.StartAutomatically;
  settings.save();
  startup.sync(settings.StartAutomatically, signInCommand());
}

function quit() {
  log.write('Exit');
  globalShortcut.unregisterAll();
  for (const t of [focusTimer, idleTimer, anticTimer, hiddenTimer]) {
    clearTimeout(t);
  }
  clearInterval(displayTimer);
  if (reminderClock) {
    reminderClock.stop();
  }
  if (server) {
    server.close();
  }
  if (tray) {
    tray.destroy();
  }
  app.exit(0);
}

/**
 * Commands from the command channel. Anything else is ignored.
 *   push [strength]      swing him
 *   reset                hang him straight
 *   swing on|off|toggle  keep swinging on his own, or not
 *   hero next | hero <name> | rotate <minutes>
 *   snapshot <x.png>     save what the overlay is drawing right now
 *   capture <x.png>      save his whole window as it looks now, the bubble and the Big web's text too
 *   stats                write frame timing to the log
 *   metrics [seconds]    write CPU and memory of every process, over that long (10 s), to the log
 *   breeze on|off|toggle sway in a light breeze, or not
 *   remind water|lunch   show that reminder now
 *   remind <text>        show any text in his speech bubble
 *   remind-web <text>    the same as a Big web reminder (a big web only while he is taken down)
 *   dismiss              close the reminder showing now
 *   down | up            take him down (he waits in the tray) | bring him back
 *   reminders            open the Reminders window
 *   remind in <min> <text> | remind at <time> <text>   a one-off reminder (kept in memory only)
 *   travel               swing across to the other side of the screen
 *   web left|center|right|random|pointer|<0..1>        web-swing there
 *   focus start [min] | stop | skip | status           the focus timer
 *   hide [min] | show    hide him (for that many minutes), or show him again
 *   antic [wiggle|bungee|swing|say|web]               do a little something now
 *   sleep | wake | greet doze off, wake up (with a greeting), or just greet
 *   exit                 quit
 */
function handleCommand(raw) {
  if (!settings) {
    return;
  }
  const line = raw.trim();
  const parts = line.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return;
  }
  const rest = (word) => line.slice(word.length).trim();
  switch (parts[0]) {
    case 'swing':
      if (parts.length === 2) {
        setAutoSwing(parts[1] === 'on' ? true : parts[1] === 'off' ? false : !settings.AutoSwing);
      }
      break;
    case 'snapshot': {
      const file = rest('snapshot');
      if (!file.toLowerCase().endsWith('.png')) {
        log.write(`Snapshot refused, not a .png path: ${file}`);
      } else {
        post(hangWin, 'snapshot', { path: file });
      }
      break;
    }
    case 'capture': {
      const file = rest('capture');
      if (!file.toLowerCase().endsWith('.png') || !hangWin || hangWin.isDestroyed()) {
        log.write(`Capture refused: ${file}`);
      } else {
        hangWin.webContents.capturePage().then(
          (image) => {
            fs.writeFileSync(file, image.toPNG());
            log.write(`Captured: ${file}`);
          },
          (err) => log.write(`Capture failed: ${err.message}`)
        );
      }
      break;
    }
    case 'stats':
      post(hangWin, 'stats');
      break;
    case 'metrics': {
      const seconds = parts.length > 1 ? Number(parts[1]) : 10;
      logMetrics(Number.isFinite(seconds) ? Math.max(1, Math.min(120, seconds)) : 10);
      break;
    }
    case 'breeze': {
      const want = parts[1] === 'on' ? true : parts[1] === 'off' ? false : parts[1] === 'toggle' ? !settings.Breeze : null;
      if (parts.length === 2 && want !== null && want !== settings.Breeze) {
        toggleBreeze();
      }
      break;
    }
    case 'hero':
      if (parts.length === 2 && parts[1] === 'next') {
        nextHero();
      } else if (parts.length >= 2) {
        setHero(rest('hero'));
      }
      break;
    case 'rotate':
      if (parts.length === 2 && /^\d+$/.test(parts[1])) {
        setRotate(Number(parts[1]));
      }
      break;
    case 'push': {
      const value = parts.length > 1 ? Number(parts[1]) : 1;
      swing(Number.isFinite(value) ? Math.max(0, Math.min(3, value)) : 1);
      break;
    }
    case 'reset':
      if (!visiting) {
        applyLayout();
      }
      break;
    case 'remind': {
      const what = rest('remind');
      if (Object.hasOwn(reminders.TEXT, what)) {
        remind({ kind: what, text: reminders.TEXT[what] });
      } else if (/^(in|at)\s+\d/i.test(what)) {
        // A one-off reminder, for later; one whose time cannot be read is not shown now by mistake.
        if (!addOnce(what)) {
          log.write(`One-off reminder refused, time not understood: ${what}`);
        }
      } else if (what) {
        remind({ kind: 'note', text: what });
      }
      break;
    }
    case 'remind-web': {
      const what = rest('remind-web');
      if (what) {
        remind({ kind: 'note', text: what, style: 'web' });
      }
      break;
    }
    case 'dismiss':
      post(hangWin, 'dismiss');
      break;
    case 'down':
      takeDown();
      break;
    case 'up':
      bringBack();
      break;
    case 'reminders':
      openReminders();
      break;
    case 'travel':
      post(hangWin, 'travel');
      break;
    case 'web':
      if (parts.length === 2) {
        webSwing(parts[1]);
      }
      break;
    case 'focus': {
      const sub = parts[1] || 'status';
      if (sub === 'start') {
        const minutes = Number(parts[2]);
        startFocus(Number.isFinite(minutes) && minutes > 0 ? minutes : undefined);
      } else if (sub === 'stop') {
        stopFocus();
      } else if (sub === 'skip') {
        skipFocus();
      } else if (sub === 'status') {
        log.write(`Focus status: ${focus.describe(Date.now())}`);
      }
      break;
    }
    case 'hide': {
      const minutes = Number(parts[1] || 0);
      hide(Number.isFinite(minutes) && minutes > 0 ? Math.min(24 * 60, minutes) : 0);
      break;
    }
    case 'show':
      showAgain();
      break;
    case 'antic':
      doAntic(parts[1] || null, true);
      break;
    case 'sleep':
      doze('the sleep command', true);
      break;
    case 'wake':
      wakeUp('the wake command', true);
      break;
    case 'greet':
      greet(true);
      break;
    case 'exit':
      quit();
      break;
    default:
      break; // "ping" and anything unknown
  }
}

// ---- Tray and menu ---------------------------------------------------------------------------

function trayIcon() {
  const file = path.join(__dirname, 'assets', isMac ? 'trayTemplate.png' : 'tray.png');
  const image = nativeImage.createFromPath(file);
  if (isMac) {
    image.setTemplateImage(true);
  }
  return image;
}

function createTray() {
  try {
    tray = new Tray(trayIcon());
  } catch (err) {
    log.write(`No tray icon: ${err.message}`);
    return;
  }
  tray.setToolTip('Spidey Hang');
  if (isWindows) {
    // Left-click swings him (or brings him back). Right-click opens the menu.
    tray.on('click', () => (settings.Down || hidden ? bringBack() : swing()));
    tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
  } else if (isMac) {
    // On a Mac, clicking a menu bar icon opens its menu. "Give him a swing" is the first item.
    tray.on('click', () => tray.popUpContextMenu(buildMenu()));
    tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
  } else {
    // Linux (Ubuntu's AppIndicator): the desktop shows the menu itself and never asks for a fresh
    // one, so it is handed over again after every change (refreshTrayMenu). Clicks on the icon only
    // open the menu there; "Give him a swing" is its first item.
    tray.setContextMenu(buildMenu());
    tray.on('click', () => (settings.Down || hidden ? bringBack() : swing()));
    const save = settings.save.bind(settings);
    settings.save = () => {
      save();
      refreshTrayMenu();
    };
  }
  for (const message of unseenProblems.splice(0)) {
    showProblem(message);
  }
}

/** Linux: a new menu for the tray, after the old one has finished handling its click. */
function refreshTrayMenu() {
  setImmediate(() => {
    if (tray && !tray.isDestroyed()) {
      tray.setContextMenu(buildMenu());
    }
  });
}

/** Right-clicking him opens the same menu as the tray, at the pointer. */
function showMenuAtCursor(win) {
  const menu = buildMenu();
  if (isWindows && tray) {
    // The tray's own popup brings the menu to the front first. Without that it would not close when
    // you click somewhere else, because the overlay never takes the focus.
    tray.popUpContextMenu(menu, screen.getCursorScreenPoint());
  } else {
    menu.popup(win ? { window: win } : {});
  }
}

/** A reminder's text, short enough for a menu, with & shown as itself (Windows menus treat it as a shortcut key). */
function menuText(text) {
  const short = text.length > 40 ? text.slice(0, 39).trimEnd() + '…' : text;
  return isWindows ? short.replace(/&/g, '&&') : short;
}

function radio(label, checked, click) {
  return { label, type: 'radio', checked, click };
}

/** "3:00 PM" from 'HH:MM'. */
const clockLabel = (time) => reminders.clockTime(time);

/** Lunch times offered in the menu, with the current one added if it is not among them. */
function lunchChoices() {
  const list = ['11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '15:00'];
  return list.includes(settings.LunchTime) ? list : [...list, settings.LunchTime].sort();
}

/** The screens as menu items: the main one, each other one, and following the pointer. */
function screenMenu() {
  const primary = screen.getPrimaryDisplay();
  const others = screen.getAllDisplays().filter((d) => d.id !== primary.id);
  const named = settings.Display && settings.Display !== 'pointer' && others.some((d) => String(d.id) === settings.Display);
  return {
    label: 'Screen',
    submenu: [
      radio('Main screen', !settings.Display || (!named && settings.Display !== 'pointer'), () => setDisplay('')),
      ...others.map((d, i) => radio(`${d.label || `Screen ${i + 2}`} (${d.size.width}×${d.size.height})`, settings.Display === String(d.id), () => setDisplay(String(d.id)))),
      { type: 'separator' },
      radio('Follow the pointer', settings.Display === 'pointer', () => setDisplay('pointer')),
    ],
  };
}

function focusMenu() {
  const now = Date.now();
  const lengths = (key, values) => values.map((m) => radio(`${m} minutes`, settings[key] === m, () => setFocusLength(key, m)));
  const add = (key, values) => (values.includes(settings[key]) ? values : [...values, settings[key]].sort((a, b) => a - b));
  return {
    label: focus.running ? `Focus timer (${focus.label(now)})` : 'Focus timer',
    submenu: [
      ...(focus.running ? [{ label: focus.describe(now), enabled: false }] : []),
      focus.running
        ? { label: 'Stop', accelerator: 'Control+Alt+Shift+F', registerAccelerator: false, click: stopFocus }
        : { label: `Start a ${settings.FocusMinutes} minute focus`, accelerator: 'Control+Alt+Shift+F', registerAccelerator: false, click: () => startFocus() },
      ...(focus.running ? [{ label: focus.phase === 'focus' ? 'Skip to the break' : 'Skip to the next focus', click: skipFocus }] : []),
      { type: 'separator' },
      { label: 'Focus length', submenu: lengths('FocusMinutes', add('FocusMinutes', [15, 25, 30, 45, 50, 60])) },
      { label: 'Short break', submenu: lengths('ShortBreakMinutes', add('ShortBreakMinutes', [3, 5, 10])) },
      { label: 'Long break (every 4th)', submenu: lengths('LongBreakMinutes', add('LongBreakMinutes', [10, 15, 20, 30])) },
    ],
  };
}

/** Built fresh each time it opens, so the current choices always show. */
function buildMenu() {
  const relayout = (apply) => () => {
    apply();
    settings.save();
    applyLayout();
  };
  const current = settings.Hero.toLowerCase();
  const heroItems = heroes.scan().filter((hero) => hero.usable).map((hero) =>
    ({ label: hero.user ? `${hero.name} (yours)` : hero.name, type: 'checkbox', checked: hero.name.toLowerCase() === current, click: () => setHero(hero.name) }));

  const waterValues = reminders.WATER_CHOICES.includes(settings.WaterMinutes) ? reminders.WATER_CHOICES : [...reminders.WATER_CHOICES, settings.WaterMinutes].sort((a, b) => a - b);
  const remindersMenu = {
    label: 'Reminders',
    submenu: [
      { label: `Drink water every ${settings.WaterMinutes} minutes`, type: 'checkbox', checked: settings.WaterReminder, click: () => toggleReminder('WaterReminder') },
      { label: 'Water every', submenu: waterValues.map((m) => radio(m % 60 === 0 ? (m === 60 ? '1 hour' : `${m / 60} hours`) : `${m} minutes`, settings.WaterMinutes === m, () => setWaterMinutes(m))) },
      { label: `Lunch at ${clockLabel(settings.LunchTime)}`, type: 'checkbox', checked: settings.LunchReminder, click: () => toggleReminder('LunchReminder') },
      { label: 'Lunch time', submenu: lunchChoices().map((t) => radio(clockLabel(t), settings.LunchTime === t, () => setLunchTime(t))) },
      ...(settings.CustomReminders.length ? [{ type: 'separator' }] : []),
      ...settings.CustomReminders.map((r) => ({
        label: `${menuText(r.text)}  (${reminders.describeCustom(r)})`,
        type: 'checkbox',
        checked: r.on,
        click: () => toggleCustomReminder(r.id),
      })),
      ...(onceReminders.length ? [{ type: 'separator' }] : []),
      ...onceReminders.map((o) => ({ label: `${menuText(o.text)}  (at ${o.at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}, once)`, enabled: false })),
      { type: 'separator' },
      { label: 'Edit your reminders…', click: openReminders },
      { label: 'Show a test reminder', click: () => remind({ kind: 'water', text: reminders.TEXT.water }) },
    ],
  };
  const startItem = {
    label: isWindows ? 'Start automatically with Windows' : isMac ? 'Start automatically at login' : 'Start automatically at sign-in',
    type: 'checkbox',
    checked: settings.StartAutomatically,
    click: toggleStartAutomatically,
  };
  const hotkeyItem = {
    label: `Keyboard shortcuts (${isMac ? '⌃⌥⇧' : 'Ctrl+Alt+Shift+'} H hide, S swing, W web-swing, F focus)`,
    type: 'checkbox',
    checked: settings.Hotkeys,
    click: () => toggleSetting('Hotkeys', applyHotkeys),
  };
  const fullScreenItem = isMac
    ? [{ label: 'Hide over full-screen apps', type: 'checkbox', checked: settings.HideInFullScreen, click: () => setHideInFullScreen(!settings.HideInFullScreen) }]
    : [];
  const quitItem = { label: 'Quit Spidey Hang', click: quit };

  if (settings.Down || hidden) {
    const until = hidden && hidden.until ? ` (back at ${new Date(hidden.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})` : '';
    return Menu.buildFromTemplate([
      { label: hidden ? `Show him${until}` : 'Bring him back', accelerator: 'Control+Alt+Shift+H', registerAccelerator: false, click: hidden ? showAgain : bringBack },
      { type: 'separator' },
      focusMenu(),
      remindersMenu,
      { type: 'separator' },
      hotkeyItem,
      startItem,
      quitItem,
    ]);
  }

  const personality = {
    label: 'Personality',
    submenu: [
      { label: 'React to the computer (doze, greet, battery)', type: 'checkbox', checked: settings.Reactions, click: () => setReactions(!settings.Reactions) },
      { label: 'Doze after', enabled: settings.Reactions, submenu: [2, 5, 10, 15, 30].map((m) => radio(`${m} minutes away`, settings.IdleMinutes === m, () => {
        settings.IdleMinutes = m;
        settings.save();
        log.write(`Doze after: ${m} min`);
      })) },
      { type: 'separator' },
      { label: 'Do little things on his own', type: 'checkbox', checked: settings.Antics, click: () => toggleSetting('Antics', scheduleAntic) },
      { label: 'Do something now', click: () => doAntic(null, true) },
      { type: 'separator' },
      { label: 'Sounds', type: 'checkbox', checked: settings.Sounds, click: () => toggleSetting('Sounds', () => post(hangWin, 'flags', flags())) },
    ],
  };

  const template = [
    { label: 'Give him a swing', accelerator: 'Control+Alt+Shift+S', registerAccelerator: false, click: () => swing() },
    {
      label: 'Web-swing to',
      submenu: [
        { label: 'Left', click: () => webSwing('left') },
        { label: 'Center', click: () => webSwing('center') },
        { label: 'Right', click: () => webSwing('right') },
        { label: 'Somewhere else', click: () => webSwing('random') },
        { label: 'Where the pointer is', accelerator: 'Control+Alt+Shift+W', registerAccelerator: false, click: () => webSwing('pointer') },
        { type: 'separator' },
        { label: 'Across the screen', click: () => post(hangWin, 'travel') },
      ],
    },
    { label: 'Reset', click: () => applyLayout() },
    { type: 'separator' },
    {
      label: 'Position',
      submenu: [['Left', 0.12], ['Center', 0.5], ['Right', 0.88]].map(([name, fraction]) =>
        radio(name, Math.abs(settings.AnchorFraction - fraction) < 0.005, relayout(() => (settings.AnchorFraction = fraction)))),
    },
    { label: 'Size', submenu: ['Small', 'Medium', 'Large'].map((n) => radio(n, settings.Size === n, relayout(() => (settings.Size = n)))) },
    { label: 'Rope length', submenu: ['Short', 'Medium', 'Long'].map((n) => radio(n, settings.Rope === n, relayout(() => (settings.Rope = n)))) },
    screenMenu(),
    {
      label: 'Hero',
      submenu: [
        ...heroItems,
        ...(heroItems.length ? [{ type: 'separator' }] : []),
        { label: DRAWN, type: 'checkbox', checked: current === DRAWN.toLowerCase(), click: () => setHero(DRAWN) },
        { type: 'separator' },
        { label: 'Change hero every', submenu: [0, 2, 5, 10, 30].map((m) => radio(m === 0 ? 'Never' : `${m} minutes`, settings.RotateMinutes === m, () => setRotate(m))) },
        { label: 'Next hero', click: nextHero },
        { type: 'separator' },
        { label: 'Add a hero from a picture…', click: addHeroFromPicture },
        { label: 'Open your heroes folder', click: openHeroesFolder },
        { label: 'Reload heroes', click: reloadHeroes },
      ],
    },
    { label: 'Swing on his own', type: 'checkbox', checked: settings.AutoSwing, click: () => setAutoSwing(!settings.AutoSwing) },
    { label: 'Breeze', type: 'checkbox', checked: settings.Breeze, click: toggleBreeze },
    personality,
    focusMenu(),
    remindersMenu,
    { type: 'separator' },
    {
      label: 'Hide him',
      submenu: [
        { label: 'For 15 minutes', click: () => hide(15) },
        { label: 'For 1 hour', click: () => hide(60) },
        { label: 'Until you bring him back', accelerator: 'Control+Alt+Shift+H', registerAccelerator: false, click: () => hide(0) },
      ],
    },
    { label: 'Take him down', click: takeDown },
    { type: 'separator' },
    hotkeyItem,
    ...fullScreenItem,
    startItem,
    quitItem,
  ];
  return Menu.buildFromTemplate(template);
}

// ---- Problems --------------------------------------------------------------------------------

function raiseProblem(message) {
  log.write('PROBLEM ' + message);
  if (!tray) {
    // The tray is made after the first look loads; show these once it exists.
    unseenProblems.push(message);
    return;
  }
  showProblem(message);
}

function showProblem(message) {
  if (isWindows && tray) {
    tray.displayBalloon({ title: 'Spidey Hang', content: message, iconType: 'warning' });
  } else if (Notification.isSupported()) {
    new Notification({ title: 'Spidey Hang', body: message, silent: true }).show();
  }
}

// ---- Offline tests ---------------------------------------------------------------------------

async function runTest() {
  const after = (flag) => args.slice(args.indexOf(flag) + 1);
  let job;
  let out;
  try {
    if (has('--snapshot')) {
      const a = after('--snapshot');
      out = a[0];
      const folder = a[3] && a[3] !== '-' ? a[3] : null;
      // A hero folder: all its poses, so the log shows the pose changing with the motion.
      const look = folder ? heroLook(heroes.readFolder(folder)) : null;
      job = { kind: 'snapshot', seconds: Number(a[1] || 1), kick: Number(a[2] || 0), look, swing: a[5] === 'swing', edge: Number(a[6] || 0) };
    } else {
      out = after('--export-figure')[0];
      job = { kind: 'export-figure' };
    }
    if (!out) {
      throw new Error('No output file given.');
    }
  } catch (err) {
    process.stderr.write(`Test failed: ${err.message}\n`);
    app.exit(1);
    return;
  }

  const win = createOverlay('test', false);
  ipcMain.once('test-done', (_event, result) => {
    if (!result.ok) {
      process.stderr.write(`Test failed: ${result.error}\n`);
      app.exit(1);
      return;
    }
    fs.writeFileSync(out, Buffer.from(result.bytes));
    if (result.log) {
      fs.writeFileSync(out + '.log', result.log);
    }
    process.stdout.write(`Wrote ${out}\n`);
    win.destroy();
    app.exit(0);
  });
  post(win, 'test', job);
}

