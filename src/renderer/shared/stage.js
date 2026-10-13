/*
 * Draws the hanging hero: the web he hangs from, its ends, and either the drawn figure or a hero's
 * pictures, with pose changes and cross-fades.
 *
 * The web is drawn in layers: a soft shadow, several thin strokes side by side for rounded shading,
 * then twist marks so it reads as twisted silk.
 */
(function (root) {
  'use strict';

  const node = typeof module === 'object' && module.exports;
  const RIG = node ? require('./rig.js') : root.SH.rig;
  const STEP = RIG.STEP;
  const IMAGES = node ? require('./images.js') : root.SH.images;

  const rgba = (c, a = 1) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${Math.max(0, Math.min(1, a))})`;
  const SILK = [0xf1, 0xf3, 0xf6];
  const SILK_SHADE = [0x9c, 0xa6, 0xb2];
  const SILK_DEEP = [0x5e, 0x67, 0x72];
  const WHITE = [255, 255, 255];
  // Colour strings for the shading bands, made once rather than every frame.
  const TONES = [SILK_DEEP, SILK_SHADE, WHITE, SILK_SHADE, SILK_DEEP].map((c) => rgba(c));
  const TWIST = rgba(SILK_DEEP, 120 / 255);
  const LINE_STYLES = ['web', 'none'];

  /**
   * A hero's pictures, loaded and sized. Asking for a pose he does not have gives the nearest one:
   * grab and fly fall back to swing, swing falls back to hang.
   */
  class HeroLook {
    constructor(name, line, poses) {
      this.name = name;
      this.poses = poses; // pose name -> CustomFigure
      this.line = line === 'none' ? 'none' : 'web';
    }

    pose(name) {
      const order = [name];
      if (name === 'grab' || name === 'fly') {
        order.push('swing');
      }
      order.push('hang');
      for (const candidate of order) {
        if (this.poses[candidate]) {
          return this.poses[candidate];
        }
      }
      return Object.values(this.poses)[0] || null;
    }
  }

  class Stage {
    constructor(rig, drawFigure) {
      this.rig = rig;
      this.drawFigure = drawFigure || null; // (ctx, armOffset) for the drawn figure
      this.armOffset = 0;
      this.prevTheta = null;
      this.lookValue = null;
      this.poseName = 'hang';
      this.candidate = null;
      this.candidateTime = 0;
      this.shown = null;
      this.fadingOut = null;
      this.fade = 1;
      this.activity = 0;
      this.dragging = false;
      /** How far between the last two physics steps to draw (0..1), so motion is smooth between steps. */
      this.blend = 1;
    }

    get look() {
      return this.lookValue;
    }

    set look(value) {
      this.lookValue = value;
      this.shown = value ? value.pose(this.poseName) : null;
      this.fadingOut = null;
      this.fade = 1;
      this.candidate = null;
    }

    get currentPose() {
      return this.poseName;
    }

    get settled() {
      return Math.abs(this.armOffset) < 0.002 && this.fade >= 1 && this.candidate === null;
    }

    get line() {
      return this.lookValue ? this.lookValue.line : 'web';
    }

    get ropeWidth() {
      return Math.max(1.8, Math.min(3.4, this.rig.bodyLength / 55));
    }

    at(p) {
      const back = 1 - this.blend;
      return { x: p.x - back * (p.x - p.px), y: p.y - back * (p.y - p.py) };
    }

    resetPose() {
      this.prevTheta = null;
      this.armOffset = 0;
      this.activity = 0;
      this.poseName = 'hang';
      this.candidate = null;
      this.shown = this.lookValue ? this.lookValue.pose(this.poseName) : null;
      this.fadingOut = null;
      this.fade = 1;
    }

    /** Arm lag and pose changes. Call once per drawn frame. */
    advance(frameDt) {
      if (this.rig.particles.length === 0) {
        return;
      }
      const theta = this.bodyAngle();
      if (this.prevTheta !== null && frameDt > 0) {
        let delta = theta - this.prevTheta;
        delta = ((((delta + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
        // Loose arms lag behind the swing.
        const target = Math.max(-0.7, Math.min(0.7, (-delta / frameDt) * 0.1));
        this.armOffset += (target - this.armOffset) * 0.12;
      }
      this.prevTheta = theta;
      this.updatePose(frameDt);
    }

    updatePose(frameDt) {
      const look = this.lookValue;
      if (!look) {
        return;
      }
      const ankle = this.rig.ankle;
      const speed = Math.hypot(ankle.x - ankle.px, ankle.y - ankle.py) / STEP;
      this.activity = Math.max(speed, this.activity * Math.exp(-frameDt / 0.8));

      // Separate thresholds for starting and stopping a pose, so he cannot flick back and forth while
      // the speed or angle hovers near one value.
      const flyFrom = this.poseName === 'fly' ? 0.6 : 0.75; // radians: about 34 and 43 degrees
      const swingFrom = this.poseName === 'swing' || this.poseName === 'fly' ? 90 : 150;
      const wanted = this.dragging ? 'grab'
        : Math.abs(this.rig.ropeAngle) > flyFrom ? 'fly'
        : this.activity > swingFrom ? 'swing'
        : 'hang';

      if (wanted === this.poseName) {
        this.candidate = null;
      } else {
        if (wanted !== this.candidate) {
          this.candidate = wanted;
          this.candidateTime = 0;
        }
        this.candidateTime += frameDt;
        // Each pose needs to hold for 0.2 s before it shows.
        if (this.dragging || this.candidateTime >= 0.2) {
          this.poseName = wanted;
          this.candidate = null;
          const next = look.pose(this.poseName);
          if (next !== this.shown) {
            this.fadingOut = this.shown;
            this.shown = next;
            this.fade = 0;
          }
        }
      }
      if (this.fade < 1) {
        this.fade = Math.min(1, this.fade + frameDt / 0.25);
      }
    }

    bodyAngle() {
      const ankle = this.at(this.rig.ankle);
      const head = this.at(this.rig.head);
      return Math.atan2(head.y - ankle.y, head.x - ankle.x) + Math.PI / 2;
    }

    /**
     * His face in window units, { x, y, r }, where a reminder bubble should point. Uses the picture's
     * hero.json "face" when it has one; otherwise his head end, as for the drawn Spider-Man.
     */
    facePoint() {
      if (this.rig.particles.length === 0) {
        return null;
      }
      const ankle = this.at(this.rig.ankle);
      const local = this.lookValue && this.shown && this.shown.facePoint ? this.shown.facePoint() : null;
      if (local) {
        // Same turn as draw(): the picture hangs from its top edge, so 180 degrees less than the drawing.
        const turn = this.bodyAngle() - Math.PI;
        const c = Math.cos(turn);
        const s = Math.sin(turn);
        return { x: ankle.x + local.x * c - local.y * s, y: ankle.y + local.x * s + local.y * c, r: local.r || this.rig.bodyLength * 0.12 };
      }
      const head = this.at(this.rig.head);
      return { x: head.x, y: head.y, r: this.rig.bodyLength * 0.12 };
    }

    draw(ctx) {
      if (this.rig.particles.length === 0) {
        return;
      }
      const line = this.sampleRope();
      // A picture held by a fist mid-body ("grip" in hero.json) has the web across the front of him,
      // as in the picture it came from; otherwise his body hides the web.
      const webInFront = Boolean(this.lookValue && this.shown && this.shown.gripped);
      if (!webInFront) {
        this.drawLine(ctx, line);
      }
      this.drawTopFitting(ctx);

      const theta = this.bodyAngle();
      const ankle = this.at(this.rig.ankle);
      ctx.save();
      ctx.translate(ankle.x, ankle.y);
      if (this.lookValue) {
        // A picture hangs from its top edge, so it needs 180 degrees less turn than the upright drawing.
        ctx.save();
        ctx.rotate(theta - Math.PI);
        if (this.fadingOut && this.fade < 1) {
          this.fadingOut.draw(ctx, 1 - this.fade);
          if (this.shown) {
            this.shown.draw(ctx, this.fade);
          }
        } else if (this.shown) {
          this.shown.draw(ctx, 1);
        }
        ctx.restore();
        this.drawEndFitting(ctx);
      } else if (this.drawFigure) {
        ctx.rotate(theta);
        const scale = this.rig.bodyLength / 100;
        ctx.scale(scale, scale);
        this.drawFigure(ctx, this.armOffset);
      }
      ctx.restore();
      if (webInFront) {
        this.drawLine(ctx, line);
      }
    }

    /**
     * True if a point catches the mouse: the knot, the line, or a drawn pixel of him.
     * Everywhere else clicks fall through to the window underneath.
     * alphaAt(x, y) returns the drawn alpha (0..255) at a window point.
     */
    hitTest(pt, alphaAt) {
      const rig = this.rig;
      if (rig.particles.length === 0) {
        return false;
      }
      if (Math.hypot(pt.x - rig.anchor.x, pt.y - rig.anchor.y * 0.6) < 18) {
        return true;
      }
      if (this.line !== 'none') {
        const reach = Math.max(5, this.ropeWidth * 2);
        for (let i = 0; i < rig.ropeCount - 1; i++) {
          if (segmentDistance(pt, rig.particles[i], rig.particles[i + 1]) < reach) {
            return true;
          }
        }
      }
      if (!this.lookValue) {
        // The drawn figure: a band along his body, so the gaps between limbs still catch the mouse.
        const half = 13 * (rig.bodyLength / 100);
        if (segmentDistance(pt, rig.ankle, rig.head) < half) {
          return true;
        }
      }
      // Reading a pixel back from the canvas is slow, so only do it when the pointer is within reach
      // of the picture (no part of it is further from the tie-on point than its diagonal).
      const figure = this.shown;
      const reach = figure && figure.size ? Math.hypot(figure.size.x, figure.size.y) : rig.bodyLength * 1.6;
      if (Math.hypot(pt.x - rig.ankle.x, pt.y - rig.ankle.y) > reach + 4) {
        return false;
      }
      return alphaAt ? alphaAt(pt.x, pt.y) > 0 : false;
    }

    // ---- The line ------------------------------------------------------------------------

    sampleRope() {
      const SAMPLES = 4;
      const particles = this.rig.particles;
      const count = this.rig.ropeCount;
      const points = [this.at(particles[0])];
      let from = points[0];
      for (let i = 1; i < count - 1; i++) {
        const control = this.at(particles[i]);
        const next = this.at(particles[i + 1]);
        const to = { x: (control.x + next.x) / 2, y: (control.y + next.y) / 2 };
        for (let k = 1; k <= SAMPLES; k++) {
          const t = k / SAMPLES;
          const u = 1 - t;
          points.push({
            x: u * u * from.x + 2 * u * t * control.x + t * t * to.x,
            y: u * u * from.y + 2 * u * t * control.y + t * t * to.y,
          });
        }
        from = to;
      }
      points.push(this.at(this.rig.ankle));
      return points;
    }

    drawLine(ctx, line) {
      if (this.line === 'none') {
        return;
      }
      const w = this.ropeWidth;
      const normals = normalsOf(line);
      strokeLine(ctx, shift(line, 0.9, 1.2), 'rgba(0, 0, 0, 0.157)', w + 3.2);
      strokeLine(ctx, shift(line, 0.4, 0.6), 'rgba(0, 0, 0, 0.275)', w + 1.4);

      const bands = TONES.length;
      for (let i = 0; i < bands; i++) {
        const across = ((i - (bands - 1) / 2) / bands) * w;
        strokeLine(ctx, offset(line, normals, across), TONES[i], (w / bands) * 1.6);
      }

      // Twist marks sit on the fixed sample points, so they move with the rope. Do not go back to a
      // dashed pen: dashes are measured along the curve, and as the rope bent they crept along it.
      ctx.beginPath();
      for (let i = 2; i < line.length - 2; i++) {
        let ax = line[i + 1].x - line[i - 1].x;
        let ay = line[i + 1].y - line[i - 1].y;
        const l = Math.hypot(ax, ay);
        if (l < 1e-9) {
          continue;
        }
        ax /= l;
        ay /= l;
        const n = normals[i];
        ctx.moveTo(line[i].x - n.x * (w * 0.38) - ax * (w * 0.3), line[i].y - n.y * (w * 0.38) - ay * (w * 0.3));
        ctx.lineTo(line[i].x + n.x * (w * 0.38) + ax * (w * 0.3), line[i].y + n.y * (w * 0.38) + ay * (w * 0.3));
      }
      roundStroke(ctx, TWIST, w * 0.28);
      strokeLine(ctx, offset(line, normals, -w * 0.28), 'rgba(255, 255, 255, 0.784)', w * 0.18);
      drawFibres(ctx, line, normals, w);
    }

    // ---- Fittings at each end of the line ------------------------------------------------

    drawTopFitting(ctx) {
      if (this.line !== 'none') {
        drawSplat(ctx, this.rig.anchor.x, this.rig.anchor.y, this.ropeWidth);
      }
    }

    drawEndFitting(ctx) {
      if (this.line !== 'none') {
        drawBlob(ctx, 0, 0, this.ropeWidth * 1.1);
      }
    }
  }

  // ---- Small drawing helpers ---------------------------------------------------------------

  function roundStroke(ctx, color, width) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  function strokeLine(ctx, points, color, width) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    roundStroke(ctx, color, width);
  }

  function drawFibres(ctx, line, normals, w) {
    ctx.beginPath();
    let index = 0;
    for (let i = 6; i < line.length - 3; i += 5 + ((index * 3) % 4)) {
      // A fixed pseudo-random pattern, so fibres look scattered but never move along the rope.
      const side = index % 2 === 0 ? 1 : -1;
      const length = 2.2 + ((index * 37) % 5) * 0.6;
      let ax = line[i + 1].x - line[i - 1].x;
      let ay = line[i + 1].y - line[i - 1].y;
      const l = Math.hypot(ax, ay);
      if (l < 1e-9) {
        continue;
      }
      ax /= l;
      ay /= l;
      const n = normals[i];
      const sx = line[i].x + n.x * side * w * 0.4;
      const sy = line[i].y + n.y * side * w * 0.4;
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(
        sx + ax * length * 0.5 + n.x * side * length * 0.25,
        sy + ay * length * 0.5 + n.y * side * length * 0.25,
        sx + ax * length + n.x * side * length * 0.6,
        sy + ay * length + n.y * side * length * 0.6
      );
      index++;
    }
    roundStroke(ctx, rgba(SILK, 150 / 255), 0.5);
  }

  /** The splat of strands that sticks the web to the top of the screen. */
  function drawSplat(ctx, cx, cy, ropeWidth) {
    const dabs = [];
    ctx.beginPath();
    for (const dx of [-19, -12, -6.5, -2, 3, 8.5, 14, 20]) {
      ctx.moveTo(cx, cy);
      ctx.quadraticCurveTo(cx + dx * 0.3, cy * 0.45, cx + dx, 0);
      dabs.push(cx + dx);
    }
    // Cross strands, like the start of a real web.
    ctx.moveTo(cx - 10, 3.4);
    ctx.quadraticCurveTo(cx, 5.2, cx + 11, 3.2);
    ctx.moveTo(cx - 15, 1.2);
    ctx.quadraticCurveTo(cx, 3.0, cx + 16, 1.2);
    roundStroke(ctx, 'rgba(0, 0, 0, 0.275)', 1.8);
    roundStroke(ctx, rgba(SILK), 0.75);
    ctx.fillStyle = rgba(SILK, 225 / 255);
    for (const x of dabs) {
      ctx.beginPath();
      ctx.ellipse(x, 0, 1.6, 1.1, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    drawBlob(ctx, cx, cy, ropeWidth * 1.2);
  }

  function drawBlob(ctx, x, y, radius) {
    const gradient = ctx.createRadialGradient(x - radius * 0.3, y - radius * 0.46, 0, x, y, radius * 1.15);
    gradient.addColorStop(0, '#ffffff');
    gradient.addColorStop(1, rgba(SILK_SHADE));
    ctx.beginPath();
    ctx.ellipse(x, y, radius, radius * 1.15, 0, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.43)';
    ctx.stroke();
  }

  function normalsOf(line) {
    const normals = [];
    for (let i = 0; i < line.length; i++) {
      const a = line[Math.max(i - 1, 0)];
      const b = line[Math.min(i + 1, line.length - 1)];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const l = Math.hypot(dx, dy);
      if (l < 1e-9) {
        dx = 0;
        dy = 1;
      } else {
        dx /= l;
        dy /= l;
      }
      normals.push({ x: -dy, y: dx });
    }
    return normals;
  }

  function offset(line, normals, distance) {
    return line.map((p, i) => ({ x: p.x + normals[i].x * distance, y: p.y + normals[i].y * distance }));
  }

  function shift(line, dx, dy) {
    return line.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  }

  function segmentDistance(p, a, b) {
    const sx = b.x - a.x;
    const sy = b.y - a.y;
    const lsq = sx * sx + sy * sy;
    const t = lsq > 1e-9 ? Math.max(0, Math.min(1, ((p.x - a.x) * sx + (p.y - a.y) * sy) / lsq)) : 0;
    return Math.hypot(p.x - (a.x + sx * t), p.y - (a.y + sy * t));
  }

  /**
   * Builds the look the main process sent:
   *   { kind: 'drawn' }
   *   { kind: 'hero', name, line, poses: { pose: { bytes, file, grip, tilt, face, faceSize } } }
   * Resolves a HeroLook, or null for the drawn figure. Anything that fails is reported through
   * problem(message) and falls back to the drawn figure.
   */
  async function loadLook(look, bodyLength, pixelsPerDip, problem) {
    if (!look || look.kind !== 'hero') {
      return null;
    }
    const loaded = {};
    for (const [pose, picture] of Object.entries(look.poses || {})) {
      try {
        loaded[pose] = await IMAGES.CustomFigure.load(picture.bytes, false, bodyLength, pixelsPerDip, 1.3,
          { grip: picture.grip || null, tilt: typeof picture.tilt === 'number' ? picture.tilt : null,
            face: picture.face || null, faceSize: picture.faceSize || null });
      } catch (err) {
        problem(`${look.name}: could not load ${picture.file}. ${err.message}`);
      }
    }
    if (Object.keys(loaded).length === 0) {
      problem(`None of ${look.name}'s pictures would load, so the drawn Spider-Man is shown.`);
      return null;
    }
    return new HeroLook(look.name, look.line || 'web', loaded);
  }

  const api = { Stage, HeroLook, LINE_STYLES, SILK, loadLook };
  if (node) {
    module.exports = api;
  } else {
    (root.SH || (root.SH = {})).stage = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
