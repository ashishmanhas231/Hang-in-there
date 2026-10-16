# Spidey Hang

Spider-Man hangs upside down from a web at the top of your screen. Drag him and he swings.
A small desktop app for **Windows, macOS and Linux (Ubuntu)**, written in JavaScript (Electron).

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
npm run dist:linux  # on Linux:   dist/spidey-hang_<version>_amd64.deb (Ubuntu, Debian and the like)
```

Each system's installer has to be built on that system (the GitHub workflow does all three).

When the build finishes, Spidey appears straight away: the command closes any Spidey that is
already running and starts the copy it just built (`dist/win-unpacked`, `dist/mac-arm64` /
`dist/mac` on a Mac, or `dist/linux-unpacked`). Set `SPIDEY_NO_LAUNCH=1` to only build. It never starts on CI.
The Windows installer also starts him as soon as it finishes installing.

The Windows installer is a one-click, per-user install (no admin rights). The macOS build is not
notarized, so the first time you open it, right-click the app and choose **Open**
(or allow it under System Settings > Privacy & Security).

### Ubuntu and other Linux

Install the `.deb` by double-clicking it (it opens in App Center), or from a terminal:

```bash
sudo apt install ./spidey-hang_1.0.0_amd64.deb
```

Then start **Spidey Hang** from the app grid. It is built for Ubuntu 22.04 and newer (64-bit Intel/AMD);
other Debian-based systems (Linux Mint, Pop!_OS, Debian) use the same file. Remove it with `sudo apt remove spidey-hang`.

- **Wayland** (Ubuntu's default): Wayland does not let an app stay above other windows or choose where
  its window goes, so Spidey runs under X11 through XWayland, which every Wayland desktop has. Started
  any other way than the app grid, he starts once more with `--ozone-platform=x11` by himself.
- **The tray icon** is in the top bar on Ubuntu. On other GNOME desktops (Fedora, plain Debian) the top
  bar only shows it with the *AppIndicator and KStatusNotifierItem Support* extension. Right-clicking
  Spidey opens the same menu either way.
- **Transparency** needs a compositing desktop. GNOME, KDE, Cinnamon, Xfce and MATE all are; a bare
  window manager with no compositor shows a black box around him.

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
  automatically, take him down and quit. The same menu is on the tray icon (Windows: by the clock; macOS: the menu bar; Ubuntu: the top bar).
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

### Swinging across the screen

**Double-click him** (or choose **Swing across the screen** in his menu) and he swings to the other
side of the screen web to web, like Spider-Man between buildings. He leans back, swings forward, lets
go on the way up and flies through the air; on the way down the next web shoots from his hand and
catches him, and he swings straight on without losing speed. The trip is split into equal
hops. The last web is tied at the same spot as **Position > Left** or **Right**, and he swings to a
stop there. The new spot is remembered, so he starts there next time. Double-click again to swing back.

- **Grab him** mid-swing to stop: he hangs from the web he has, and that spot is remembered instead.
- With **Swing on his own** on, he stops far enough in from the edge to keep swinging.
- With **Reduce motion** turned on in your system's accessibility settings, he glides across calmly
  instead.

Reminders (**Reminders** in the menu): "Time to drink some water" on every half hour, and "It's your
lunch time" at 3:00 PM. They appear in a speech bubble just above his face, in every pose. A hero with
a web hand marked (all the bundled ones) shoots a quick web from that hand as the bubble pops up.

### Taking him down

**Take him down** in his menu: he climbs up his web out of sight and his window closes, which frees
most of the app's memory. The app keeps running in the tray (menu bar) with only the reminder clock,
so it uses no CPU. When a reminder is due he drops in on his web, delivers it, and climbs back out:

- **Bubble** (the default): his usual speech bubble above his face.
- **Big web**: he shoots three webs from his hand into the middle of the screen, a small one, a
  bigger one over it, then a big one, and the reminder is written in the big one. Click it to close
  it, or it goes after 12 seconds. If he hangs in the middle of the screen, the webs land beside him.

Each of your own reminders picks one of the two (**Show as** in the Reminders window); water and lunch
are bubbles. While he is up, every reminder is a bubble. **Bring him back** (or, on Windows, a click on
the tray icon) drops him in for good. He stays taken down over a restart. **Quit Spidey Hang** closes
the app completely.

### Your own reminders

**Reminders > Add or edit reminders…** opens a small window where you write your own:

- **A message**, up to 120 characters: "Stand up and stretch", "Standup in 5 minutes", anything.
- **When:** at a time each day (10:30 AM), or every so many minutes (5 to 1440). "Every" counts
  from midnight, so every 30 minutes means on the hour and the half hour, and every 45 minutes means
  12:00, 12:45, 1:30 and so on.
- **On which days:** any mix of weekdays, with shortcuts for every day, weekdays and weekends.
- **Show as:** Bubble or Big web, for when he is taken down (see above).

Each one can be switched off without deleting it, edited, deleted (with **Undo**), or shown straight
away with **Show**. They are also listed in the **Reminders** menu, where a click switches one on or
off. When several reminders are due at once, he says them one after another. A reminder that comes
due while the computer is asleep is skipped, not shown late. They are kept in `settings.json`
(`CustomReminders`).

### Starting automatically

**Start automatically** in his menu is on by default. He then starts when you sign in:

- **Windows:** a "Spidey Hang" entry in `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
  (Task Manager > Startup apps). Uninstalling the app removes it.
