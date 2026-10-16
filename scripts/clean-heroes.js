'use strict';
/*
 * Cleans the hero pictures that ship in src/heroes and saves them as WebP. Run by hand, not shipped:
 *
 *   npx electron scripts/clean-heroes.js <folder with the original pictures>
 *
 * The folder holds the originals under the names in JOBS below. The Iconic pictures are the
 * hang.png files from git history (before this script replaced them); Iron Spider, Animated and Comic
 * came as PNGs from the user. For each picture, in this order:
 *
 *   key          cuts it out of a flat background (flood-fill from the border, soft alpha at the cut)
 *   erase        erases the web painted in the picture (the app draws its own from the grip):
 *                light, grey pixels in "boxes" go; inside "fills" the suit is painted back in;
 *                everything in "clear" goes, whatever its colour (thin dark strands)
 *   despeckle    drops loose specks smaller than that many pixels
 *   height       shrinks it to that height (area average, so no fringe from transparent pixels)
 *   levels       stretches its tones a little (at most 12% more contrast)
 *   edges        removes the light rim of the cut-out, shrinks the edge by about 0.7 px and smooths
 *                its stair steps, then cleans the rim again
 *   sharpen      a light unsharp mask, away from the edge so it makes no new halo
 *   crop         to what is visible, plus that many pixels
 *
 * The points in each hero.json (grip, face, hand) are in the pixels of the saved picture, after any
 * shrinking and cropping; the script prints both. Decoding and the pixel work are plain JavaScript on
 * exact (not premultiplied) RGBA; only the WebP encoding needs Chromium, which is why this runs in
 * Electron (a hidden window).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const HEROES_DIR = path.join(__dirname, '..', 'src', 'heroes');
const QUALITY = 0.9;

const JOBS = [
  { source: 'upside-down.png', out: 'Iconic Spidey - Upside Down/hang.webp' },
  { source: 'web-swing.png', out: 'Iconic Spidey - Web Swing/hang.webp' },
  {
    source: 'iron-spider.png', out: 'Iron Spider - Web Swing/hang.webp', height: 1000, crop: 4,
    erase: { boxes: [[0, 0, 695, 286], [362, 286, 395, 314], [180, 300, 318, 372]], fills: [[318, 338, 346, 366]] },
  },
  {
    source: 'animated.png', out: 'Animated Spidey - Web Swing/hang.webp', key: { bg: [247, 247, 247], tol: 22, soft: 70 },
    erase: { boxes: [[418, 0, 860, 346], [414, 358, 500, 470]] }, despeckle: 400, crop: 4,
  },
  {
    source: 'comic.png', out: 'Comic Spidey - Web Swing/hang.webp',
    erase: { boxes: [[505, 135, 545, 152]], clear: [[470, 0, 600, 136], [543, 315, 600, 440]] }, despeckle: 400, crop: 4,
  },
];

// ---- PNG (8-bit RGB or RGBA, not interlaced) -----------------------------------------------------

function readPng(file) {
  const buf = fs.readFileSync(file);
  let pos = 8;
  let width;
  let height;
  let type;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const kind = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) {
        throw new Error(`${file}: only 8-bit, non-interlaced PNGs`);
      }
      type = data[9];
    } else if (kind === 'IDAT') {
      idat.push(data);
    } else if (kind === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  const ch = type === 6 ? 4 : type === 2 ? 3 : 0;
  if (!ch) {
    throw new Error(`${file}: PNG colour type ${type} is not RGB or RGBA`);
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const out = new Uint8ClampedArray(width * height * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v = row[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = cur[x * ch];
      out[o + 1] = cur[x * ch + 1];
      out[o + 2] = cur[x * ch + 2];
      out[o + 3] = ch === 4 ? cur[x * ch + 3] : 255;
    }
    prev.set(cur);
  }
  return { width, height, data: out };
}

// ---- The pixel work (exact RGBA, not premultiplied) ---------------------------------------------

const lum = (d, o) => 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
const inBox = (x, y, boxes) => boxes.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);

/** Flood-fills from the border over pixels within tol of the background colour; soft alpha along the cut. */
function keyOut(img, bg, tol = 22, soft = 70) {
  const { width: w, height: h, data } = img;
  const dist = (i) => Math.hypot(data[i * 4] - bg[0], data[i * 4 + 1] - bg[1], data[i * 4 + 2] - bg[2]);
  const isBg = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  while (stack.length) {
    const i = stack.pop();
    if (isBg[i] || dist(i) >= tol) continue;
    isBg[i] = 1;
    const x = i % w;
    const y = (i / w) | 0;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - w);
    if (y < h - 1) stack.push(i + w);
  }
  let cut = 0;
  for (let i = 0; i < w * h; i++) {
    if (isBg[i]) {
      data[i * 4 + 3] = 0;
      cut++;
      continue;
    }
    const x = i % w;
    const y = (i / w) | 0;
    let edge = false;
    for (let dy = -1; dy <= 1 && !edge; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && isBg[ny * w + nx]) {
          edge = true;
          break;
        }
      }
    }
    if (edge) {
      data[i * 4 + 3] = Math.round(255 * Math.max(0, Math.min(1, (dist(i) - tol * 0.6) / soft)));
    }
  }
  return { cut };
}

