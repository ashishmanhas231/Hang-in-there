# Spidey Hang

Spider-Man hangs upside down from a web at the top of your screen. Drag him and he swings.

Inspired by [Hangly for Windows](https://github.com/SharanCreatedThis/Hangly-Windows), a desktop
widget with a charm on a simulated rope. This project shares the idea only. No code or artwork
was copied.

There are two ways to see him:

- **On the desktop** (Windows). He hangs over every window, VS Code included. This is the Hangly-style one.
- **In the VS Code sidebar.** He stays inside a panel.

## Desktop Spidey

Start him with any of these:

- Click **🕷 Spidey** in the VS Code status bar (bottom right). Click it again to take him down.
- Run `Spidey: Hang on Desktop` from the Command Palette.
- Double-click `bin/SpideyHang.exe`.

Once he is up:

- **Drag him** by the body or the rope. Let go to fling him.
- **Click him** for a nudge, or **brush the cursor across him** to push him.
- **Drag the little web knot** at the top of the screen to move where he hangs.
- **Right-click him**, or right-click the Spidey mask icon by the clock, for the menu:
  position, size, rope length, look, breeze, and exit.
- **Left-click the tray icon** to give him a swing.

Clicks pass straight through everywhere except Spider-Man, the rope and the knot.
Grabbing him does not take keyboard focus away from VS Code.

He keeps hanging after VS Code closes. Take him down from the tray menu, the status bar button,
or `Spidey: Take Down from Desktop`.

### Starting automatically

**Start automatically** in his menu is on by default. He then starts:

- **when you sign in to Windows**: a "Spidey Hang" entry in the current user's Run key
  (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`) runs `app\SpideyHang.exe --at-login`, which
  waits 4 seconds for the taskbar before starting;
- **when VS Code starts**, if he is not already running.

Untick it and both stop. You can also see and switch the entry in Task Manager > Startup apps.

The Run entry is written by Spidey himself when you start him, and by the VS Code extension each time
VS Code starts (`SpideyHang.exe --sync-startup`). It must never come from a process started by an app
installed from the Microsoft Store, such as the Claude desktop app: Windows silently redirects that
process's registry writes to a private copy it never reads at sign-in.

When he stops moving, the app stops drawing. It uses no CPU until you touch him again.
While he swings it uses about a quarter of one CPU core. Turning the breeze on keeps him
moving, so it uses that all the time.

**Swing on his own** (in the menu, or `Spidey: Swing on His Own (on/off)` in VS Code) keeps a
steady swing of about 30 degrees going, like pumping a playground swing. Like the breeze, it
uses CPU the whole time it is on.

A picture always hangs with its weight straight below the point where the web ties on, the way
anything held from one point does. So a picture of him holding the web with one hand hangs
naturally from that hand.

### Heroes

Pick a hero from **Hero** in the right-click menu, or run `Spidey: Choose Hero...` in VS Code.
**Hero > Change hero every** rotates through them on a timer.

The `.vsix` ships no hero pictures, only the drawn Spider-Man. This repository keeps copies of some
Marvel pictures in `heroes/` (see [Artwork](#artwork)). Copy the folders you want into
`%USERPROFILE%\.spidey-hang\heroes\`, or add your own.

Each hero is a folder in `%USERPROFILE%\.spidey-hang\heroes\`. The folder name is the menu name.
Use PNGs with a see-through background. Pictures are picked by file name:

| File | Shown when |
|---|---|
| `hang.png` | At rest or moving slowly. Start with this one |
| `swing.png` | He is moving |
| `fly.png` | He is swung up high (over about 45 degrees) |
| `grab.png` | You are dragging him |
| `emblem.png` | Only while the folder has no poses yet |

- Missing poses fall back: `grab` and `fly` use `swing`, and `swing` uses `hang`.
- Poses cross-fade. Each needs to hold for 0.2 s before it shows, and there are separate thresholds
  for starting and stopping one, so he does not flicker between poses as he slows down.
- The line ties on at the middle of the picture's top edge. Add `-flip` (`hang-flip.png`) for an
  upright picture that should hang by its feet.
- Pictures dropped into a folder while he is running show up within a second.
- `hero.json` in the folder sets what the hero hangs from: `web`, `cable`, `chain`, `lasso`,
  `grapple`, or `none` (nothing drawn, so he floats and sways). An emblem whose hero has `none`
  hangs on a chain, because a charm with an empty hanging loop looks wrong floating.
- `heroes\README.txt` repeats all this next to the pictures.

**Use my own picture...** in the Hero menu still hangs a single picture, as **My picture**.
**Drawn Spider-Man** is the built-in drawing.

### Acting heroes

A hero whose `hero.json` names a move set, and who has every pose it needs, stops hanging and
acts on the whole screen instead. Until then he hangs as before, and the log says which poses
are still missing.

| `"moves"` | Needs | What he does | Click | Double-click |
|---|---|---|---|---|
| `ironman` | hover, fly, land (blast) | Hovers on boot thrusters, flies between spots, sometimes a superhero landing on the taskbar | Fly now | Repulsor blast at the pointer |
| `hulk` | idle, jump, smash (roar) | Stands on the taskbar breathing; leaps across and lands with dust, cracks and a shake | Leap now | Same |
| `captain` | stand, throw (catch) + emblem | Stands on the taskbar | Shield throw: off the screen edge and back | Same |
| `thor` | stand, summon, land | Stands on the taskbar; now and then calls lightning onto Mjolnir, flies off hammer first and lands with a strike | Lightning, then fly | A bolt from the hammer to the pointer |
| `flash` | stand, run (stop) | Waits at one side | Runs the whole screen in half a second with after-images | Same |
| `floater` | any one picture | Floats with magic glowing at his hands | Blast at the pointer | Same |

Drag any acting hero and let go: ground heroes fall (a long fall lands hard), flyers catch themselves.

Optional per-pose settings in `hero.json` mark spots in the picture, in its own pixel coordinates:
`"thrusters"` (Iron Man's boots), `"palm"`, `"hand"` (where a shield leaves and returns), `"hands"`
(magic glow) and `"hammer"`, plus `"facesLeft"`, `"scale"` and `"thrustAngle"`. Most image editors
show the pixel position under the mouse, which is all you need to find them.

How it runs (`desktop/Actors/`): the hero, each thrown object and each effect get their own small
transparent window. During a long move (flight, leap, run, fall) the hero's window covers the whole
path and stays still while he moves inside it, because moving a window costs a frame of lag that shows
as a jump at speed. Effect windows are made up front and parked off-screen when unused. Creating or
showing a window mid-frame crashed the app once (see `SceneHost.OnFrame`).

Test a hero offline, without anything appearing on screen. This saves a film strip of frames:

```bash
bin/SpideyHang.exe --scene "<hero folder>" strip.png 4 8 zoom click@0.5 dbl@3 drop@5
```

Everything lives in `%USERPROFILE%\.spidey-hang`: settings, the log, your pictures, and the one
copy of the app that VS Code launches (`app\SpideyHang.exe`). That path never changes with updates,
so it is the one to use for Win+R or a shortcut. VS Code refreshes it whenever a newer version of
the extension starts.

Why not `%APPDATA%`: apps installed from the Microsoft Store have their AppData writes silently
redirected to a private copy, and so does anything they start. A Spidey started from such an app
then saw different settings from one you started yourself.

If he swings on his own and you drop the web too close to a screen edge, it slides back in just far
enough for a full swing. Otherwise he would have to stop swinging to stay on screen.

Needs the .NET 10 Desktop Runtime. It comes with the .NET 10 SDK.

## Sidebar Spidey

Click the web icon in the Activity Bar. The view is called "Hanging Around".
`Spidey: Open in Editor Tab` opens a bigger one.

## Commands

| Command | What it does |
|---|---|
| `Spidey: Hang on Desktop` | Starts desktop Spidey. If he is already up, he waves |
| `Spidey: Take Down from Desktop` | Closes desktop Spidey |
| `Spidey: Toggle Desktop Spidey` | What the status bar button runs |
| `Spidey: Use My Own Picture on Desktop...` | Hangs a picture you choose instead of the drawing |
| `Spidey: Use Drawn Spider-Man on Desktop` | Back to the drawing |
| `Spidey: Swing on His Own (on/off)` | Keeps him swinging, or lets him settle |
| `Spidey: Choose Hero...` | Pick a hero from a list. Heroes without pictures offer to open their folder |
| `Spidey: Next Hero` | The next hero that has pictures |
| `Spidey: Open Heroes Folder` | Opens `%USERPROFILE%\.spidey-hang\heroes` to add pictures |
| `Spidey: Give Him a Swing` | Swings every Spidey: desktop, sidebar and tabs |
| `Spidey: Reset` | Hangs every Spidey straight again |
| `Spidey: Open in Editor Tab` | Opens a sidebar-style Spidey in an editor tab |

## Settings

| Setting | Default | What it does |
|---|---|---|
| `spideyHang.desktop.startWithVSCode` | `false` | Start desktop Spidey when VS Code starts |
| `spideyHang.desktop.statusBarButton` | `true` | Show the 🕷 Spidey status bar button |
| `spideyHang.swingOnSave` | `false` | A small swing every time you save a file |
| `spideyHang.idleBreeze` | `true` | Sidebar only. A light breeze so he sways |

## How it works

The rope is a chain of points joined by fixed-length links (Verlet integration, 240 steps a second).
The last rope point is his ankle. A second point is his head, joined to the ankle by a fixed-length
link. That makes him swing like a double pendulum. He is drawn from plain shapes. There are no
image files.

The web line is drawn in layers, the same technique Hangly uses for its cords: a soft shadow,
several thin strokes side by side for rounded shading, then a dashed pattern on top so it reads
as twisted silk. A splat of strands sticks it to the top of the screen.

The desktop app (`desktop/`) is a small WPF program. Its window is transparent, always on top,
and only as big as his swing needs. Windows lets clicks fall through any fully transparent pixel.
His body and arms are drawn once into pictures, then just turned each frame. Drawing every web
line live cost about three times the CPU.

VS Code talks to it over the named pipe `\\.\pipe\SpideyHang`, which only your Windows account
can open. Commands: `push [strength]`, `reset`, `image <path>`, `image off`,
`swing on|off|toggle`, `snapshot <file.png>` and `exit`. `snapshot` saves only what the overlay
itself draws, never the screen behind it.

Problems are written to `%USERPROFILE%\.spidey-hang\log.txt`, along with each start and layout.
Check it first if he misbehaves.

The physics has two pieces of "grip" between the rope and his body. One damps his body turning
faster or slower than the end of the rope. The other pulls his body back into line with the rope.
Without them the rope whips like a heavy chain and his body swings about twice as far as the rope.

The exe takes the same commands on the command line: `--push [n]`, `--reset`, `--exit`.

## Build and install

Needs Windows, the .NET 10 SDK, Python 3 and VS Code.

```bash
python scripts/build-vsix.py
code --install-extension dist/spidey-hang-0.9.0.vsix --force
```

The script runs `dotnet publish` for the desktop app first, then packs the `.vsix`. Reload VS Code
afterwards.

On GitHub, every push builds the `.vsix` with GitHub Actions and keeps it as a build artifact.
Pushing a tag such as `v0.9.0` also attaches it to a release.

Test helpers (nothing appears on screen):

```bash
bin/SpideyHang.exe --export-figure figure.png
bin/SpideyHang.exe --snapshot frame.png 0.5 1.2
bin/SpideyHang.exe --snapshot frame.png 0.5 1.2 figure.png flip
bin/SpideyHang.exe --snapshot frame.png 20 0.8 - - swing
```

Each snapshot also writes `frame.png.log`: motion, rope angle, how far his body leans off the
rope, and rope stretch over time.

## Artwork

The code is original. Spider-Man is drawn by code (`desktop/SpideyArt.cs`), and the `.vsix` carries
no pictures.

`heroes/` and `pictures/` hold pictures of Marvel characters, kept here as a personal backup. They
belong to Marvel and Disney and are not covered by the MIT licence. Some emblems may come from
Hangly, whose NOTICE.md marks all its charm artwork "all rights reserved".

**Keep this repository private.** Before it is ever made public, delete `heroes/` and `pictures/`
and purge them from the git history. See `heroes/NOTICE.md`.

Hangly's ropes are drawn by code, not from pictures. This project follows the same idea in its own code.

## Disclaimer

Spider-Man is a Marvel character. This is an unofficial fan project for personal fun. It is not
affiliated with or endorsed by Marvel or Disney. The code is MIT licensed. That licence does not
cover the character or the pictures in `heroes/` and `pictures/`.
