'use strict';
/*
 * The heroes that ship inside the app: one folder each under src/heroes (inside app.asar when
 * packaged, which Electron's fs reads like any other folder). The same on every system.
 *
 * Pictures are found by file name (any case, .png .webp .gif .bmp .jpg .jpeg):
 *   hang     at rest or moving slowly
 *   swing    while he is moving (fly and grab fall back to it)
 *
 * hero.json (optional; comments and trailing commas allowed):
 * {
 *   "line": "web" | "none",
 *   "poses": { "hang": { "tilt": -7, "faceSize": 75, "points": { "grip": [330, 518], "face": [290, 185], "hand": [222, 35] } } }
 * }
 *   grip      where his hand holds the web (the web ties on there and runs across the front of him)
 *   tilt      degrees to turn the picture, clockwise positive
 *   face      where reminder bubbles point, with faceSize its radius
 *   hand      where every new web shoots from (to the next web, to a reminder); without it, the tie-on point
 *   faces     "left" or "right": the way he is heading in the picture. Swinging across the screen he is
 *             mirrored to face the way he goes. Without it, the side his web hand is on decides.
 *   file      a picture in another hero's folder to use for this pose ("../Other hero/hang.webp"), so a
 *             hero can mix poses without copies. It has to stay inside the folder holding the heroes.
 * Points are pixels of the picture, from its top left corner.
 *
 * Your own heroes live in ~/.spidey-hang/heroes/<name>/ and are laid out the same way. One of yours
 * with the same name as a hero that ships with the app is used instead of it. They are marked
 * user: true.
 *
 * The folders are read once and kept; refresh() reads them again (Hero > Reload heroes).
 */
const fs = require('fs');
const path = require('path');
const log = require('./log');
const paths = require('./paths');

const POSE_NAMES = ['hang', 'swing', 'fly', 'grab'];
const PICTURE_TYPES = ['.png', '.webp', '.gif', '.bmp', '.jpg', '.jpeg'];
const LINE_STYLES = ['web', 'none'];

const BUNDLED_DIR = path.join(__dirname, '..', 'heroes');

const byName = (a, b) => a.toLowerCase().localeCompare(b.toLowerCase());

let cache = null;

/** ~/.spidey-hang/heroes: the user's own heroes. */
function userDir() {
  return path.join(paths.dataDir(), 'heroes');
}

/**
 * Every hero: those that ship with the app and the user's own, sorted by name. Read on first use,
 * then kept until refresh().
 */
function scan() {
  if (!cache) {
    const mine = scanFolder(userDir()).map((h) => ({ ...h, user: true }));
    const taken = new Set(mine.map((h) => h.name.toLowerCase()));
    cache = [...scanFolder(BUNDLED_DIR).filter((h) => !taken.has(h.name.toLowerCase())), ...mine]
      .sort((a, b) => byName(a.name, b.name));
  }
  return cache;
}

/** Forgets what was read, so the next scan() sees changes to the folders. */
function refresh() {
  cache = null;
  return scan();
}

const README = `Your own Spidey Hang heroes
===========================

Each folder here is one hero, named after the folder. Put pictures in it named:

  hang.png    hanging at rest (needed)
  swing.png   while he moves (optional; hang is used without it)

.png .webp .gif .bmp .jpg and .jpeg all work. A transparent background looks best.
The web ties on at the middle of the top edge of the picture, so draw him upside down.

An optional hero.json says where his hand holds the web and where his face is (pixels from the
top left corner of the picture):

  { "poses": { "hang": { "points": { "grip": [120, 10], "face": [120, 300], "hand": [120, 10] }, "faceSize": 60 } } }

A folder with the same name as a hero that comes with the app is used instead of it.
After changing anything here, pick Hero > Reload heroes in his menu.
`;

/** Makes ~/.spidey-hang/heroes with a README.txt in it. Returns the folder. */
function ensureUserDir() {
  const dir = userDir();
  fs.mkdirSync(dir, { recursive: true });
  const readme = path.join(dir, 'README.txt');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, README);
  }
  return dir;
}

/** A folder name from a picture's file name: no characters that are not allowed in file names. */
function heroNameFor(file) {
  const base = path.basename(file, path.extname(file)).replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
  return (base || 'My hero').slice(0, 60);
}

/**
 * Copies a picture into a new hero folder of the user's, as its hang pose, and returns the hero.
 * The name is the picture's file name; " 2", " 3" ... are added if it is taken.
 */