/** Erases a painted web: light grey pixels in boxes (grown 2 px into grey or faint pixels); see the top. */
function eraseStrand(img, { boxes = [], fills = [], clear = [] }) {
  const { width: w, height: h, data } = img;
  const spread = (o) => Math.max(data[o], data[o + 1], data[o + 2]) - Math.min(data[o], data[o + 1], data[o + 2]);
  const grey = (o) => spread(o) < 46 && Math.max(data[o], data[o + 1], data[o + 2]) > 95;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (data[o + 3] && grey(o) && (inBox(x, y, boxes) || inBox(x, y, fills))) mask[y * w + x] = 1;
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    const was = new Uint8Array(mask);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!was[i] && (was[i - 1] || was[i + 1] || was[i - w] || was[i + w]) && (spread(i * 4) < 70 || data[i * 4 + 3] < 160)) {
          mask[i] = 1;
        }
      }
    }
  }
  let erased = 0;
  let filled = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (inBox(x, y, clear)) {
        const i = y * w + x;
        if (data[i * 4 + 3]) erased++;
        data[i * 4 + 3] = 0;
        mask[i] = 0;
      }
    }
  }
  const todo = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) continue;
    if (inBox(i % w, (i / w) | 0, fills)) {
      todo.push(i);
    } else {
      data[i * 4 + 3] = 0;
      erased++;
    }
  }
  // Inside a fill box: painted in from the nearest suit pixels, ring by ring.
  let left = todo;
  for (let round = 0; round < 40 && left.length; round++) {
    const next = [];
    const done = [];
    for (const i of left) {
      const x = i % w;
      const y = (i / w) | 0;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const j = (y + dy) * w + x + dx;
        if (!mask[j] && data[j * 4 + 3] > 200) {
          r += data[j * 4];
          g += data[j * 4 + 1];
          b += data[j * 4 + 2];
          a += data[j * 4 + 3];
          n++;
        }
      }
      if (n >= 2) done.push([i, r / n, g / n, b / n, a / n]);
      else next.push(i);
    }
    for (const [i, r, g, b, a] of done) {
      data.set([r, g, b, a], i * 4);
      mask[i] = 0;
      filled++;
    }
    left = next;
    if (!done.length) break;
  }
  for (const i of left) {
    data[i * 4 + 3] = 0;
    erased++;
  }
  return { erased, filled };
}

/** Drops loose pieces smaller than minSize pixels. */
function despeckle(img, minSize) {
  const { width: w, height: h, data } = img;
  const seen = new Int32Array(w * h).fill(-1);
  const sizes = [];
  for (let i = 0; i < w * h; i++) {
    if (seen[i] >= 0 || data[i * 4 + 3] === 0) continue;
    const id = sizes.length;
    const stack = [i];
    seen[i] = id;
    let n = 0;
    while (stack.length) {
      const j = stack.pop();
      n++;
      const x = j % w;
      for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, j - w, j + w]) {
        if (k >= 0 && k < w * h && seen[k] < 0 && data[k * 4 + 3] > 0) {
          seen[k] = id;
          stack.push(k);
        }
      }
    }
    sizes.push(n);
  }
  let dropped = 0;
  for (let i = 0; i < w * h; i++) {
    if (seen[i] >= 0 && sizes[seen[i]] < minSize) {
      data[i * 4 + 3] = 0;
      dropped++;
    }
  }
  return { pieces: sizes.length, dropped };
}

/** Area-average shrink on premultiplied values, so transparent pixels leave no fringe. */
function shrink(img, w2, h2) {
  const { width: w, height: h, data } = img;
  const sx = w / w2;
  const sy = h / h2;
  const out = new Uint8ClampedArray(w2 * h2 * 4);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      const x0 = x * sx;
      const x1 = (x + 1) * sx;
      const y0 = y * sy;
      const y1 = (y + 1) * sy;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const k = (Math.min(xx + 1, x1) - Math.max(xx, x0)) * wy;
          const i = (yy * w + xx) * 4;
          const al = data[i + 3] / 255;
          r += data[i] * al * k;
          g += data[i + 1] * al * k;
          b += data[i + 2] * al * k;
          a += al * k;
          n += k;
        }
      }
      const o = (y * w2 + x) * 4;
      out[o + 3] = Math.round((a / n) * 255);
      if (a > 0) {
        out[o] = r / a;
        out[o + 1] = g / a;
        out[o + 2] = b / a;
      }
    }
  }
  return { width: w2, height: h2, data: out };
}

