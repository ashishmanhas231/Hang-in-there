'use strict';
/*
 * Spidey Hang: Electron main process. Runs on Windows, macOS and Linux (built and tested for Ubuntu).
 *
 *   npm start  /  the installed app       start the overlay; if it is already running, give him a swing
 *   ... --push [n] | --reset | --exit      send that to the running overlay
 *   ... --at-login                         what sign-in runs: waits a few seconds for the taskbar or Dock
 *   ... --reminders                        open the Reminders window (starting the overlay if needed)
 * Development only (not in the installed app), nothing appears on screen:
 *   ... --snapshot f.png [seconds] [kick] [hero folder|-] [-] [swing|-] [edge]
 *   ... --export-figure f.png
 */
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Tray, Menu, screen, ipcMain, nativeImage, nativeTheme, Notification } = require('electron');

const paths = require('./lib/paths');
const log = require('./lib/log');
const ipc = require('./lib/ipc');
const heroes = require('./lib/heroes');
const startup = require('./lib/startup');
const reminders = require('./lib/reminders');
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

/** What sign-in should run: this app (from source, Electron plus the project folder). */
function signInCommand() {
  return { exe: process.execPath, args: process.defaultApp ? [app.getAppPath(), '--at-login'] : ['--at-login'] };
}

function start() {
  settings = Settings.load();
  log.write(`Start ${app.getVersion()} (Electron ${process.versions.electron}, ${process.platform} ${process.arch}) from ${app.getAppPath()}${has('--at-login') ? ' at sign-in' : ''}. ` +
    `Settings: size ${settings.Size}, rope ${settings.Rope}, hero ${settings.Hero}, change hero every ${settings.RotateMinutes} min, start automatically ${settings.StartAutomatically}, ` +
    `custom reminders ${settings.CustomReminders.length}`);
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
  hangWin = createOverlay('hang');
  applyLayout();
  startRotateTimer();
  reminderClock = new reminders.ReminderClock(() => ({ water: settings.WaterReminder, lunch: settings.LunchReminder, custom: settings.CustomReminders }), remind);
  reminderClock.start();

  for (const event of ['display-metrics-changed', 'display-added', 'display-removed']) {
    screen.on(event, () => {
      clearTimeout(layoutTimer);
      layoutTimer = setTimeout(applyLayout, 300);
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
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
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

function workArea() {
  return screen.getPrimaryDisplay().workArea;
}

/** Sizes and places the hanging window from the settings, then hangs him straight with a small swing. */
function applyLayout() {
  if (!hangWin || hangWin.isDestroyed()) {
    return;
  }
  const area = workArea();
  const body = settings.bodyLength;
  const hang = body * (1 + REACH_PAST_HEAD);
  let rope = Math.max(60, settings.ropeFraction * area.height);
  rope = Math.min(rope, Math.max(60, area.height - hang - 30));
  const reach = rope + hang;
  // Wide enough for a full sideways swing. Not capped at the screen width: a squeezed window means
  // walls he can hit, and hitting them flung him over the top.
  const width = Math.round(2 * reach + 40);
  const height = Math.round(Math.min(area.height, reach + 30));
  let anchorX = area.x + Math.max(0, Math.min(1, settings.AnchorFraction)) * area.width;
  anchorX = Math.max(area.x + 20, Math.min(area.x + area.width - 20, anchorX));
  const asked = anchorX;
  if (settings.AutoSwing) {
    anchorX = Rig.roomToSwing(anchorX, rope, body, area);
  }
  // Always centred on the anchor, even if that runs past the screen edge.
  const left = Math.round(anchorX - width / 2);
  hangWin.setBounds({ x: left, y: area.y, width, height });
  lastLayout = { left, top: area.y, width, height, work: { x: area.x, y: area.y, width: area.width, height: area.height }, anchorX, rope, body };
  log.write(`Layout: screen ${area.x}..${area.x + area.width}, web at ${Math.round(anchorX)} (saved spot ${Math.round(asked)}), ` +
    `window ${left}..${left + width}, rope ${Math.round(rope)}, swing on his own ${settings.AutoSwing}`);
  post(hangWin, 'setup', { layout: { ...lastLayout }, flags: flags(), look: buildLook(), shapeMouse: isLinux });
}

const flags = () => ({ breeze: settings.Breeze, autoSwing: settings.AutoSwing });

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
      // From hero.json: where the web ties on (grip), how far he is turned (tilt), and where reminder
      // bubbles point (face, with its radius faceSize).
      const { grip, tilt, face, faceSize } = info.poseSettings[pose] || {};
      poses[pose] = { bytes: readBytes(file), file: path.basename(file), grip, tilt, face, faceSize };
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

/** Shows a reminder in a speech bubble above his face, or as a system notification if he is not up. */
function remind({ kind, text }) {
  log.write(`Reminder (${kind}): ${text}`);
  if (hangWin && !hangWin.isDestroyed() && hangWin.isVisible()) {
    post(hangWin, 'remind', { kind, text });
  } else if (Notification.isSupported()) {
    new Notification({ title: 'Spidey Hang', body: text }).show();
  }
}

function toggleReminder(key) {
  settings[key] = !settings[key];
  remindersChanged();
}

function toggleCustomReminder(id) {
  settings.CustomReminders = settings.CustomReminders.map((r) => (r.id === id ? { ...r, on: !r.on } : r));
  remindersChanged();
}

/** Saves the reminder settings, restarts the reminder clock, and updates the Reminders window. */
function remindersChanged() {
  settings.save();
  const on = settings.CustomReminders.filter((r) => r.on).length;
  log.write(`Reminders: water ${settings.WaterReminder}, lunch ${settings.LunchReminder}, ` +
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
  if (Array.isArray(data.custom)) {
    // Cleaned like settings.json, which also drops the "summary" the window was given.
    settings.CustomReminders = reminders.cleanCustomList(data.custom);
  }
  remindersChanged();
  return reminderState();
});

ipcMain.handle('reminders:test', (event, text) => {
  const clean = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, reminders.MAX_TEXT) : '';
  if (fromRemindersWindow(event) && clean) {
    remind({ kind: 'test', text: clean });
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
  post(hangWin, 'flags', flags());
}

function toggleStartAutomatically() {
  settings.StartAutomatically = !settings.StartAutomatically;
  settings.save();
  startup.sync(settings.StartAutomatically, signInCommand());
}

function quit() {
  log.write('Exit');
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
 *   stats                write frame timing to the log
 *   remind water|lunch   show that reminder now
 *   remind <text>        show any text in his speech bubble
 *   reminders            open the Reminders window
 *   travel               swing across to the other side of the screen
 *   exit                 close
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
    case 'stats':
      post(hangWin, 'stats');
      break;
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
      applyLayout();
      break;
    case 'remind': {
      const what = rest('remind');
      if (Object.hasOwn(reminders.TEXT, what)) {
        remind({ kind: what, text: reminders.TEXT[what] });
      } else if (what) {
        remind({ kind: 'note', text: what });
      }
      break;
    }
    case 'reminders':
      openReminders();
      break;
    case 'travel':
      post(hangWin, 'travel');
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
    // Left-click swings him. Right-click opens the menu.
    tray.on('click', () => swing());
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
    tray.on('click', () => swing());
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

/** Built fresh each time it opens, so the current choices always show. */
function buildMenu() {
  const relayout = (apply) => () => {
    apply();
    settings.save();
    applyLayout();
  };
  const current = settings.Hero.toLowerCase();
  const heroItems = heroes.scan().filter((hero) => hero.usable).map((hero) =>
    ({ label: hero.name, type: 'checkbox', checked: hero.name.toLowerCase() === current, click: () => setHero(hero.name) }));

  const template = [
    { label: 'Give him a swing', click: () => swing() },
    { label: 'Swing across the screen', click: () => post(hangWin, 'travel') },
    { label: 'Reset', click: () => applyLayout() },
    { type: 'separator' },
    {
      label: 'Position',
      submenu: [['Left', 0.12], ['Center', 0.5], ['Right', 0.88]].map(([name, fraction]) =>
        radio(name, Math.abs(settings.AnchorFraction - fraction) < 0.005, relayout(() => (settings.AnchorFraction = fraction)))),
    },
    { label: 'Size', submenu: ['Small', 'Medium', 'Large'].map((n) => radio(n, settings.Size === n, relayout(() => (settings.Size = n)))) },
    { label: 'Rope length', submenu: ['Short', 'Medium', 'Long'].map((n) => radio(n, settings.Rope === n, relayout(() => (settings.Rope = n)))) },
    {
      label: 'Hero',
      submenu: [
        ...heroItems,
        ...(heroItems.length ? [{ type: 'separator' }] : []),
        { label: DRAWN, type: 'checkbox', checked: current === DRAWN.toLowerCase(), click: () => setHero(DRAWN) },
        { type: 'separator' },
        { label: 'Change hero every', submenu: [0, 2, 5, 10, 30].map((m) => radio(m === 0 ? 'Never' : `${m} minutes`, settings.RotateMinutes === m, () => setRotate(m))) },
        { label: 'Next hero', click: nextHero },
      ],
    },
    { label: 'Swing on his own', type: 'checkbox', checked: settings.AutoSwing, click: () => setAutoSwing(!settings.AutoSwing) },
    { label: 'Breeze', type: 'checkbox', checked: settings.Breeze, click: toggleBreeze },
    {
      label: 'Reminders',
      submenu: [
        { label: 'Drink water every 30 minutes', type: 'checkbox', checked: settings.WaterReminder, click: () => toggleReminder('WaterReminder') },
        { label: 'Lunch at 3:00 PM', type: 'checkbox', checked: settings.LunchReminder, click: () => toggleReminder('LunchReminder') },
        ...(settings.CustomReminders.length ? [{ type: 'separator' }] : []),
        ...settings.CustomReminders.map((r) => ({
          label: `${menuText(r.text)}  (${reminders.describeCustom(r)})`,
          type: 'checkbox',
          checked: r.on,
          click: () => toggleCustomReminder(r.id),
        })),
        { type: 'separator' },
        { label: 'Add or edit reminders…', click: openReminders },
        { label: 'Show a test reminder', click: () => remind({ kind: 'water', text: reminders.TEXT.water }) },
      ],
    },
    { type: 'separator' },
    {
      label: isWindows ? 'Start automatically with Windows' : isMac ? 'Start automatically at login' : 'Start automatically at sign-in',
      type: 'checkbox',
      checked: settings.StartAutomatically,
      click: toggleStartAutomatically,
    },
    { label: 'Take him down (exit)', click: quit },
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

