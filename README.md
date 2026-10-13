# Spidey Hang

Spider-Man hangs upside down from a web at the top of your screen. Drag him and he swings.
A small desktop app for **Windows and macOS**, written in JavaScript (Electron).

Inspired by [Hangly for Windows](https://github.com/SharanCreatedThis/Hangly-Windows), a desktop
widget with a charm on a simulated rope. This project shares the idea only. No code or artwork
was copied.

## Run it

**From source** (needs [Node.js](https://nodejs.org) 22 or newer):

```bash
npm install
npm start
```

**As an app:** download the installer for your system from a release (or the **Build** workflow's
artifacts), or build it yourself:

```bash
npm run dist:win    # on Windows: dist/Spidey Hang Setup <version>.exe
npm run dist:mac    # on a Mac:   dist/Spidey Hang-<version>-arm64.dmg (Apple silicon) and -x64.dmg (Intel)
```

Each system's installer has to be built on that system (the GitHub workflow does both).

When the build finishes, Spidey appears straight away: the command closes any Spidey that is
already running and starts the copy it just built (`dist/win-unpacked`, or `dist/mac-arm64` /
`dist/mac` on a Mac). Set `SPIDEY_NO_LAUNCH=1` to only build. It never starts on CI.
The Windows installer also starts him as soon as it finishes installing.

The Windows installer is a one-click, per-user install (no admin rights). The macOS build is not
notarized, so the first time you open it, right-click the app and choose **Open**
(or allow it under System Settings > Privacy & Security).

### Size

The installed app is the Electron runtime plus about 200 KB of Spidey's own code, packed into one
`app.asar` file. The builds are trimmed: English-only locale files, maximum compression, one
architecture per installer, and no tests, docs or dev tools inside. Electron itself is most of the
download (roughly 100 MB on Windows), and that is the floor for any Electron app.

## Using him

- **Drag him** by the body or the rope. Let go to fling him.
- **Click him** for a nudge, or **brush the cursor across him** to push him.
- **Drag the little web knot** at the top of the screen to move where he hangs.
- **Right-click him** for the menu: position, size, rope length, hero, breeze, swing on his own, start
  automatically and exit. The same menu is on the tray icon (Windows: by the clock; macOS: the menu bar).
- **Windows:** left-click the tray icon to give him a swing. **macOS:** click the menu bar icon; "Give him
  a swing" is the first item.
- Starting the app again while he is up gives him a swing instead of opening a second one.

Clicks pass straight through everywhere except Spider-Man, the rope and the knot.
Grabbing him does not take keyboard focus away from the app you are using.
On macOS he has no Dock icon; he lives in the menu bar.

When he stops moving, the app stops drawing. It uses no CPU until you touch him again.
While he swings it uses a small share of one CPU core. **Breeze** and **Swing on his own** keep
him moving, so they use that all the time.

**Swing on his own** keeps a steady swing of about 30 degrees going, like pumping a playground swing.
If you drop the web too close to a screen edge, it slides back in just far enough for a full swing.

Reminders (**Reminders** in the menu): "Time to drink some water" on every half hour, and "It's your
lunch time" at 3:00 PM. They appear in a speech bubble just above his face, in every pose.

### Starting automatically

**Start automatically** in his menu is on by default. He then starts when you sign in:

- **Windows:** a "Spidey Hang" entry in `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
  (Task Manager > Startup apps). Uninstalling the app removes it.
- **macOS:** a login item, `~/Library/LaunchAgents/com.spideyhang.overlay.plist`
  (System Settings > General > Login Items).

It runs the app with `--at-login`, which waits 4 seconds for the taskbar or Dock first.
The entry is refreshed each time the app starts, so it always points at the copy you last ran.
Untick the option to remove it.

## Heroes

Pick one from **Hero** in the menu. **Hero > Change hero every** rotates through them on a timer.

| Hero | What you see |
|---|---|
| **Iconic Spidey - Upside Down** (the default) | The classic upside-down hang |
| **Iconic Spidey - Web Swing** | Mid-swing, holding the web in his fist |
| **Iconic Spidey - Both** | Upside down at rest, the swing pose while he moves |
| **Drawn Spider-Man** | The built-in drawing |

The iconic heroes are folders in `src/heroes/` that ship inside the app on Windows and macOS. That
folder is git-ignored, so its pictures are only in builds made from a copy that has them; other
builds show the drawn Spider-Man.

Each folder holds `hang.png` (at rest) and optionally `swing.png` (while he moves; also used while
you drag him or swing him up high). Poses cross-fade, and each must hold for 0.2 s before it shows, so
he does not flicker between them as he slows down. `hero.json` in the folder can set, per pose, in
the picture's own pixel coordinates:

- `"grip"`: where his hand holds the web, for a pose held by a fist mid-picture. The web ties on
  there and runs across the front of him, and the picture keeps its pose instead of tipping to balance.
  Without it the web ties on at the middle of the top edge and the picture tips until its weight
  hangs straight below.
- `"tilt"`: degrees to turn the picture (clockwise is positive).
- `"face"` with `"faceSize"` (its radius): reminder bubbles appear just above this spot.

```json
{ "line": "web",
  "poses": { "hang": { "tilt": -7, "faceSize": 75, "points": { "grip": [330, 518], "face": [290, 185] } } } }
```

The folders are read once at start, and each picture is read from disk once.

## Where things are kept

Everything lives in `~/.spidey-hang` (`%USERPROFILE%\.spidey-hang` on Windows): settings
(`settings.json`) and the log (`log.txt`). Problems are written to
the log along with each start and layout. Check it first if he misbehaves.

Not `%APPDATA%` on Windows: apps installed from the Microsoft Store have their AppData writes silently
redirected to a private copy, and so does anything they start. The profile folder is not redirected.

## Scripting

A running Spidey takes one-line text commands: `push [strength]`, `reset`, `swing on|off|toggle`,
`hero <name>|next`, `rotate <minutes>`, `remind water|lunch|<text>`, `snapshot <file.png>`, `stats`
and `exit`. They travel over the named pipe `\\.\pipe\SpideyHang` on
Windows and the Unix socket `~/.spidey-hang/spidey.sock` on macOS, which only your own account can open.
`snapshot` saves only what Spidey himself draws, never the screen behind it.

The app's command line takes `--push [n]`, `--reset` and `--exit` as well.

## How it works

```
src/
  main.js            Electron main process: windows, tray, menu, settings, sign-in entry
  lib/               plain Node: settings, heroes, reminders, log, command channel, sign-in entries
  heroes/            the iconic heroes' pictures (git-ignored)
  renderer/          the overlay page (no Node access; talks to main.js through preload.js)
    shared/          physics and drawing, no Electron in it, so the unit tests run it in plain Node
build/               app icons and the Windows uninstall step
test/                unit tests (plain Node) and an end-to-end test (real Electron)
```

The rope is a chain of points joined by fixed-length links (Verlet integration, 240 steps a second).
The last rope point is his ankle. A second point is his head, joined to the ankle by a fixed-length
link. That makes him swing like a double pendulum. The drawn Spider-Man is made from plain shapes
(`src/renderer/shared/figure.js`).

The physics has two pieces of "grip" between the rope and his body. One damps his body turning
faster or slower than the end of the rope. The other pulls his body back into line with the rope.
Without them the rope whips like a heavy chain and his body swings about twice as far as the rope.

The web line is drawn in layers: a soft shadow, several thin strokes side by side for rounded
shading, then twist marks on top so it reads as twisted silk. A splat of strands sticks it to the
top of the screen.

The window is transparent, always on top, and only as big as his swing needs. The page tells the
main process when the pointer is over something it drew, and the main process then lets the window
catch the mouse; everywhere else clicks fall through to whatever is underneath. Telling whether the
pointer is over a picture means reading a pixel back from the canvas, which is slow, so that is only
done when the pointer is within reach of him.

## Develop and test

```bash
npm install          # Electron and electron-builder (development only)
npm start            # runs the app from the source folder
npm test             # unit tests: physics, pictures, heroes, settings, sign-in entries, reminders
npm run test:e2e     # starts the real app, drives it, and runs the offline renders (needs a screen)
```

On Linux with no screen, run the end-to-end test as `xvfb-run -a npm run test:e2e`.
(Linux runs the app for development and CI; the installers are for Windows and macOS.)

On GitHub, every push runs both test suites on Windows, macOS and Linux, then builds the Windows
installer and both macOS disk images and keeps them as build artifacts. Pushing a tag such as
`v1.0.0` also attaches them to a release.

Test helpers, from source only (nothing appears on screen):

```bash
npx electron . --export-figure figure.png
npx electron . --snapshot frame.png 0.5 1.2
npx electron . --snapshot frame.png 2 1.5 "src/heroes/Iconic Spidey - Both"
npx electron . --snapshot frame.png 20 0.8 - - swing
```

Each snapshot also writes `frame.png.log`: motion, rope angle, how far his body leans off the
rope, and rope stretch over time.

## Artwork

The repository contains no third-party artwork: the drawn Spider-Man is code, and the tray and app
icons are a plain spider web. The iconic heroes' pictures in `src/heroes/` are stills from the
Spider-Man films. That folder is git-ignored so they are never pushed, but installers built from a
copy that has them include them. Keep those builds for your own use.

## Disclaimer

Spider-Man is a Marvel character. This is an unofficial fan project for personal fun. It is not
affiliated with or endorsed by Marvel or Disney. The code is MIT licensed. That licence does not
cover the character.