function addFromPicture(file, name) {
  const ext = path.extname(file).toLowerCase();
  if (!PICTURE_TYPES.includes(ext)) {
    throw new Error(`Not a picture this app can show (${PICTURE_TYPES.join(' ')})`);
  }
  if (!fs.statSync(file).isFile()) {
    throw new Error('Not a file');
  }
  const root = ensureUserDir();
  const base = name ? heroNameFor(name) : heroNameFor(file);
  let folderName = base;
  for (let n = 2; fs.existsSync(path.join(root, folderName)); n++) {
    folderName = `${base} ${n}`;
  }
  const dir = path.join(root, folderName);
  fs.mkdirSync(dir);
  fs.copyFileSync(file, path.join(dir, 'hang' + ext));
  refresh();
  return find(folderName);
}

function scanFolder(folder) {
  if (!fs.existsSync(folder)) {
    return [];
  }
  const heroes = [];
  for (const name of fs.readdirSync(folder).sort(byName)) {
    const dir = path.join(folder, name);
    try {
      if (fs.statSync(dir).isDirectory()) {
        heroes.push(readFolder(dir));
      }
    } catch (err) {
      log.write(`Skipped hero folder ${dir}: ${err.message}`);
    }
  }
  return heroes;
}

function find(name) {
  const wanted = String(name).toLowerCase();
  return scan().find((h) => h.name.toLowerCase() === wanted) || null;
}

/** Reads one hero folder. */
function readFolder(dir) {
  const hero = {
    name: path.basename(dir),
    folderPath: dir,
    line: 'web',
    /** hang/swing/fly/grab -> { file } */
    poses: {},
    poseSettings: {},
  };
  readSettings(path.join(dir, 'hero.json'), hero);
  for (const fileName of fs.readdirSync(dir).sort(byName)) {
    const ext = path.extname(fileName).toLowerCase();
    const pose = path.basename(fileName, path.extname(fileName)).toLowerCase();
    if (PICTURE_TYPES.includes(ext) && POSE_NAMES.includes(pose)) {
      hero.poses[pose] = { file: path.join(dir, fileName) };
    }
  }
  for (const [pose, { file }] of Object.entries(hero.poseSettings)) {
    if (file && POSE_NAMES.includes(pose)) {
      const borrowed = borrowedPicture(dir, file);
      if (borrowed) {
        hero.poses[pose] = { file: borrowed };
      } else {
        log.write(`${hero.name}: ignored "file": "${file}" for ${pose} (not a picture inside ${path.dirname(dir)})`);
      }
    }
  }
  hero.usable = Object.keys(hero.poses).length > 0;
  return hero;
}

/** The full path of a hero.json "file", or null unless it is a picture inside the folder holding the heroes. */
function borrowedPicture(dir, file) {
  const root = path.resolve(path.dirname(dir));
  const full = path.resolve(dir, file);
  const inside = full.startsWith(root + path.sep);
  return inside && PICTURE_TYPES.includes(path.extname(full).toLowerCase()) && fs.existsSync(full) ? full : null;
}

/** JSON with // and /* comments and trailing commas. */
function parseLooseJson(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += text[++i] || '';
      } else if (c === '"') {
        inString = false;
      }
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** Reads hero.json into the hero. A missing or broken file leaves the defaults. */
function readSettings(jsonFile, hero) {
  if (!fs.existsSync(jsonFile)) {
    return;
  }
  try {
    const root = parseLooseJson(fs.readFileSync(jsonFile, 'utf8').replace(/^﻿/, ''));
    if (typeof root.line === 'string' && LINE_STYLES.includes(root.line.toLowerCase())) {
      hero.line = root.line.toLowerCase();
    }
    if (root.poses && typeof root.poses === 'object') {
      for (const [name, value] of Object.entries(root.poses)) {
        hero.poseSettings[name.toLowerCase()] = readPose(value || {});
      }
    }
  } catch (err) {
    log.write(`Could not read ${jsonFile}: ${err.message}`);
  }
}

/** One pose's settings: { grip, face, hand, tilt, faceSize, faces, file }, each null when not given. */
function readPose(json) {
  const point = (value) => (Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number')
    ? { x: value[0], y: value[1] } : null);
  const points = json.points && typeof json.points === 'object' ? json.points : {};
  return {
    grip: point(points.grip),
    face: point(points.face),
    hand: point(points.hand),
    tilt: typeof json.tilt === 'number' ? json.tilt : null,
    faceSize: typeof json.faceSize === 'number' && json.faceSize > 0 ? json.faceSize : null,
    faces: json.faces === 'left' ? -1 : json.faces === 'right' ? 1 : null,
    file: typeof json.file === 'string' && json.file.trim() ? json.file.trim() : null,
  };
}

module.exports = { scan, refresh, find, readFolder, userDir, ensureUserDir, addFromPicture, heroNameFor, parseLooseJson, POSE_NAMES, PICTURE_TYPES, BUNDLED_DIR };