- **macOS:** a login item, `~/Library/LaunchAgents/com.spideyhang.overlay.plist`
  (System Settings > General > Login Items).
- **Linux:** `~/.config/autostart/spidey-hang.desktop` (Ubuntu: the Startup Applications app).

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
| **Iron Spider - Web Swing** | The Iron Spider suit, hanging from his raised fist |
| **Animated Spidey - Web Swing** | Animated style, hanging from one fist, the other hand out in a thwip |
| **Comic Spidey - Web Swing** | Classic comic style, both fists on his web |
| **Drawn Spider-Man** | The built-in drawing |

The heroes are folders in `src/heroes/` that ship inside the app on every system. Each holds
`hang.webp` (at rest) and optionally `swing.webp` (while he moves; also used while you drag him or
swing him up high); PNG, GIF, BMP and JPG work too. A pose change is a quick snap: the old picture
tucks in toward where he is tied on and the new one springs out, and each pose must hold for 0.2 s
before it shows, so he does not flicker between them as he slows down. A picture also trails its
swing a little (at most 6 degrees) and stretches for a moment when the web snaps taut; all of it
settles, so drawing still stops when he is still. With **Reduce motion** on, poses change at once and
none of that happens.

`hero.json` in the folder can set, per pose, in the picture's own pixel coordinates:

- `"grip"`: where his hand holds the web, for a pose held by a fist mid-picture. The web ties on
  there and runs across the front of him, and the picture keeps its pose instead of tipping to balance.
  Without it the web ties on at the middle of the top edge and the picture tips until its weight
  hangs straight below.
- `"tilt"`: degrees to turn the picture (clockwise is positive).
- `"face"` with `"faceSize"` (its radius): reminder bubbles appear just above this spot.
- `"hand"`: where new webs shoot from: the next web as he swings across the screen, the quick web as
  a reminder bubble pops up, and the webs of a Big web reminder. Without it, from where he is tied on.
