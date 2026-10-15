'use strict';
/*
 * Linux only: Spidey runs under X11, even on a Wayland desktop (Ubuntu's default since 22.04).
 *
 * Wayland does not let an app keep its window above the others or choose where the window goes, so
 * Spidey would land anywhere and slip behind other windows. X11 allows both, and Wayland desktops
 * run X11 apps through XWayland. Electron picks the display server before any of our code runs, so
 * the only way to choose it is the command line: a start without it starts again with it.
 */
const X11_SWITCH = '--ozone-platform=x11';

/** True when this start is on a Wayland desktop and has to start again under X11. */
function needsX11Restart(platform = process.platform, env = process.env, argv = process.argv) {
  if (platform !== 'linux' || argv.includes(X11_SWITCH)) {
    return false;
  }
  // Without DISPLAY there is no XWayland to run on, so staying on Wayland is better than not starting.
  return !!env.DISPLAY && (env.XDG_SESSION_TYPE === 'wayland' || !!env.WAYLAND_DISPLAY);
}

module.exports = { needsX11Restart, X11_SWITCH };
