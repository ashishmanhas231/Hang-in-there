const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn, execFile } = require('child_process');

/** Shared with the desktop app: settings, log, pictures, and the one app copy everybody launches. */
const DATA_DIR = path.join(os.homedir(), '.spidey-hang');
const APP_DIR = path.join(DATA_DIR, 'app');
const APP_FILES = ['SpideyHang.exe', 'SpideyHang.dll', 'SpideyHang.runtimeconfig.json', 'SpideyHang.deps.json'];

const VIEW_ID = 'spideyHang.view';

/** The desktop overlay listens here. Only the current Windows user can connect. */
const PIPE = '\\\\.\\pipe\\SpideyHang';

/** Every live webview (sidebar view and editor tab). Commands post messages to all of them. */
const webviews = new Set();

function config() {
  return vscode.workspace.getConfiguration('spideyHang');
}

function readSettings() {
  return {
    idleBreeze: config().get('idleBreeze', true),
  };
}

function broadcast(message) {
  for (const webview of webviews) {
    webview.postMessage(message);
  }
}

// ---- Desktop overlay ----------------------------------------------------------------------

/** Sends one line to the desktop overlay. Resolves false if it is not running. */
function sendToDesktop(command) {
  if (process.platform !== 'win32') {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const socket = net.connect(PIPE);
    socket.setTimeout(1000);
    socket.once('connect', () => socket.end(command + '\n', () => resolve(true)));
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** "ping" is not a real command. The overlay ignores it, so a successful send just means it is running. */
function isDesktopRunning() {
  return sendToDesktop('ping');
}

/** Compares dotted versions. Returns > 0 if a is newer than b. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/**
 * Returns the exe to launch: the shared copy in %USERPROFILE%\.spidey-hang\app, refreshed from
 * this extension first if this extension is newer.
 *
 * Why one shared copy: VS Code keeps running the extension version it loaded at startup until the
 * window is reloaded. Launching from each version's own folder meant a window that had not been
 * reloaded started an old Spidey without the newer features. Never copy an older version over a newer one,
 * or an old window would undo an update.
 */
function desktopExe(extensionPath, version) {
  const ownExe = path.join(extensionPath, 'bin', 'SpideyHang.exe');
  const stamp = path.join(APP_DIR, 'version.txt');
  try {
    const shared = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8').trim() : '0';
    if (compareVersions(version, shared) > 0 || !fs.existsSync(path.join(APP_DIR, 'SpideyHang.exe'))) {
      fs.mkdirSync(APP_DIR, { recursive: true });
      for (const file of APP_FILES) {
        fs.copyFileSync(path.join(extensionPath, 'bin', file), path.join(APP_DIR, file));
      }
      fs.writeFileSync(stamp, version);
    }
    return path.join(APP_DIR, 'SpideyHang.exe');
  } catch (err) {
    // Shared copy busy or unwritable: this extension's own copy still works.
    return ownExe;
  }
}

/** `app` is { path, version } of this extension. */
async function startDesktop(app, quiet) {
  if (process.platform !== 'win32') {
    if (!quiet) {
      vscode.window.showWarningMessage('Spidey on the desktop only works on Windows.');
    }
    return;
  }

  // Already up: give him a little wave instead of starting a second one.
  if (await sendToDesktop('push 0.6')) {
    return;
  }

  const exe = desktopExe(app.path, app.version);
  if (!fs.existsSync(exe)) {
    vscode.window.showErrorMessage(`Spidey's desktop app is missing: ${exe}`);
    return;
  }

  try {
    // Detached so he keeps hanging after this VS Code window closes. Take him down from the tray or the command.
    const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
    child.on('error', (err) => vscode.window.showErrorMessage(`Could not start Spidey: ${err.message}`));
    child.unref();
  } catch (err) {
    vscode.window.showErrorMessage(`Could not start Spidey: ${err.message}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Spidey's own settings.json. The extension and the app share its "StartAutomatically" switch. */
function appSettings() {
  try {
    const text = fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8').replace(/^﻿/, '');
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function sharedVersion() {
  try {
    return fs.readFileSync(path.join(APP_DIR, 'version.txt'), 'utf8').trim();
  } catch {
    return '0';
  }
}

/**
 * Runs once each time VS Code starts:
 * 1. If this extension carries a newer app than the shared copy, swap it in. A running Spidey holds
 *    those files open, so he is closed first and started again after.
 * 2. Runs "SpideyHang.exe --sync-startup", so the Windows sign-in entry matches his "Start automatically"
 *    switch. It has to come from here (or from a Spidey the user started): writes from a process that a
 *    Microsoft Store app started are redirected, and never reach the registry Windows reads at sign-in.
 * 3. Starts him if he should be running and is not.
 */
async function syncDesktopAtStartup(app) {
  if (process.platform !== 'win32') {
    return;
  }
  let running = await isDesktopRunning();
  const outdated = compareVersions(app.version, sharedVersion()) > 0 || !fs.existsSync(path.join(APP_DIR, 'SpideyHang.exe'));
  let restart = false;
  if (outdated && running) {
    await sendToDesktop('exit');
    for (let i = 0; i < 20 && (await isDesktopRunning()); i++) {
      await sleep(200);
    }
    await sleep(600); // let the old process let go of its files
    running = false;
    restart = true;
  }

  const exe = desktopExe(app.path, app.version);
  execFile(exe, ['--sync-startup'], { windowsHide: true }, () => {});

  const wanted = appSettings().StartAutomatically !== false || config().get('desktop.startWithVSCode', false);
  if (restart || (wanted && !running)) {
    await startDesktop(app, true);
  }
}

/** Starts the overlay if needed and waits (up to 5 seconds) until it answers. */
async function ensureDesktop(app) {
  if (await isDesktopRunning()) {
    return true;
  }
  await startDesktop(app, false);
  for (let i = 0; i < 25; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (await isDesktopRunning()) {
      return true;
    }
  }
  return false;
}

async function chooseDesktopPicture(app) {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Hang this picture',
    title: 'Choose a picture for Spidey (a PNG with a transparent background works best)',
    filters: { Pictures: ['png', 'webp', 'gif', 'bmp', 'jpg', 'jpeg'] },
  });
  if (!picked || picked.length === 0) {
    return;
  }
  if (!(await ensureDesktop(app))) {
    vscode.window.showErrorMessage('Could not start Spidey on the desktop.');
    return;
  }
  await sendToDesktop(`image ${picked[0].fsPath}`);
  vscode.window.showInformationMessage(
    'Picture sent. If he hangs from his hands instead of his feet, right-click him and choose Look > Flip my picture.'
  );
}

// ---- Heroes -------------------------------------------------------------------------------

const HEROES_DIR = path.join(DATA_DIR, 'heroes');
const PICTURE = /\.(png|webp|gif|bmp|jpe?g)$/i;

/** Hero folders, with how many pose pictures each has and whether it has an emblem. */
function listHeroes() {
  if (!fs.existsSync(HEROES_DIR)) {
    return [];
  }
  return fs
    .readdirSync(HEROES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const pictures = fs.readdirSync(path.join(HEROES_DIR, entry.name)).filter((f) => PICTURE.test(f));
      const emblem = pictures.some((f) => /^emblem\./i.test(f));
      return { name: entry.name, poses: pictures.length - (emblem ? 1 : 0), emblem };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function chooseHero(app) {
  const items = listHeroes().map((hero) => ({
    label: hero.name,
    description: hero.poses > 0 ? `${hero.poses} pose${hero.poses === 1 ? '' : 's'}`
      : hero.emblem ? 'emblem only, add poses'
      : 'no pictures yet',
    hero: hero.name,
    usable: hero.poses > 0 || hero.emblem,
  }));
  items.push({ label: 'Drawn Spider-Man', description: 'built in', hero: 'Drawn Spider-Man', usable: true });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Choose a hero',
    placeHolder: 'Type to filter. Add more heroes with "Spidey: Open Heroes Folder".',
  });
  if (!picked) {
    return;
  }
  if (!picked.usable) {
    const open = await vscode.window.showInformationMessage(
      `${picked.hero} has no pictures yet. Add hang.png (and swing.png, fly.png, grab.png) to their folder.`,
      'Open folder'
    );
    if (open) {
      openHeroesFolder(picked.hero);
    }
    return;
  }
  if (await ensureDesktop(app)) {
    await sendToDesktop(`hero ${picked.hero}`);
  }
}

function openHeroesFolder(hero) {
  const folder = hero ? path.join(HEROES_DIR, hero) : HEROES_DIR;
  fs.mkdirSync(folder, { recursive: true });
  vscode.env.openExternal(vscode.Uri.file(folder));
}

async function stopDesktop() {
  if (!(await sendToDesktop('exit'))) {
    vscode.window.showInformationMessage('Spidey is not on the desktop.');
  }
}

async function toggleDesktop(app) {
  if (await isDesktopRunning()) {
    await sendToDesktop('exit');
  } else {
    await startDesktop(app, false);
  }
}

function createStatusBarButton() {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.text = '🕷 Spidey';
  item.tooltip = 'Hang Spider-Man on the desktop. Click again to take him down.';
  item.command = 'spideyHang.desktop.toggle';
  return item;
}

function updateStatusBar(item) {
  if (process.platform === 'win32' && config().get('desktop.statusBarButton', true)) {
    item.show();
  } else {
    item.hide();
  }
}

// ---- Webviews -----------------------------------------------------------------------------

function getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function getHtml(webview, extensionUri) {
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'hang.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'hang.css'));
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${style}" rel="stylesheet">
  <title>Spidey Hang</title>
</head>
<body>
  <canvas id="stage"></canvas>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

/** Wires up a webview: scripts on, settings sent when the page says it is ready. */
function attach(webview, extensionUri) {
  webview.options = {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
  };
  webview.html = getHtml(webview, extensionUri);
  webviews.add(webview);

  return webview.onDidReceiveMessage((message) => {
    if (message && message.type === 'ready') {
      webview.postMessage({ type: 'settings', settings: readSettings() });
    }
  });
}

class SpideyViewProvider {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
  }

  resolveWebviewView(view) {
    const listener = attach(view.webview, this.extensionUri);
    view.onDidDispose(() => {
      listener.dispose();
      webviews.delete(view.webview);
    });
  }
}

function openInEditor(extensionUri) {
  const panel = vscode.window.createWebviewPanel(
    'spideyHang.panel',
    'Spidey',
    vscode.ViewColumn.Beside,
    { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] }
  );
  const listener = attach(panel.webview, extensionUri);
  panel.onDidDispose(() => {
    listener.dispose();
    webviews.delete(panel.webview);
  });
}

// ---- Activation ---------------------------------------------------------------------------

function activate(context) {
  const app = { path: context.extensionPath, version: context.extension.packageJSON.version };
  const provider = new SpideyViewProvider(context.extensionUri);
  const statusBar = createStatusBarButton();
  updateStatusBar(statusBar);

  const push = (strength) => {
    broadcast({ type: 'push', strength });
    sendToDesktop(`push ${strength}`);
  };

  context.subscriptions.push(
    statusBar,

    // Keeps his swing going when you switch sidebar tabs. The page is paused while hidden.
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand('spideyHang.openInEditor', () => openInEditor(context.extensionUri)),
    vscode.commands.registerCommand('spideyHang.push', () => push(1)),
    vscode.commands.registerCommand('spideyHang.reset', () => {
      broadcast({ type: 'reset' });
      sendToDesktop('reset');
    }),

    vscode.commands.registerCommand('spideyHang.desktop.start', () => startDesktop(app, false)),
    vscode.commands.registerCommand('spideyHang.desktop.stop', () => stopDesktop()),
    vscode.commands.registerCommand('spideyHang.desktop.toggle', () => toggleDesktop(app)),
    vscode.commands.registerCommand('spideyHang.desktop.choosePicture', () => chooseDesktopPicture(app)),
    vscode.commands.registerCommand('spideyHang.desktop.useDrawing', () => sendToDesktop('image off')),
    vscode.commands.registerCommand('spideyHang.desktop.toggleSwing', async () => {
      if (await ensureDesktop(app)) {
        await sendToDesktop('swing toggle');
      }
    }),
    vscode.commands.registerCommand('spideyHang.desktop.chooseHero', () => chooseHero(app)),
    vscode.commands.registerCommand('spideyHang.desktop.nextHero', async () => {
      if (await ensureDesktop(app)) {
        await sendToDesktop('hero next');
      }
    }),
    vscode.commands.registerCommand('spideyHang.desktop.openHeroesFolder', () => openHeroesFolder()),

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('spideyHang')) {
        broadcast({ type: 'settings', settings: readSettings() });
        updateStatusBar(statusBar);
      }
    }),

    vscode.workspace.onDidSaveTextDocument(() => {
      if (config().get('swingOnSave', false)) {
        push(0.5);
      }
    })
  );

  // Update the app if needed, keep the Windows sign-in entry right, and start Spidey if he should be up.
  syncDesktopAtStartup(app);
}

function deactivate() {}

module.exports = { activate, deactivate };
