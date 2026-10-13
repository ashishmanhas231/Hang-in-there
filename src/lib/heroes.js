'use strict';
/*
 * The heroes that ship inside the app: one folder each under src/heroes (inside app.asar when
 * packaged, which Electron's fs reads like any other folder). The same on Windows and macOS.
 *
 * Pictures are found by file name (any case, .png .webp .gif .bmp .jpg .jpeg):
 *   hang     at rest or moving slowly
 *   swing    while he is moving (fly and grab fall back to it)
 *
 * hero.json (optional; comments and trailing commas allowed):
 * {
 *   "line": "web" | "none",
 *   "poses": { "hang": { "tilt": -7, "faceSize": 75, "points": { "grip": [330, 518], "face": [290, 185] } } }
 * }
 *   grip      where his hand holds the web (the web ties on there and runs across the front of him)
 *   tilt      degrees to turn the picture, clockwise positive
 *   face      where reminder bubbles point, with faceSize its radius
 *
 * The folders never change while the app runs, so they are read once and kept.
 */
const fs = require('fs');
const path = require('path');
const log = require('./log');

const POSE_NAMES = ['hang', 'swing', 'fly', 'grab'];
const PICTURE_TYPES = ['.png', '.webp', '.gif', '.bmp', '.jpg', '.jpeg'];
const LINE_STYLES = ['web', 'none'];

const BUNDLED_DIR = path.join(__dirname, '..', 'heroes');

const byName = (a, b) => a.toLowerCase().localeCompare(b.toLowerCase());

let cache = null;

/** Every hero that ships with the app, sorted by name. Read on first use, then kept. */
function scan() {
  if (!cache) {
    cache = scanFolder(BUNDLED_DIR);
  }
  return cache;
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
  hero.usable = Object.keys(hero.poses).length > 0;
  return hero;
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

/** One pose's settings: { grip, tilt, face, faceSize }, each null when not given. */
function readPose(json) {
  const point = (value) => (Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number')
    ? { x: value[0], y: value[1] } : null);
  const points = json.points && typeof json.points === 'object' ? json.points : {};
  return {
    grip: point(points.grip),
    face: point(points.face),
    tilt: typeof json.tilt === 'number' ? json.tilt : null,
    faceSize: typeof json.faceSize === 'number' && json.faceSize > 0 ? json.faceSize : null,
  };
}

module.exports = { scan, find, readFolder, parseLooseJson, POSE_NAMES, PICTURE_TYPES, BUNDLED_DIR };
