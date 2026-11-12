#!/usr/bin/env node
'use strict';
/*
 * Sends one command to the running Spidey Hang, for scripts, git hooks and quick tests:
 *
 *   npm run spidey -- remind "Build passed"
 *   npm run spidey -- remind in 10 Tea is ready
 *   npm run spidey -- web pointer
 *   npm run spidey -- focus start 25
 *   node scripts/spidey.js antic bungee
 *
 * The commands are listed in src/main.js (handleCommand). Exits 1 if Spidey is not running.
 */
const ipc = require('../src/lib/ipc');

const words = process.argv.slice(2);
if (words.length === 0 || ['-h', '--help', 'help'].includes(words[0])) {
  process.stdout.write(`Usage: npm run spidey -- <command>

  remind <text>                    say something now
  remind in <minutes> <text>       say it later (kept until Spidey restarts)
  remind at <time> <text>          say it at a time of day, e.g. "remind at 15:30 Call back"
  web left|center|right|random|pointer|<0..1>
  focus start [minutes] | stop | skip | status
  hide [minutes] | show
  antic [wiggle|bungee|swing|say|web]
  sleep | wake | greet
  push [strength] | reset | travel | dismiss | down | up | reminders | exit
`);
  process.exit(words.length === 0 ? 1 : 0);
}

const line = words.join(' ').replace(/[\r\n]+/g, ' ').slice(0, ipc.MAX_LINE);
ipc.send(line).then((ok) => {
  if (!ok) {
    process.stderr.write('Spidey Hang is not running.\n');
    process.exit(1);
  }
});