- `"file"`: a picture in another hero's folder to use for this pose, so a hero can mix poses
  without copies ("Both" uses the other two Iconic heroes' pictures). It must stay inside `src/heroes`.

```json
{ "line": "web",
  "poses": { "hang": { "tilt": -7, "faceSize": 75, "points": { "grip": [330, 518], "face": [290, 185], "hand": [222, 35] } } } }
```

The folders are read once at start, and each picture is read from disk once. Only a screen-sized
copy of each picture is kept in memory; the full-size decode is freed straight away, and a hero's
pictures are freed when you change hero.

The bundled pictures were cleaned with `scripts/clean-heroes.js` (run by hand, not shipped): it cuts
a picture out of a flat background, erases a web painted in the picture (the app draws its own),
removes the light rim around the cut-out, smooths its jagged edges, sharpens a little and saves WebP.
The six heroes' pictures take about 316 KB.

## Where things are kept

Everything lives in `~/.spidey-hang` (`%USERPROFILE%\.spidey-hang` on Windows): settings
(`settings.json`) and the log (`log.txt`). Problems are written to
the log along with each start and layout. Check it first if he misbehaves.

Not `%APPDATA%` on Windows: apps installed from the Microsoft Store have their AppData writes silently
redirected to a private copy, and so does anything they start. The profile folder is not redirected.

## Scripting

A running Spidey takes one-line text commands: `push [strength]`, `reset`, `swing on|off|toggle`,
`breeze on|off|toggle`, `hero <name>|next`, `rotate <minutes>`, `remind water|lunch|<text>`,
`remind-web <text>` (a Big web reminder; a bubble while he is up), `dismiss` (closes the reminder
showing), `down` and `up` (take him down, bring him back), `reminders` (opens the Reminders window),
`travel` (swings across to the other side of the screen), `snapshot <file.png>`,
`capture <file.png>`, `stats`, `metrics [seconds]` and `exit` (quits). They travel over the named pipe `\\.\pipe\SpideyHang` on
Windows and the Unix socket `~/.spidey-hang/spidey.sock` on macOS and Linux, which only your own account can open.
`snapshot` saves only what Spidey himself draws, never the screen behind it; `capture` saves his whole
window as it looks, bubble and Big web text included (still nothing behind it). `metrics` writes to the
log how much CPU and memory each of the app's processes used over that many seconds (10 by default),
with how many frames the page drew.

The app's command line takes `--push [n]`, `--reset`, `--exit` and `--reminders` as well.

## How it works

```
src/
  main.js            Electron main process: windows, tray, menu, settings, sign-in entry
  lib/               plain Node: settings, heroes, reminders, log, command channel, sign-in entries
  heroes/            the heroes' pictures and hero.json files
  renderer/          the overlay page (no Node access; talks to main.js through preload.js)
                     and the Reminders window (reminders.html, through reminders-preload.js)
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
catch the mouse; everywhere else clicks fall through to whatever is underneath. The web and the knot
are tested by their shape. Telling whether the pointer is over a picture means drawing him into a
one-pixel canvas and reading it back, so that is only done when the pointer is inside the picture's
box, turned as it is drawn.

Every line drawn (the web, its shadow and shading bands, a web on its way) reuses the same lists of
points each frame, so drawing allocates nothing while he moves.

While he is taken down there is no overlay window at all, only the tray and one timer in the main
process. For a reminder the window is opened again: he drops in (the rope starts reeled in and plays
out), delivers it, climbs out, and the window is closed. For a Big web reminder that window also
reaches the middle of the screen; the three webs are each drawn once into a bitmap, and a frame only
scales them as they land (`src/renderer/shared/webshot.js`).

Linux does not tell a window that lets clicks through where the pointer is (and on Wayland an X11 app
cannot see the pointer over other apps at all), so there the window is shaped instead: each frame the
scene is drawn small, and the window keeps only the squares with something drawn in them, grown a
little (more while he moves fast, so he never outruns the shape). The desktop then sends clicks on
him to Spidey and everything else straight through (`src/renderer/shared/shape.js`).

## Develop and test

```bash
npm install          # Electron and electron-builder (development only)
npm start            # runs the app from the source folder
npm test             # unit tests: physics, pictures, heroes, settings, sign-in entries, reminders
npm run test:e2e     # starts the real app, drives it, and runs the offline renders (needs a screen)
npm run perf         # CPU and memory of the real app, case by case (needs a screen)
```

`npm run perf` starts a throwaway copy (its own settings, so it runs beside an installed one) at Large
size with a Long rope and measures him still, in the breeze, swinging on his own, after a push,
swinging across, and taken down. `-- --long` adds 90 seconds of breeze to show whether memory keeps
growing. `SPIDEY_APP=<another checkout> npm run perf` measures that copy instead, so code before and
after a change can be compared back to back (make one with `git worktree add`). Leave him alone while
it runs.

On Linux with no screen, run the end-to-end test as `xvfb-run -a npm run test:e2e`.

On GitHub, every push runs both test suites on Windows, macOS and Linux, then builds the Windows
installer, both macOS disk images and the Linux `.deb` and keeps them as build artifacts. Pushing a tag such as
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

The drawn Spider-Man is code, and the tray and app icons are a plain spider web. The heroes' pictures
in `src/heroes/` are stills and artwork of the Marvel character (from the films, comics and fan
renders). They are not covered by the MIT licence, and installers built with them are for your own
use.

## Disclaimer

Spider-Man is a Marvel character. This is an unofficial fan project for personal fun. It is not
affiliated with or endorsed by Marvel or Disney. The code is MIT licensed. That licence does not
cover the character.
