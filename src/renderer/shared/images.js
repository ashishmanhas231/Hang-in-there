/*
 * The user's pictures.
 *
 * The measuring (visible box, tie-on point, centre of weight, foot) works on raw RGBA pixels, so the
 * Node tests can check it without a browser. Decoding and resizing need the overlay page
 * (createImageBitmap), and are done by decodePicture() and makeBitmap() below.
 */
(function (root) {
  'use strict';

  const V = typeof module === 'object' && module.exports ? require('./vec.js') : root.SH.vec;

  /** Pixels with less alpha than this count as empty when finding the picture's edges. */
  const ALPHA_THRESHOLD = 24;

  // ---- Decoding (browser only) ------------------------------------------------------------

  /** Decodes picture bytes into { bitmap, data (RGBA), width, height }. Throws with a readable message. */
  async function decodePicture(bytes) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(new Blob([bytes]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    } catch (err) {
      throw new Error('The file is not a picture this app can read (PNG, WebP, GIF, BMP or JPG).');
    }
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    return { bitmap, data, width: bitmap.width, height: bitmap.height };
  }

  /**
   * Crops box out of the decoded picture and shrinks it once, with the high-quality filter.
   * Stored at exactly screen-pixel size, so drawing it each frame only turns it, never shrinks it.
   * (Shrinking every frame with the quick filter made the edges sparkle as he swung.)
   */
  async function makeBitmap(decoded, box, pixelScale) {
    const width = Math.max(1, Math.round(box.width * pixelScale));
    const height = Math.max(1, Math.round(box.height * pixelScale));
    return createImageBitmap(decoded.bitmap, box.x, box.y, box.width, box.height, {
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: 'high',
    });
  }

  // ---- Measuring ----------------------------------------------------------------------------

  /** The smallest box holding every visible pixel, or null if the picture is completely transparent. */
  function findContent(data, width, height) {
    let left = width;
    let top = height;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < height; y++) {
      const row = y * width * 4;
      for (let x = 0; x < width; x++) {
        if (data[row + x * 4 + 3] >= ALPHA_THRESHOLD) {
          if (x < left) left = x;
          if (x > right) right = x;
          if (y < top) top = y;
          if (y > bottom) bottom = y;
        }
      }
    }
    return right < 0 ? null : V.rect(left, top, right - left + 1, bottom - top + 1);
  }

  /** Average x of the visible pixels in some rows. */
  function centerOfRows(data, width, box, fromRow, rows) {
    let sum = 0;
    let count = 0;
    for (let y = fromRow; y < fromRow + rows; y++) {
      for (let x = box.x; x < box.x + box.width; x++) {
        if (data[(y * width + x) * 4 + 3] >= ALPHA_THRESHOLD) {
          sum += x;
          count++;
        }
      }
    }
    return count > 0 ? sum / count : box.x + box.width / 2;
  }

  /** Alpha-weighted average position of the visible pixels, in box coordinates. */
  function centerOfWeight(data, width, box) {
    let sum = 0;
    let sumX = 0;
    let sumY = 0;
    for (let y = box.y; y < box.y + box.height; y++) {
      const row = y * width * 4;
      for (let x = box.x; x < box.x + box.width; x++) {
        const alpha = data[row + x * 4 + 3];
        if (alpha > 0) {
          sum += alpha;
          sumX += alpha * (x - box.x);
          sumY += alpha * (y - box.y);
        }
      }
    }
    return sum > 0 ? V.v(sumX / sum, sumY / sum) : V.v(box.width / 2, box.height / 2);
  }

  /**
   * Measures a hanging picture (CustomFigure). The web ties on at the middle of the visible pixels
   * along its top edge, or the bottom edge when flipped (an upright picture hung by its feet).
   * heightShare: how tall the visible part is, in body lengths.
   */
  function measureFigure(data, width, height, flip, bodyLength, heightShare = 1.3, hold = {}) {
    const box = findContent(data, width, height);
    if (!box) {
      throw new Error('The picture is completely transparent.');
    }
    let attachX;
    let attachY;
    let balanceDegrees;
    if (hold.grip) {
      // hero.json named the spot he holds the web by (a fist mid-picture). He keeps the pose as
      // drawn, turned by "tilt" if given, instead of tipping round to balance under that spot.
      attachX = Math.max(0, Math.min(box.width, hold.grip.x - box.x));
      attachY = Math.max(0, Math.min(box.height, hold.grip.y - box.y));
      balanceDegrees = typeof hold.tilt === 'number' ? hold.tilt : 0;
    } else {
      // A thin band, so a fist or a pair of feet at the very top decides it, not the arm below.
      const band = Math.max(1, Math.floor(box.height / 50));
      const fromRow = flip ? box.y + box.height - band : box.y;
      attachX = centerOfRows(data, width, box, fromRow, band) - box.x;
      attachY = flip ? box.height : 0;

      // Anything held from one point tips until its weight sits straight below that point. Tilt the
      // picture the same way. A flipped picture is turned 180 degrees first.
      const weight = centerOfWeight(data, width, box);
      const down = flip ? V.v(attachX - weight.x, attachY - weight.y) : V.v(weight.x - attachX, weight.y - attachY);
      balanceDegrees = typeof hold.tilt === 'number' ? hold.tilt : (Math.atan2(down.x, down.y) * 180) / Math.PI;
    }

    // Scale so the visible part is heightShare body lengths tall, and never wider than 85% of that.
    let scale = (bodyLength * heightShare) / box.height;
    scale = Math.min(scale, (bodyLength * heightShare * 0.85) / box.width);
    return { box, attachX, attachY, balanceDegrees, scale, gripped: Boolean(hold.grip), face: hold.face || null, faceSize: hold.faceSize || null };
  }

  /** A hanging picture, ready to draw with the tie-on point at (0, 0) and its weight toward +y. */
  class CustomFigure {
    constructor(measure, flip, bitmap, pixelsPerDip) {
      this.flip = flip;
      this.bitmap = bitmap;
      this.pixelsPerDip = pixelsPerDip;
      this.balanceDegrees = measure.balanceDegrees;
      this.gripped = Boolean(measure.gripped);
      this.attach = V.v(measure.attachX * measure.scale * pixelsPerDip, measure.attachY * measure.scale * pixelsPerDip);
      this.size = V.v(measure.box.width * measure.scale, measure.box.height * measure.scale);
      // His face, in drawing units from the tie-on point before any turning (hero.json "face").
      this.face = null;
      if (measure.face) {
        this.face = {
          x: (measure.face.x - measure.box.x - measure.attachX) * measure.scale,
          y: (measure.face.y - measure.box.y - measure.attachY) * measure.scale,
          r: (measure.faceSize || 0) * measure.scale,
        };
      }
    }

    /** Where his face is, turned the way draw() turns the picture, or null if the picture has no face set. */
    facePoint() {
      if (!this.face) {
        return null;
      }
      const turn = (this.balanceDegrees * Math.PI) / 180 + (this.flip ? Math.PI : 0);
      const c = Math.cos(turn);
      const s = Math.sin(turn);
      return { x: this.face.x * c - this.face.y * s, y: this.face.x * s + this.face.y * c, r: this.face.r };
    }

    draw(ctx, opacity = 1) {
      if (!this.bitmap || opacity <= 0.001) {
        return;
      }
      ctx.save();
      ctx.globalAlpha *= opacity;
      ctx.rotate((this.balanceDegrees * Math.PI) / 180);
      if (this.flip) {
        ctx.rotate(Math.PI);
      }
      ctx.scale(1 / this.pixelsPerDip, 1 / this.pixelsPerDip);
      ctx.drawImage(this.bitmap, -this.attach.x, -this.attach.y, this.bitmap.width, this.bitmap.height);
      ctx.restore();
    }

    static async load(bytes, flip, bodyLength, pixelsPerDip, heightShare = 1.3, hold = {}) {
      const decoded = await decodePicture(bytes);
      const measure = measureFigure(decoded.data, decoded.width, decoded.height, flip, bodyLength, heightShare, hold);
      const bitmap = await makeBitmap(decoded, measure.box, measure.scale * pixelsPerDip);
      return new CustomFigure(measure, flip, bitmap, pixelsPerDip);
    }
  }

  const api = { CustomFigure, measureFigure, findContent, decodePicture, ALPHA_THRESHOLD };
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    (root.SH || (root.SH = {})).images = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
