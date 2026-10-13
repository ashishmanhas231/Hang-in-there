'use strict';
/*
 * One-line text commands ("push 1", "reset", "exit") to a running overlay, for scripts and the tests.
 *
 *   Windows        the named pipe \\.\pipe\SpideyHang.
 *   macOS, Linux   a Unix socket, ~/.spidey-hang/spidey.sock, readable only by this user.
 *
 * Plain Node, no Electron.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const paths = require('./paths');

// Long enough for "image <full path>".
const MAX_LINE = 1024;

function endpoint() {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\SpideyHang' + (process.env.SPIDEY_HANG_HOME ? '-' + Buffer.from(process.env.SPIDEY_HANG_HOME).toString('hex').slice(-16) : '');
  }
  return path.join(paths.dataDir(), 'spidey.sock');
}

/** Sends one command. Resolves true if a running overlay took it, false if none is running. */
function send(command, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect(endpoint());
    let done = false;
    const finish = (ok) => {
      if (!done) {
        done = true;
        socket.destroy();
        resolve(ok);
      }
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => socket.end(command + '\n', () => finish(true)));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

/** Starts listening. onCommand(line) is called for each line. Resolves the server, or rejects. */
function listen(onCommand) {
  const where = endpoint();
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.length <= MAX_LINE) {
          onCommand(line);
        }
      }
      if (buffer.length > MAX_LINE * 4) {
        socket.destroy(); // a client that never sends a newline
      }
    });
    socket.on('error', () => {
      // Client went away mid-line. Ignore it.
    });
  });

  return new Promise((resolve, reject) => {
    const start = () => {
      server.once('error', reject);
      server.listen(where, () => {
        if (process.platform !== 'win32') {
          try {
            fs.chmodSync(where, 0o600);
          } catch {
            // Best effort; the folder is the user's own anyway.
          }
        }
        resolve(server);
      });
    };
    if (process.platform !== 'win32' && fs.existsSync(where)) {
      // A socket file left behind by a crash. Remove it only if nobody answers on it.
      send('ping', 300).then((alive) => {
        if (alive) {
          reject(new Error('Another overlay is already listening.'));
          return;
        }
        try {
          fs.unlinkSync(where);
        } catch {
          // Gone already.
        }
        start();
      });
    } else {
      fs.mkdirSync(paths.dataDir(), { recursive: true });
      start();
    }
  });
}

module.exports = { endpoint, send, listen, MAX_LINE };
