/*
 * Draws the hanging hero: the web he hangs from, its ends, and either the drawn figure or a hero's
 * pictures. A picture changes pose with a quick snap (the old one tucks in, the new one springs out),
 * trails its swing a little (follow-through), stretches when the web snaps taut, and shoots new webs
 * from its hand. All of it settles, so drawing still stops when he is still.
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
  /** The web he let go of fades out over this long (seconds). */
  const LET_GO_SECONDS = 0.4;
  /** A new web shot from his hand passes to the hand that holds it (the tie-on point) over this long. */
  const HANDOVER_SECONDS = 0.2;
  /** Pose snap: the old picture tucks in toward the tie-on point, then the new one springs out. */
  const SNAP_OUT = 0.09;
  const SNAP_IN = 0.14;
  /** Follow-through: a picture trails its swing by this much per radian a second, at most MAX_SWAY. */
  const FOLLOW = 0.08;
  const MAX_SWAY = (6 * Math.PI) / 180;
  const SWAY_SPRING = 120;
  const SWAY_DAMPING = 2 * Math.sqrt(SWAY_SPRING); // critically damped: follows without overshooting
  /** Stretch when the web snaps taut: at most 4.5% along his body, gone within STRETCH_SECONDS. */
  const STRETCH = 0.045;
  const STRETCH_SECONDS = 0.45;
  /** A reminder's thwip: its web takes this long from his hand to the bubble, then fades out. */
  const THWIP_SECONDS = 0.15;
  const THWIP_FADE = 0.3;
  /** A new web's splat bursts open over this long. */
  const SPLAT_SECONDS = 0.18;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const smooth = (v) => {
    const k = clamp(v, 0, 1);
    return k * k * (3 - 2 * k);
  };

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

    /** Frees the pictures' memory. The look must not be drawn after this. */
    close() {
      for (const figure of Object.values(this.poses)) {
        if (figure && figure.close) {
          figure.close();
        }
      }
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
      /** A pose change on its way: { from (the picture before), age }, or null. */
      this.snap = null;
      /** Follow-through: how far the picture trails its swing (radians), and how fast that changes. */
      this.sway = 0;
      this.swayV = 0;
      /** The web just snapped taut: { age, amount }, or null. */
      this.stretch = null;
      /** A reminder's thwip, from his hand to the bubble: { to: {x, y}, age }, or null. Set by the page. */
      this.tether = null;
      /** No snap, follow-through, stretch or thwip: the page sets this from prefers-reduced-motion. */
      this.reducedMotion = false;
      /** How visible all of it is (0..1), for dropping in and climbing out. */
      this.opacity = 1;
      /**
       * Lists of points reused for every frame's lines, by name, so drawing allocates nothing as he
       * moves (a new list for each rope, shading band and shadow every frame kept memory growing).
       */
      this.buffers = new Map();
      this.activity = 0;
      this.dragging = false;
      /** How far between the last two physics steps to draw (0..1), so motion is smooth between steps. */
      this.blend = 1;
      /** True while he swings across the screen: the swing pose throughout, never the resting one. */
      this.travelling = false;
      /** The web he just let go of, fading: { age, line } (window units), or null. */
      this.letGo = null;
      /** In the air, the new web on its way up (from travel.js): { x, y, share } in window units, or null. */
      this.aim = null;
      this.hadAim = false;
      /** Where the web was tied last frame, and how long ago a new one stuck (its splat opening), or null. */
      this.lastAnchorX = null;
      this.splatAge = null;
      /** Just caught: the web's end moving from his shooting hand to where he holds it, { age }, or null. */
      this.handover = null;
    }

    get look() {
      return this.lookValue;
    }

    set look(value) {
      if (this.lookValue && this.lookValue !== value) {
        this.lookValue.close(); // its pictures are not needed any more
      }
      this.lookValue = value;
      this.shown = value ? value.pose(this.poseName) : null;
      this.snap = null;
      this.candidate = null;
    }

    get currentPose() {
      return this.poseName;
    }

    get settled() {
      return Math.abs(this.armOffset) < 0.002 && this.snap === null && this.candidate === null &&
        this.letGo === null && this.aim === null && this.handover === null && this.stretch === null && this.splatAge === null &&
        Math.abs(this.sway) < 0.0015 && Math.abs(this.swayV) < 0.01 && this.tether === null;
    }

    /** The web snapped taut (a push, a drag let go, a new web caught): a short stretch, 0..1 strong. */
    jerk(amount = 1) {
      if (this.lookValue && !this.reducedMotion) {
        this.stretch = { age: 0, amount: clamp(amount, 0, 1) };
      }
    }

    /** He has just let go of his web: it stays where it was and fades. Call right after rig.release(). */
    letGoWeb() {
      // Its own copy: the rope's buffer is reused every frame.
      this.letGo = { age: 0, line: this.sampleRope().map((p) => ({ x: p.x, y: p.y })) };
    }

    /** The window moved by -dx: keeps what the stage remembers in window units in place on screen. */
    shiftBy(dx) {
      if (this.lastAnchorX !== null) {
        this.lastAnchorX += dx;
      }
      if (this.letGo) {
        for (const p of this.letGo.line) {
          p.x += dx;
        }
      }
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
      this.snap = null;
      this.sway = 0;
      this.swayV = 0;
      this.stretch = null;
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
        // A picture's body trails its swing a little, on a spring.
        const trail = this.lookValue && !this.reducedMotion && !this.rig.free ? clamp((-delta / frameDt) * FOLLOW, -MAX_SWAY, MAX_SWAY) : 0;
        this.swayV += (SWAY_SPRING * (trail - this.sway) - SWAY_DAMPING * this.swayV) * frameDt;
        this.sway = clamp(this.sway + this.swayV * frameDt, -MAX_SWAY, MAX_SWAY);
        if (Math.abs(this.sway) < 1e-4 && Math.abs(this.swayV) < 1e-3 && trail === 0) {
          this.sway = 0;
          this.swayV = 0;
        }
      }
      this.prevTheta = theta;
      if (this.stretch) {
        this.stretch.age += frameDt;
        if (this.stretch.age >= STRETCH_SECONDS) {
          this.stretch = null;
        }
      }
      if (this.tether) {
        // With reduced motion there is no thwip at all.
        this.tether.age = this.reducedMotion ? Infinity : this.tether.age + frameDt;
        if (this.tether.age >= THWIP_SECONDS + THWIP_FADE) {
          this.tether = null;
        }
      }
      const anchorX = this.rig.anchor.x;
      if (!this.rig.free && this.lastAnchorX !== null && Math.abs(anchorX - this.lastAnchorX) > 20 && !this.reducedMotion) {
        this.splatAge = 0; // tied somewhere new: a new web stuck there
      }
      this.lastAnchorX = this.rig.free ? this.lastAnchorX : anchorX;
      if (this.splatAge !== null) {
        this.splatAge += frameDt;
        if (this.splatAge >= SPLAT_SECONDS) {
          this.splatAge = null;
        }
      }
      const aiming = this.aim !== null && this.aim.share > 0;
      if (this.hadAim && !aiming && !this.rig.free) {
        this.handover = { age: 0 }; // the new web caught
      }
      this.hadAim = aiming;
      if (this.handover) {
        this.handover.age += frameDt;
        if (this.handover.age >= HANDOVER_SECONDS) {
          this.handover = null;
        }
      }
      this.updatePose(frameDt);
      if (this.letGo) {
        this.letGo.age += frameDt;
        if (this.letGo.age >= LET_GO_SECONDS) {
          this.letGo = null;
        }
      }
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
      // Swinging across the screen he keeps one pose: the fly pose flicking on and off at the top of
      // every swing, cross-fading each time, looked like a stutter.
      const wanted = this.dragging ? 'grab'
        : this.travelling ? 'swing'
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
            this.snap = this.shown && !this.reducedMotion ? { from: this.shown, age: 0 } : null;
            this.shown = next;
          }
        }
      }
      if (this.snap) {
        this.snap.age += frameDt;
        if (this.snap.age >= SNAP_OUT + SNAP_IN) {
          this.snap = null;
        }
      }
    }

    /**
     * The picture to draw now and how big (around the tie-on point): during a pose snap, the old one
     * tucking in, then the new one springing out past full size and back.
     */
    pictureNow() {
      if (!this.snap) {
        return { picture: this.shown, scale: 1 };
      }
      const u = this.snap.age;
      if (u < SNAP_OUT) {
        const p = u / SNAP_OUT;
        return { picture: this.snap.from, scale: 1 - 0.1 * p * p };
      }
      const p = (u - SNAP_OUT) / SNAP_IN;
      const scale = p < 0.55 ? 0.9 + 0.14 * (1 - (1 - p / 0.55) ** 2) : 1.04 - 0.04 * smooth((p - 0.55) / 0.45);
      return { picture: this.shown, scale };
    }

    /** Along his body: 1, or a little more for a moment after the web snaps taut. */
    stretchNow() {
      if (!this.stretch) {
        return 1;
      }
      const u = this.stretch.age;
      return 1 + STRETCH * this.stretch.amount * Math.exp(-u / 0.09) * Math.cos((2 * Math.PI * u) / 0.22);
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
      const local = this.lookValue && this.shown && this.shown.facePoint ? this.shown.facePoint() : null;
      if (local) {
        return { ...this.onScreen(local), r: local.r || this.rig.bodyLength * 0.12 };
      }
      const head = this.at(this.rig.head);
      return { x: head.x, y: head.y, r: this.rig.bodyLength * 0.12 };
    }

    /** True if the picture shown has a hand marked (hero.json "hand") for webs to shoot from. */
    hasHand() {
      return Boolean(this.lookValue && this.shown && this.shown.handPoint && this.shown.handPoint());
    }

    /**
     * The hand new webs shoot from, in window units: the picture's hero.json "hand" when it has one,
     * otherwise where he is tied on.
     */
    handPoint() {
      const local = this.lookValue && this.shown && this.shown.handPoint ? this.shown.handPoint() : null;
      return local ? this.onScreen(local) : this.at(this.rig.ankle);
    }

    /** A point of the shown picture (from the tie-on point, turned as the picture is) in window units. */
    onScreen(local) {
      const ankle = this.at(this.rig.ankle);
      // Same turn as draw(): the picture hangs from its top edge, so 180 degrees less than the drawing.
      const turn = this.bodyAngle() - Math.PI + this.sway;
      const c = Math.cos(turn);
      const s = Math.sin(turn);
      return { x: ankle.x + local.x * c - local.y * s, y: ankle.y + local.x * s + local.y * c };
    }

    draw(ctx) {
      if (this.rig.particles.length === 0 || this.opacity <= 0) {
        return;
      }
      ctx.save();
      ctx.globalAlpha *= this.opacity;
      this.drawLetGo(ctx);
      // In the air he has no web: only the new one, if it is on its way up yet.
      const free = this.rig.free;
      const line = free ? this.aimLine() : this.sampleRope();
      if (line && !free && this.handover) {
        this.pullEndToHand(line);
      }
      // A picture held by a fist mid-body ("grip" in hero.json) has the web across the front of him,
      // as in the picture it came from; otherwise his body hides the web.
      const webInFront = Boolean(this.lookValue && this.shown && this.shown.gripped);
      if (line && !webInFront) {
        this.drawLine(ctx, line);
      }
      if (free && line && this.aim && this.aim.share < 1) {
        drawBlob(ctx, line[0].x, line[0].y, this.ropeWidth * 0.9); // the sticky end, still flying
      }
      if (!free) {
        this.drawTopFitting(ctx);
      }

      this.drawBody(ctx);
      if (this.lookValue && line) {
        const ankle = this.at(this.rig.ankle);
        ctx.save();
        ctx.translate(ankle.x, ankle.y);
        this.drawEndFitting(ctx);
        ctx.restore();
      }
      if (line && webInFront) {
        this.drawLine(ctx, line);
      }
      if (this.tether && this.tether.age < THWIP_SECONDS + THWIP_FADE) {
        const share = Math.min(1, this.tether.age / THWIP_SECONDS);
        ctx.save();
        ctx.globalAlpha *= 1 - smooth((this.tether.age - THWIP_SECONDS) / THWIP_FADE);
        this.drawLine(ctx, straightLine(this.handPoint(), this.tether.to, share, this.buffer('tether', 17)), this.ropeWidth * 0.7);
        ctx.restore();
      }
      ctx.restore();
    }

    /** Just him (his picture, or the drawing), without the web: what the hover test reads pixels of. */
    drawBody(ctx) {
      const theta = this.bodyAngle();
      const ankle = this.at(this.rig.ankle);
      ctx.save();
      ctx.translate(ankle.x, ankle.y);
      if (this.lookValue) {
        // A picture hangs from its top edge, so it needs 180 degrees less turn than the upright drawing.
        ctx.rotate(theta - Math.PI + this.sway);
        const { picture, scale } = this.pictureNow();
        const along = this.stretchNow();
        if (scale !== 1 || along !== 1) {
          ctx.scale(scale, scale * along);
        }
        if (picture) {
          picture.draw(ctx, 1);
        }
      } else if (this.drawFigure) {
        ctx.rotate(theta);
        const scale = this.rig.bodyLength / 100;
        ctx.scale(scale, scale);
        this.drawFigure(ctx, this.armOffset);
      }
      ctx.restore();
    }

    /** A window point in the shown picture's own units (before its tilt), the inverse of drawBody. */
    pictureLocal(pt) {
      const ankle = this.at(this.rig.ankle);
      const turn = -(this.bodyAngle() - Math.PI + this.sway);
      const { scale } = this.pictureNow();
      const dx = pt.x - ankle.x;
      const dy = pt.y - ankle.y;
      return {
        x: (dx * Math.cos(turn) - dy * Math.sin(turn)) / scale,
        y: (dx * Math.sin(turn) + dy * Math.cos(turn)) / (scale * this.stretchNow()),
      };
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
      // In the air the old web is not his any more: only he catches the mouse.
      if (!rig.free && Math.hypot(pt.x - rig.anchor.x, pt.y - rig.anchor.y * 0.6) < 18) {
        return true;
      }
      if (this.line !== 'none' && !rig.free) {
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
      if (this.opacity < 0.05) {
        return false; // not there yet, or gone
      }
      // Reading a pixel back is slow, so only do it when the pointer is inside the picture's box
      // (turned as it is drawn), or for anything else within reach of where he is tied on.
      const figure = this.lookValue ? this.pictureNow().picture : null;
      if (figure && figure.contains) {
        if (!figure.contains(this.pictureLocal(pt))) {
          return false;
        }
      } else {
        const reach = figure && figure.size ? Math.hypot(figure.size.x, figure.size.y) : rig.bodyLength * 1.6;
        if (Math.hypot(pt.x - rig.ankle.x, pt.y - rig.ankle.y) > reach + 4) {
          return false;
        }
      }
      return alphaAt ? alphaAt(pt.x, pt.y) > 0 : false;
    }

    // ---- The line ------------------------------------------------------------------------

    /**
     * A list of `n` points to fill and draw this frame, by name. The same list comes back every frame
     * (and its length is set to n), so nothing is allocated while he moves.
     */
    buffer(name, n) {
      let list = this.buffers.get(name);
      if (!list) {
        list = [];
        this.buffers.set(name, list);
      }
      while (list.length < n) {
        list.push({ x: 0, y: 0 });
      }
      list.length = n;
      return list;
    }

    /** Points along the rope, smoothed through its particles; a reused list (see buffer). */
    sampleRope() {
      const SAMPLES = 4;
      const particles = this.rig.particles;
      const count = this.rig.ropeCount;
      const points = this.buffer('rope', 2 + Math.max(0, count - 2) * SAMPLES);
      const back = 1 - this.blend;
      const ax = (p) => p.x - back * (p.x - p.px);
      const ay = (p) => p.y - back * (p.y - p.py);
      let n = 0;
      let fromX = ax(particles[0]);
      let fromY = ay(particles[0]);
      points[n].x = fromX;
      points[n++].y = fromY;
      for (let i = 1; i < count - 1; i++) {
        const cx = ax(particles[i]);
        const cy = ay(particles[i]);
        const toX = (cx + ax(particles[i + 1])) / 2;
        const toY = (cy + ay(particles[i + 1])) / 2;
        for (let k = 1; k <= SAMPLES; k++) {
          const t = k / SAMPLES;
          const u = 1 - t;
          points[n].x = u * u * fromX + 2 * u * t * cx + t * t * toX;
          points[n++].y = u * u * fromY + 2 * u * t * cy + t * t * toY;
        }
        fromX = toX;
        fromY = toY;
      }
      points[n].x = ax(this.rig.ankle);
      points[n++].y = ay(this.rig.ankle);
      points.length = n;
      return points;
    }

    drawLine(ctx, line, w = this.ropeWidth) {
      if (this.line === 'none') {
        return;
      }
      const normals = normalsOf(line, this.buffer('normals', line.length));
      const band = this.buffer('band', line.length);
      strokeLine(ctx, shift(line, 0.9, 1.2, band), 'rgba(0, 0, 0, 0.157)', w + 3.2);
      strokeLine(ctx, shift(line, 0.4, 0.6, band), 'rgba(0, 0, 0, 0.275)', w + 1.4);

      const bands = TONES.length;
      for (let i = 0; i < bands; i++) {
        const across = ((i - (bands - 1) / 2) / bands) * w;
        strokeLine(ctx, offset(line, normals, across, band), TONES[i], (w / bands) * 1.6);
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
      strokeLine(ctx, offset(line, normals, -w * 0.28, band), 'rgba(255, 255, 255, 0.784)', w * 0.18);
      drawFibres(ctx, line, normals, w);
    }

    // ---- Fittings at each end of the line ------------------------------------------------

    /** In the air: the new web on its way from his hand to the top of the screen, or null. */
    aimLine() {
      const aim = this.aim;
      if (!aim || aim.share <= 0) {
        return null;
      }
      // On its way the new web is slack and wavy; it pulls straight as it reaches the top.
      const line = straightLine(this.handPoint(), aim, aim.share, this.buffer('aim', 17));
      const tip = line[0];
      const end = line[16];
      const dx = tip.x - end.x;
      const dy = tip.y - end.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      const loose = 1 - aim.share * aim.share;
      for (let i = 1; i < 16; i++) {
        const t = i / 16;
        const off = (Math.sin(Math.PI * t) * len * 0.07 + Math.sin(t * Math.PI * 5 + aim.share * 9) * len * 0.012) * loose;
        line[i].x += nx * off;
        line[i].y += ny * off;
      }
      return line;
    }

    /**
     * Just after a new web catches: its end still starts at the hand that shot it and slides to where
     * he holds it (the tie-on point), the rest of the line following less the further up it is.
     */
    pullEndToHand(line) {
      const k = Math.min(1, this.handover.age / HANDOVER_SECONDS);
      const left = 1 - k * k * (3 - 2 * k);
      const hand = this.handPoint();
      const end = line[line.length - 1];
      const dx = (hand.x - end.x) * left;
      const dy = (hand.y - end.y) * left;
      for (let i = 1; i < line.length; i++) {
        const t = i / (line.length - 1);
        line[i].x += dx * t * t;
        line[i].y += dy * t * t;
      }
    }

    /** A web on its way from his hand toward `to`, `share` (0..1) of the way (the Big web reminder). */
    drawShot(ctx, to, share) {
      ctx.save();
      ctx.globalAlpha *= this.opacity;
      this.drawLine(ctx, straightLine(this.handPoint(), to, share, this.buffer('shot', 17)), this.ropeWidth * 0.8);
      ctx.restore();
    }

    /** The web he just let go of: left where it was, with its splat, fading out over LET_GO_SECONDS. */
    drawLetGo(ctx) {
      if (!this.letGo || this.line === 'none') {
        return;
      }
      const { age, line } = this.letGo;
      const t = Math.min(1, age / LET_GO_SECONDS);
      // Let go, the web goes slack: its loose end drops and swings in under the splat as it fades.
      const slack = this.buffer('letGo', line.length);
      const top = line[0];
      for (let i = 0; i < line.length; i++) {
        const s = i / (line.length - 1);
        slack[i].x = line[i].x + (top.x - line[i].x) * Math.min(1, age * 1.4) * 0.35 * s;
        slack[i].y = line[i].y + 0.5 * 1400 * age * age * Math.pow(s, 1.4);
      }
      ctx.save();
      ctx.globalAlpha *= (1 - t) * (1 - t);
      this.drawLine(ctx, slack);
      drawSplat(ctx, top.x, top.y, this.ropeWidth);
      ctx.restore();
    }

    drawTopFitting(ctx) {
      if (this.line === 'none') {
        return;
      }
      if (this.splatAge !== null) {
        // A new web has just stuck: its splat bursts open, overshooting a little.
        const g = Math.min(1, this.splatAge / SPLAT_SECONDS);
        const k = Math.max(0.05, 1 + 2.4 * (g - 1) ** 3 + 1.4 * (g - 1) ** 2);
        ctx.save();
        ctx.translate(this.rig.anchor.x, 0);
        ctx.scale(k, 1);
        drawSplat(ctx, 0, this.rig.anchor.y, this.ropeWidth);
        ctx.restore();
        return;
      }
      drawSplat(ctx, this.rig.anchor.x, this.rig.anchor.y, this.ropeWidth);
    }

    drawEndFitting(ctx) {
      if (this.line !== 'none') {
        drawBlob(ctx, 0, 0, this.ropeWidth * 1.1);
      }
    }
  }

  // ---- Small drawing helpers ---------------------------------------------------------------

  /**
   * A web shot from `from` toward `to`, `share` (0..1) of the way there: points from its tip back to
   * `from`, as along a rope, so it gets the same twist marks and fibres.
   */
  function straightLine(from, to, share, out) {
    const tipX = from.x + (to.x - from.x) * share;
    const tipY = from.y + (to.y - from.y) * share;
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      out[i].x = tipX + (from.x - tipX) * t;
      out[i].y = tipY + (from.y - tipY) * t;
    }
    return out;
  }

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

  function normalsOf(line, normals) {
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
      normals[i].x = -dy;
      normals[i].y = dx;
    }
    return normals;
  }

  function offset(line, normals, distance, out) {
    for (let i = 0; i < line.length; i++) {
      out[i].x = line[i].x + normals[i].x * distance;
      out[i].y = line[i].y + normals[i].y * distance;
    }
    return out;
  }

  function shift(line, dx, dy, out) {
    for (let i = 0; i < line.length; i++) {
      out[i].x = line[i].x + dx;
      out[i].y = line[i].y + dy;
    }
    return out;
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
   *   { kind: 'hero', name, line, poses: { pose: { bytes, file, grip, tilt, face, faceSize, hand } } }
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
            face: picture.face || null, faceSize: picture.faceSize || null, hand: picture.hand || null });
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
