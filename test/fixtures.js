'use strict';
/*
 * Test pictures: plain coloured stick figures and discs, written as PNGs with no dependencies.
 */
const zlib = require('zlib');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGBA pixels -> PNG bytes. */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy ? rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
      : Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A canvas of RGBA pixels with a few filled shapes. */
function pixels(width, height) {
  const data = Buffer.alloc(width * height * 4);
  const set = (x, y, c) => {
    if (x >= 0 && y >= 0 && x < width && y < height) {
      data.set(c, (y * width + x) * 4);
    }
  };
  return {
    width, height, data,
    rect(x0, y0, x1, y1, c) { for (let y = Math.round(y0); y < y1; y++) for (let x = Math.round(x0); x < x1; x++) set(x, y, c); return this; },
    disc(cx, cy, r, c) { for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) set(Math.round(x), Math.round(y), c); return this; },
    flipVertical() { const out = Buffer.alloc(data.length); for (let y = 0; y < height; y++) data.copy(out, (height - 1 - y) * width * 4, y * width * 4, (y + 1) * width * 4); out.copy(data); return this; },
    png() { return encodePng(width, height, data); },
  };
}

/** A standing stick figure, 200 x 400. wide: a broader body (crouch, landing). */
function person(color, { wide = false, armsUp = false } = {}) {
  const p = pixels(200, 400);
  const bw = wide ? 120 : 70;
  p.disc(100, 50, 30, color);
  p.rect(100 - bw / 2, 85, 100 + bw / 2, 250, color);
  p.rect(100 - bw / 2, 250, 95, 390, color);
  p.rect(105, 250, 100 + bw / 2, 390, color);
  p.rect(10, armsUp ? 40 : 95, 100 - bw / 2, armsUp ? 55 : 110, color);
  p.rect(100 + bw / 2, armsUp ? 40 : 95, 190, armsUp ? 55 : 110, color);
  return p;
}

module.exports = { encodePng, pixels, person };