/** Distance in pixels (chamfer) from each pixel to the nearest one with alpha under 8. */
function edgeDistance(img) {
  const { width: w, height: h, data } = img;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = data[i * 4 + 3] < 8 ? 0 : 1e9;
  const at = (x, y, c) => (x < 0 || y < 0 || x >= w || y >= h ? c : d[y * w + x] + c);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (d[i]) d[i] = Math.min(d[i], at(x - 1, y, 3), at(x, y - 1, 3), at(x - 1, y - 1, 4), at(x + 1, y - 1, 4));
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (d[i]) d[i] = Math.min(d[i], at(x + 1, y, 3), at(x, y + 1, 3), at(x + 1, y + 1, 4), at(x - 1, y + 1, 4));
    }
  }
  for (let i = 0; i < w * h; i++) d[i] /= 3;
  return d;
}

/** Pixels near the edge that are lighter than the suit just inside them take that inside colour. */
function defringe(img, dist, band) {
  const { width: w, height: h, data } = img;
  const src = new Uint8ClampedArray(data);
  const order = [];
  for (let i = 0; i < w * h; i++) if (dist[i] > 0 && dist[i] < band + 0.5) order.push(i);
  order.sort((a, b) => dist[b] - dist[a]); // innermost first, so each ring reads the one inside it
  for (const i of order) {
    const x = i % w;
    const y = (i / w) | 0;
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (dist[j] > dist[i] + 0.4) {
          const k = 1 / (dx * dx + dy * dy);
          r += data[j * 4] * k;
          g += data[j * 4 + 1] * k;
          b += data[j * 4 + 2] * k;
          n += k;
        }
      }
    }
    if (!n) continue;
    const o = i * 4;
    const inside = [r / n, g / n, b / n];
    const lighter = lum(src, o) - (0.299 * inside[0] + 0.587 * inside[1] + 0.114 * inside[2]);
    if (lighter <= 6) continue; // dark outlines and true colours stay
    const t = Math.min(1, (lighter - 6) / 30) * (dist[i] <= 1.5 ? 1 : 0.6);
    for (let c = 0; c < 3; c++) data[o + c] = src[o + c] + (inside[c] - src[o + c]) * t;
  }
}

/** Shrinks the edge by about 0.7 px and smooths its stair steps, keeping it crisp. */
function smoothEdge(img) {
  const { width: w, height: h, data } = img;
  const a0 = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) a0[i] = data[i * 4 + 3] / 255;
  const at = (arr, x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : arr[y * w + x]);
  const a1 = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const m = Math.min(at(a0, x, y), at(a0, x - 1, y), at(a0, x + 1, y), at(a0, x, y - 1), at(a0, x, y + 1));
      a1[y * w + x] = a0[y * w + x] * 0.3 + m * 0.7;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = (4 * at(a1, x, y) + 2 * (at(a1, x - 1, y) + at(a1, x + 1, y) + at(a1, x, y - 1) + at(a1, x, y + 1)) +
        at(a1, x - 1, y - 1) + at(a1, x + 1, y - 1) + at(a1, x - 1, y + 1) + at(a1, x + 1, y + 1)) / 16;
      const s = Math.max(0, Math.min(1, (v - 0.08) / 0.84));
      const k = s * s * (3 - 2 * s) * 0.5 + s * 0.5;
      data[(y * w + x) * 4 + 3] = Math.round(Math.min(a0[y * w + x], k) * 255);
    }
  }
}

/** A light unsharp mask, only 3 px or more inside the edge. */
function sharpen(img, dist, amount = 0.45, threshold = 3) {
  const { width: w, height: h, data } = img;
  const src = new Uint8ClampedArray(data);
  const row = w * 4;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (dist[i] < 3) continue;
      const o = i * 4;
      for (let c = 0; c < 3; c++) {
        const blur = (4 * src[o + c] + 2 * (src[o - 4 + c] + src[o + 4 + c] + src[o - row + c] + src[o + row + c]) +
          src[o - row - 4 + c] + src[o - row + 4 + c] + src[o + row - 4 + c] + src[o + row + 4 + c]) / 16;
        const diff = src[o + c] - blur;
        if (Math.abs(diff) >= threshold) data[o + c] = src[o + c] + diff * amount * Math.min(1, (dist[i] - 3) / 2 + 0.5);
      }
    }
  }
}

