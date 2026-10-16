/*
 * The rope and the body.
 *
 * The rope is a chain of Verlet particles (position-based: speed is position minus previous position).
 * The last rope particle is his ankle. A second particle, his head, is joined to it by a fixed-length
 * link, so he swings like a double pendulum. Coordinates are window units (DIPs), y down.
 */
(function (root) {
  'use strict';

  const STEP = 1 / 240;
  // Rounds of length-fixing per step. The light rope (see W_ROPE) needs many: with 24, a hard
  // fling stretched it 25% and he flew over the top. Cheap next to drawing a frame.
  const ITERATIONS = 64;
  const GRAVITY = 1800;
  const DAMPING = 0.9984;
  // When the body is slower than SETTLE_SPEED (units per second), friction gets much stronger.
  // Without it, the last few pixels of swing take close to a minute to die out, and the overlay
  // keeps drawing that whole time. With it he settles in about 2 seconds.
  const SETTLE_SPEED = 90;
  const SETTLE_DAMPING = 0.992;
  /** How far his reach (arms, a picture's edge) sticks out past his head, in body lengths. */
  const REACH_PAST_HEAD = 0.32;
  // "Swing on his own" works like pumping a playground swing: a push in the direction he is already
  // moving, sized by how far his last swing fell short of SWING_TARGET. A plain push every time
  // would make the swing grow until he hits the walls.
  const SWING_TARGET = 0.55; // radians from straight down, about 31 degrees
  const PUMP_STRENGTH = 900; // units per second squared, at full speed and full shortfall
  // Grip between rope and body. They barely matter in a normal swing, but calm him after a hard fling.
  const GRIP_DAMP_SHARE = 0.006;
  const GRIP_STIFFNESS = 0.04;
  // Top speed of any point, units per second. A swing reaches horizontal at about
  // sqrt(2 x gravity x length) = 1,250 for a medium Spidey, so 1,300 still allows a full swing.
  // Above that a hard fling sent him over the top, where the rope goes slack and snaps.
  const MAX_SPEED = 1300;
  const BREEZE_STRENGTH = 140;
  // Leaves room above the anchor for the web splat that sticks him to the top of the screen.
  const ANCHOR_Y = 10;
  // A light rope, as a real web line is next to the person on it. A heavy rope whipped and made the
  // swing hitch. Much lighter than 10 and the solver cannot hold the rope's length under his weight.
  const W_ROPE = 10;
  const W_ANKLE = 0.6;
  const W_HEAD = 0.4;
  // Swinging across the screen (travel.js): much lighter friction, so each swing from web to web
  // keeps its height instead of dying away like a normal hang.
  const TRAVEL_DAMPING = 0.9998;
  // The fastest swings across the screen (on big screens, with a long rope) go a little past
  // MAX_SPEED. Nothing flings him then, so there is no over-the-top to guard against.
  const TRAVEL_MAX_SPEED = 2000;
  // How fast a rope that is longer or shorter than wanted (after re-tying it) eases back, per step.
  // About a second and a half to close most of the gap: he lowers himself, rather than dropping.
  const ROPE_EASE = 0.006;

  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  function ieeeRemainder(a, b) {
    const q = a / b;
    let r = Math.round(q);
    if (Math.abs(q - Math.trunc(q)) === 0.5 && r % 2 !== 0) {
      r -= 1;
    }
    return a - b * r;
  }

  class Particle {
    constructor(x, y, w) {
      this.x = this.px = x;
      this.y = this.py = y;
      this.w = w;
    }
  }

  class Rig {
    constructor() {
      this.particles = [];
      this.links = []; // { a, b, length }
      this.anchor = new Particle(0, 0, 0);
      this.ankle = new Particle(0, 0, 0);
      this.head = new Particle(0, 0, 0);
      this.ropeCount = 0;
      this.bodyLength = 0;
      this.visibleLeft = 0;
      this.visibleRight = Number.MAX_VALUE;
      this.width = 0;
      this.height = 0;
      this.lastPeak = 0;
      this.lastDirection = 0;
      this.touching = false;
      this.random = Math.random;
      /** While swinging across the screen (travel.js): lighter friction, no settling, no side walls. */
      this.travelling = false;
      /** Let go of the web and flying (travel.js): only his body moves, the old rope stays where it was. */
      this.free = false;
      /** His body is turned by travel.js (placeBody) rather than by the physics. */
      this.steered = false;
      /** A sideways push set by travel.js, like the pump of "swing on his own" (units per second squared). */
      this.travelPush = 0;
      /** The rope length he eases back to after the rope was re-tied at another length. 0 = as built. */
      this.ropeTarget = 0;
      /** How fast the rope eases to ropeTarget, per step. Faster while he drops in or climbs out. */
      this.ropeEase = ROPE_EASE;
    }

    get ropeAngle() {
      return Math.atan2(this.ankle.x - this.anchor.x, this.ankle.y - this.anchor.y);
    }

    get bodyAngle() {
      return Math.atan2(this.head.x - this.ankle.x, this.head.y - this.ankle.y);
    }

    /** Rope length now over its proper length. 1 = not stretched. */
    get ropeStretch() {
      let actual = 0;
      let proper = 0;
      for (let i = 0; i < this.ropeCount - 1; i++) {
        const { a, b, length } = this.links[i];
        actual += Math.hypot(b.x - a.x, b.y - a.y);
        proper += length;
      }
      return proper > 0 ? actual / proper : 1;
    }

    get ropeLength() {
      return this.links.length > 1 ? (this.ropeCount - 1) * this.links[0].length : 0;
    }

    build(width, height, anchorX, ropeLength, bodyLength) {
      this.particles = [];
      this.links = [];
      this.width = width;
      this.height = height;
      this.bodyLength = bodyLength;
      this.lastPeak = 0;
      this.lastDirection = 0;
      this.travelling = false;
      this.free = false;
      this.steered = false;
      this.travelPush = 0;

      const segments = clamp(Math.round(ropeLength / 16), 8, 28);
      const segLength = ropeLength / segments;
      for (let i = 0; i <= segments; i++) {
        const w = i === 0 ? 0 : i === segments ? W_ANKLE : W_ROPE;
        this.particles.push(new Particle(anchorX, ANCHOR_Y + i * segLength, w));
      }
      this.anchor = this.particles[0];
      this.ankle = this.particles[segments];
      this.ropeCount = this.particles.length;
      this.head = new Particle(anchorX, this.ankle.y + bodyLength, W_HEAD);
      this.particles.push(this.head);

      for (let i = 0; i < segments; i++) {
        this.links.push({ a: this.particles[i], b: this.particles[i + 1], length: segLength });
      }
      this.links.push({ a: this.ankle, b: this.head, length: bodyLength });
      this.ropeTarget = ropeLength;
    }

    /**
     * Ties the rope to a new point (window units, at the top) as a web shot from his hand would:
     * the rope runs straight from there to his hand, as long as that distance, and he keeps his speed.
     * The rope then eases back to its usual length (ropeTarget).
     */
    reattach(anchorX) {
      const ankle = this.ankle;
      const head = this.head;
      const length = Math.max(1, Math.hypot(ankle.x - anchorX, ankle.y - ANCHOR_Y));
      const segments = clamp(Math.round(length / 16), 8, 28);
      const vx = ankle.x - ankle.px;
      const vy = ankle.y - ankle.py;
      this.particles = [];
      this.links = [];
      for (let i = 0; i < segments; i++) {
        const t = i / segments;
        const p = new Particle(anchorX + (ankle.x - anchorX) * t, ANCHOR_Y + (ankle.y - ANCHOR_Y) * t, i === 0 ? 0 : W_ROPE);
        // Each point of the rope moves in proportion to its distance from the new anchor, as a
        // straight rope turning round it would.
        p.px = p.x - vx * t;
        p.py = p.y - vy * t;
        this.particles.push(p);
      }
      this.particles.push(ankle, head);
      this.anchor = this.particles[0];
      this.ropeCount = segments + 1;
      for (let i = 0; i < segments; i++) {
        this.links.push({ a: this.particles[i], b: this.particles[i + 1], length: length / segments });
      }
      this.links.push({ a: ankle, b: head, length: this.bodyLength });
      this.lastPeak = 0;
      this.lastDirection = 0;
      this.free = false;
    }

    /**
     * Reels the rope in to `length`, everything hanging still and straight below the web, as he is
     * when he has just climbed up to it. Set ropeTarget after this and he lowers himself down.
     */
    reel(length) {
      const ropeLinks = this.ropeCount - 1;
      const seg = Math.max(0.5, length) / ropeLinks;
      const { x, y } = this.anchor;
      for (let i = 0; i < this.ropeCount; i++) {
        const p = this.particles[i];
        p.x = p.px = x;
        p.y = p.py = y + i * seg;
      }
      for (let i = 0; i < ropeLinks; i++) {
        this.links[i].length = seg;
      }
      this.head.x = this.head.px = x;
      this.head.y = this.head.py = this.ankle.y + this.bodyLength;
    }

    /** Lets go of the web. He flies free until reattach(); the rope stays still where it was. */
    release() {
      this.free = true;
      for (let i = 0; i < this.ropeCount - 1; i++) {
        const p = this.particles[i];
        p.px = p.x;
        p.py = p.y;
      }
    }

    /**
     * Sets his body's angle from his hand (as bodyAngle measures it) now and one step ago, so the
     * physics carries on from it with the right speed. Used while steered.
     */
    placeBody(angle, previous) {
      const { ankle, head, bodyLength } = this;
      head.x = ankle.x + Math.sin(angle) * bodyLength;
      head.y = ankle.y + Math.cos(angle) * bodyLength;
      head.px = ankle.px + Math.sin(previous) * bodyLength;
      head.py = ankle.py + Math.cos(previous) * bodyLength;
    }

    /** Moves everything, the anchor too, sideways without adding speed (the window moved). */
    shiftEverything(dx) {
      for (const p of this.particles) {
        p.x += dx;
        p.px += dx;
      }
    }

    /** A sideways shove. Strength 1 is a clear swing. direction: -1, 1, or 0 for random. */
    kick(strength, direction = 0) {
      const dir = direction !== 0 ? Math.sign(direction) : this.random() < 0.5 ? -1 : 1;
      for (let i = 1; i < this.particles.length; i++) {
        const along = i >= this.ropeCount ? 1 : i / (this.ropeCount - 1);
        this.particles[i].px -= dir * strength * 520 * along * STEP;
      }
    }

    static nudge(p, speedX) {
      p.px -= speedX * STEP;
    }

    /** Moves everything but the anchor sideways, without adding speed. */
    shiftAll(dx) {
      for (let i = 1; i < this.particles.length; i++) {
        this.particles[i].x += dx;
        this.particles[i].px += dx;
      }
    }

    moveAnchor(x) {
      this.anchor.x = this.anchor.px = x;
    }

    simulate(time, breeze, autoSwing, dragged, target) {
      const wind = breeze ? BREEZE_STRENGTH * (0.6 * Math.sin(time * 0.8) + 0.4 * Math.sin(time * 1.9 + 1.3)) : 0;
      const pump = this.travelling ? this.travelPush : autoSwing && !dragged ? this.pumpAcceleration() : 0;
      const maxMove = (this.travelling ? TRAVEL_MAX_SPEED : MAX_SPEED) * STEP;
      const bodySpeed = Math.max(stepDistance(this.ankle), stepDistance(this.head)) / STEP;
      // No settling friction while he swings on his own: it would brake him at every turn.
      // None at all in flight: a plain throw, so travel.js can tell exactly where he will be.
      const damping = this.free ? 1 : this.travelling ? TRAVEL_DAMPING
        : !dragged && !autoSwing && bodySpeed < SETTLE_SPEED ? SETTLE_DAMPING : DAMPING;
      this.easeRope();

      const particles = this.particles;
      const firstMoving = this.free ? this.ropeCount - 1 : 0;
      for (let i = firstMoving; i < particles.length; i++) {
        const p = particles[i];
        if (p.w === 0 || (this.steered && p === this.head)) {
          continue;
        }
        // The pump turns the whole thing as one long pendulum: each point gets a push in proportion
        // to its distance from the anchor. Pushing only his body would spin him round his grip.
        const push = pump * this.distanceShare(i);
        let vx = (p.x - p.px) * damping;
        let vy = (p.y - p.py) * damping;
        const speed = Math.sqrt(vx * vx + vy * vy);
        if (speed > maxMove) {
          vx *= maxMove / speed;
          vy *= maxMove / speed;
        }
        p.px = p.x;
        p.py = p.y;
        p.x += vx + (wind + push) * STEP * STEP;
        p.y += vy + GRAVITY * STEP * STEP;
      }

      // The grip only makes sense when he is roughly in line with the rope. Leave it off against a
      // wall or the top (the rope can fold back past his hand) and when he is tangled.
      if (!this.steered && !this.free && !this.touching && this.bodyOffRopeEnd() < 1.0) {
        this.dampGrip();
        this.straightenGrip();
      }

      if (dragged) {
        dragged.x += (target.x - dragged.x) * 0.3;
        dragged.y += (target.y - dragged.y) * 0.3;
      }

      // In flight the rope links are left out, and the body link while travel.js turns his body.
      const links = this.links;
      const firstLink = this.free ? links.length - 1 : 0;
      const endLink = this.steered ? links.length - 1 : links.length;
      for (let n = 0; n < ITERATIONS; n++) {
        for (let i = firstLink; i < endLink; i++) {
          solve(links[i]);
        }
      }
      this.contain();
    }

    /** Brings a re-tied rope a little nearer its usual length (ropeTarget). */
    easeRope() {
      const ropeLinks = this.ropeCount - 1;
      if (!this.ropeTarget || ropeLinks < 1 || this.free) {
        return;
      }
      const now = this.links[0].length * ropeLinks;
      if (Math.abs(now - this.ropeTarget) < 0.05) {
        return;
      }
      const next = (now + (this.ropeTarget - now) * this.ropeEase) / ropeLinks;
      for (let i = 0; i < ropeLinks; i++) {
        this.links[i].length = next;
      }
    }

    distanceShare(i) {
      const rope = Math.max(1, (this.ropeCount - 1) * this.links[0].length);
      return i < this.ropeCount ? i / (this.ropeCount - 1) : 1 + this.bodyLength / rope;
    }

    dampGrip() {
      const ropeEnd = this.particles[this.ropeCount - 2];
      const extra = turnSpeed(this.ankle, this.head) - turnSpeed(ropeEnd, this.ankle);
      // Turning at speed w moves the head at w * (-sy, sx). Remove a share of the extra part.
      // Verlet: raising the previous position lowers the speed.
      const sx = this.head.x - this.ankle.x;
      const sy = this.head.y - this.ankle.y;
      this.head.px += GRIP_DAMP_SHARE * extra * -sy;
      this.head.py += GRIP_DAMP_SHARE * extra * sx;
    }

    straightenGrip() {
      const ropeEnd = this.particles[this.ropeCount - 2];
      const rx = this.ankle.x - ropeEnd.x;
      const ry = this.ankle.y - ropeEnd.y;
      const length = Math.sqrt(rx * rx + ry * ry);
      if (length < 1e-6) {
        return;
      }
      const targetX = this.ankle.x + (rx / length) * this.bodyLength;
      const targetY = this.ankle.y + (ry / length) * this.bodyLength;
      const dx = (targetX - this.head.x) * GRIP_STIFFNESS;
      const dy = (targetY - this.head.y) * GRIP_STIFFNESS;
      // Move the previous position too, so this shifts him without adding speed. Moving only the
      // position is a push, which fed energy into tangles and kept him spinning after a hard fling.
      this.head.x += dx;
      this.head.y += dy;
      this.head.px += dx;
      this.head.py += dy;
    }

    bodyOffRopeEnd() {
      const ropeEnd = this.particles[this.ropeCount - 2];
      const a1 = Math.atan2(this.ankle.x - ropeEnd.x, this.ankle.y - ropeEnd.y);
      const a2 = Math.atan2(this.head.x - this.ankle.x, this.head.y - this.ankle.y);
      return Math.abs(ieeeRemainder(a2 - a1, 2 * Math.PI));
    }

    pumpAcceleration() {
      const vx = this.ankle.x - this.ankle.px;
      const direction = Math.abs(vx) < 1e-4 ? 0 : Math.sign(vx);
      if (direction !== 0 && direction !== this.lastDirection) {
        // He has just turned round, so the rope angle now is how far that half-swing went.
        this.lastPeak = Math.abs(this.ropeAngle);
        this.lastDirection = direction;
      }
      const target = this.swingRoom();
      if (this.touching || target < 0.09) {
        return 0; // about 5 degrees: no room to swing
      }
      // Smooth, not on/off: switching a fixed push on and off made the swing hitch at the bottom.
      //   shortfall: 1 = not swinging yet, 0 = on target, below 0 = too big, so it brakes gently.
      //   speed: strongest at the bottom of the swing, fading to nothing at the turning points.
      // Also counts how high he is right now, or the first few swings overshoot.
      const reached = Math.max(this.lastPeak, Math.abs(this.ropeAngle));
      const shortfall = clamp((target - reached) / target, -1, 1);
      const speed = clamp(vx / STEP / 250, -1, 1);
      return PUMP_STRENGTH * shortfall * speed;
    }

    /** The biggest swing (radians) that keeps him on screen from where the web is tied. */
    swingRoom() {
      return Math.min(
        SWING_TARGET,
        this.swingRoomAt(Math.min(this.anchor.x - Math.max(0, this.visibleLeft), Math.min(this.width, this.visibleRight) - this.anchor.x))
      );
    }

    swingRoomAt(distance) {
      const rope = Math.max(1, (this.ropeCount - 1) * this.links[0].length);
      // His body sticks out sideways from the rope end, and leans a little further out than the rope.
      const clear = distance - this.bodyLength * 0.42;
      const reach = rope + this.bodyLength * 0.5;
      return Math.asin(clamp(clear / reach, 0, 1)) * 0.8;
    }

    /** How far the web must be from a screen edge for a full "swing on his own". */
    static distanceForFullSwing(ropeLength, bodyLength) {
      return bodyLength * 0.42 + (ropeLength + bodyLength * 0.5) * Math.sin(SWING_TARGET / 0.8);
    }

    /**
     * Moves a web position in from the screen edges, far enough for a full "swing on his own".
     * Too close to an edge, the swing has to be tiny or he swings off the screen.
     * If the screen is too narrow for that, the web goes to the middle. work: { x, width }.
     */
    static roomToSwing(anchorX, ropeLength, bodyLength, work) {
      const needed = Rig.distanceForFullSwing(ropeLength, bodyLength);
      if (work.width < needed * 2) {
        return work.x + work.width / 2;
      }
      return clamp(anchorX, work.x + needed, work.x + work.width - needed);
    }

    /** The largest distance any point moved in the last step. */
    motion() {
      let max = 0;
      for (const p of this.particles) {
        max = Math.max(max, stepDistance(p));
      }
      return max;
    }

    /** Stops all motion. */
    freeze() {
      for (const p of this.particles) {
        p.px = p.x;
        p.py = p.y;
      }
    }

    nearAnchor(pt) {
      return !this.free && Math.abs(pt.x - this.anchor.x) < 16 && pt.y < this.anchor.y + 18;
    }

    /** His body: the ankle or head end, whichever is nearer the point. Null if the point is not on him. */
    pickBody(pt) {
      const sx = this.head.x - this.ankle.x;
      const sy = this.head.y - this.ankle.y;
      const lsq = Math.max(1, sx * sx + sy * sy);
      const t = clamp(((pt.x - this.ankle.x) * sx + (pt.y - this.ankle.y) * sy) / lsq, 0, 1);
      const nearX = this.ankle.x + sx * t;
      const nearY = this.ankle.y + sy * t;
      if (Math.hypot(pt.x - nearX, pt.y - nearY) < this.bodyLength * 0.3) {
        return t > 0.5 ? this.head : this.ankle;
      }
      return null;
    }

    /** What the user grabbed: an end of the body, or a point on the rope. Null if nothing. */
    pick(pt) {
      const body = this.pickBody(pt);
      if (body || this.free) {
        return body;
      }
      let best = null;
      let bestDist = 18;
      for (let i = 1; i < this.ropeCount - 1; i++) {
        const p = this.particles[i];
        const d = Math.hypot(pt.x - p.x, pt.y - p.y);
        if (d < bestDist) {
          best = p;
          bestDist = d;
        }
      }
      return best;
    }

    contain() {
      // Same side margin for rope and body. With a smaller margin for the rope, the rope could slide
      // past his hand at a wall and fold back, and the grip then flipped him over the top.
      const side = this.bodyLength * 0.42;
      this.touching = false;
      for (let i = this.free ? this.ropeCount - 1 : 1; i < this.particles.length; i++) {
        const p = this.particles[i];
        if (this.steered && p === this.head) {
          continue;
        }
        const bodyPart = i >= this.ropeCount - 1;
        const floor = this.height - (bodyPart ? this.bodyLength * REACH_PAST_HEAD : 4);
        // The sides soak up sideways speed, like a padded wall. Do NOT make them bounce: pressed
        // against a wall, the rope keeps pulling his body back into it every step, and a bounce
        // turned each pull into fresh speed until he was flung over the top.
        // No walls while he swings across the screen: the window follows him instead.
        const walls = !this.travelling;
        if (walls && p.x < side) {
          p.x = p.px = side;
          this.touching = true;
        } else if (walls && p.x > this.width - side) {
          p.x = p.px = this.width - side;
          this.touching = true;
        }
        if (p.y > floor) {
          p.y = p.py = floor;
        } else if (p.y < 1) {
          p.y = p.py = 1;
          this.touching = true;
        }
      }
    }
  }

  function stepDistance(p) {
    return Math.abs(p.x - p.px) + Math.abs(p.y - p.py);
  }

  function turnSpeed(a, b) {
    const sx = b.x - a.x;
    const sy = b.y - a.y;
    const lsq = sx * sx + sy * sy;
    if (lsq < 1e-9) {
      return 0;
    }
    const vx = b.x - b.px - (a.x - a.px);
    const vy = b.y - b.py - (a.y - a.py);
    return (sx * vy - sy * vx) / lsq;
  }

  function solve(link) {
    const a = link.a;
    const b = link.b;
    const wsum = a.w + b.w;
    if (wsum === 0) {
      return;
    }
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.max(1e-6, Math.sqrt(dx * dx + dy * dy));
    const diff = (d - link.length) / d;
    const ka = (a.w / wsum) * diff;
    const kb = (b.w / wsum) * diff;
    a.x += dx * ka;
    a.y += dy * ka;
    b.x -= dx * kb;
    b.y -= dy * kb;
  }

  const api = { Rig, Particle, STEP, REACH_PAST_HEAD, SWING_TARGET, ANCHOR_Y, GRAVITY, ROPE_EASE };
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    (root.SH || (root.SH = {})).rig = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