/** Stretches the darkest and brightest 0.4% of the solid pixels toward full range, by at most maxGain. */
function levels(img, maxGain = 1.12) {
  const { data } = img;
  const hist = new Uint32Array(256);
  let n = 0;
  for (let o = 0; o < data.length; o += 4) {
    if (data[o + 3] > 250) {
      hist[Math.round(lum(data, o))]++;
      n++;
    }
  }
  let lo = 0;
  let hi = 255;
  let acc = 0;
  while (acc + hist[lo] < n * 0.004) acc += hist[lo++];
  acc = 0;
  while (acc + hist[hi] < n * 0.004) acc += hist[hi--];
  const gain = Math.min(maxGain, 255 / Math.max(1, hi - lo));
  const offset = Math.min(18, lo * gain);
  for (let o = 0; o < data.length; o += 4) {
    for (let c = 0; c < 3; c++) data[o + c] = data[o + c] * gain - offset;
  }
  return { lo, hi, gain: Number(gain.toFixed(3)) };
}

/** Crops to the visible pixels plus a margin. Returns the picture and where the crop starts. */
function cropToContent(img, margin) {
  const { width: w, height: h, data } = img;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 0) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  }
  x0 = Math.max(0, x0 - margin);
  y0 = Math.max(0, y0 - margin);
  x1 = Math.min(w - 1, x1 + margin);
  y1 = Math.min(h - 1, y1 + margin);
  const W = x1 - x0 + 1;
  const H = y1 - y0 + 1;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) out.set(data.subarray(((y + y0) * w + x0) * 4, ((y + y0) * w + x0 + W) * 4), y * W * 4);
  return { img: { width: W, height: H, data: out }, at: { x: x0, y: y0 } };
}

/** Every step for one picture. Returns the cleaned picture and notes for the console. */
function clean(img, job) {
  const notes = [];
  if (job.key) notes.push(`cut out ${keyOut(img, job.key.bg, job.key.tol, job.key.soft).cut} px of background`);
  if (job.erase) notes.push(`painted web ${JSON.stringify(eraseStrand(img, job.erase))}`);
  if (job.despeckle) notes.push(`specks ${JSON.stringify(despeckle(img, job.despeckle))}`);
  const scale = job.height && job.height < img.height ? job.height / img.height : 1;
  if (scale < 1) img = shrink(img, Math.round(img.width * scale), job.height);
  notes.push(`levels ${JSON.stringify(levels(img))}`);
  defringe(img, edgeDistance(img), 2.5);
  smoothEdge(img);
  const dist = edgeDistance(img);
  defringe(img, dist, 1.5);
  sharpen(img, dist);
  let at = { x: 0, y: 0 };
  if (job.crop !== undefined) {
    ({ img, at } = cropToContent(img, job.crop));
  }
  notes.push(`scaled ${Number(scale.toFixed(4))}, cropped at ${at.x},${at.y}: points in hero.json = (original × ${Number(scale.toFixed(4))}) − (${at.x}, ${at.y})`);
  return { img, notes };
}

// ---- Running it ----------------------------------------------------------------------------------

/** In the hidden window: cleans every picture and writes the WebP files. */
async function runInPage(sources) {
  const { ipcRenderer } = require('electron');
  const say = (line) => ipcRenderer.send('clean-log', line);
  try {
    for (const job of JOBS) {
      const { img, notes } = clean(readPng(path.join(sources, job.source)), job);
      const canvas = new OffscreenCanvas(img.width, img.height);
      canvas.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/webp', quality: QUALITY });
      const out = path.join(HEROES_DIR, job.out);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(await blob.arrayBuffer()));
      say(`${job.out}: ${img.width} × ${img.height}, ${Math.round(blob.size / 1024)} KB\n    ${notes.join('\n    ')}`);
    }
    ipcRenderer.send('clean-done', 0);
  } catch (err) {
    say(`Failed: ${err.stack || err}`);
    ipcRenderer.send('clean-done', 1);
  }
}

if (process.type === 'browser') {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const sources = process.argv[process.argv.length - 1];
  if (!sources || sources === __filename || !fs.existsSync(sources)) {
    console.error('Usage: npx electron scripts/clean-heroes.js <folder with the original pictures>');
    process.exit(1);
  }
  app.whenReady().then(() => {
    ipcMain.on('clean-log', (_event, line) => console.log(line));
    ipcMain.on('clean-done', (_event, code) => app.exit(code));
    const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
    const script = `require(${JSON.stringify(__filename)}).runInPage(${JSON.stringify(path.resolve(sources))})`;
    win.loadURL(`data:text/html,<script>${encodeURIComponent(script)}</script>`);
  });
}

module.exports = { JOBS, readPng, keyOut, eraseStrand, despeckle, shrink, levels, cropToContent, clean, runInPage };
