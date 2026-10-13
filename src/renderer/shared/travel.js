/*
 * Swinging across the screen, web to web, as Spider-Man does between buildings.
 *
 * Each hop:
 *   1. Swing: he swings through under his web, pumped (like a playground swing) to just the speed
 *      this hop needs. The first swing starts with a lean back to wind up.
 *   2. Let go: on the way up, at the moment a throw from there would carry him to the next web.
 *   3. Fly: no web, a plain throw. Just before the catch, the next web shoots from his hand.
 *   4. Catch: on the way down, the new web is square to his path, so it takes his weight without
 *      changing his speed and the swing carries straight on. Nothing ever stops or jerks him.
 * The last web is tied at the far spot; he swings to a stop under it and hangs as usual.
 *
 * His body is turned by this code all the way (rig.steered): in the air, smoothly round from the
 * web he let go of to the one he will catch; on a web, into line with it.
 *
 * Plain JavaScript, no Electron, so the unit tests run it. Positions along the screen (targetX, the
 * webs) are screen units; the rig works in window units, so step() is told where the window's left
 * edge is. Nothing here moves the window: hang-view.js does that.
 */
(function (root) {
  'use strict';

  const node = typeof module === 'object' && module.exports;
  const RIG = node ? require('./rig.js') : root.SH.rig;
  const { STEP, ANCHOR_Y, GRAVITY } = RIG;

  /**
   * One hop, web to web, in rope lengths. The trip is split into equal hops of about HOP, never
   * longer than HOP_MAX: a longer hop needs a swing so big he would go over the top before letting go.
   */
  const HOP = 1.9;
  const HOP_MAX = 2.2;
  /** He is never pumped higher than this (radians from straight down), well clear of the top of the screen. */
  const SWING_MAX = 1.3;
  /** A web is caught when it would be his usual length, and never one longer than this share of that. */
  const LONGEST_WEB = 1.2;
  /** He never lets go slower than this share of sqrt(gravity x rope length): that would be a drop, not a throw. */
  const SLOWEST_RELEASE = 0.45;
  /** The last web, caught within this share of a rope length of the far spot, is tied at the spot itself. */
  const SNAP = 0.15;
  /**
   * He lets go between these angles past straight down (radians), on the way up, aiming for
   * RELEASE_PLAN. Letting go later throws him further, so the room above RELEASE_PLAN makes up for
   * a swing that came out a little slow.
   */
  const RELEASE_LOW = 0.3;
  const RELEASE_PLAN = 0.6;
  const RELEASE_HIGH = 0.95;
  /** Each swing is pumped for a throw this much further than the hop needs. */
  const SPARE = 1.15;
  /** The shortest flight between webs, in rope lengths: a short hop lets go lower and faster instead. */
  const MIN_FLIGHT = 0.35;
  /** The push that pumps (or brakes) his swing, at his hand: at most, and how hard it chases the energy wanted. */
  const PUSH_MAX = 1500;
  const PUSH_GAIN = 8;
  /** Share of the gap to the push wanted closed each step: it builds over about 0.1 s, never all at once. */
  const PUSH_EASE = 0.04;
  /**
   * Setting off: from still, a lean back (pushed WINDUP_PUSH for WINDUP_SECONDS) to get going. On
   * the first swing he is pushed back at most WINDUP_PUSH and only to WINDUP_ANGLE radians, a
   * wind-up, and forward up to LAUNCH_PUSH, enough to let go on that swing.
   */
  const WINDUP_PUSH = 900;
  const WINDUP_SECONDS = 0.25;
  const WINDUP_ANGLE = 0.35;
  const LAUNCH_PUSH = 2600;
  /** Pumping later swings, he is pushed back too, but only near the bottom: within this angle (radians). */
  const BACK_PUMP_ANGLE = 0.1;
  /** After each catch his body swings into line with the web over this long. */
  const ALIGN_SECONDS = 0.4;
  /** As the web catches him, his body hangs this share of the way from the web's line to straight down. */
  const CATCH_HANG = 0.5;
  /** A flight shorter than this leaves no time to turn all the way in the air: the rest is done after the catch. */
  const TURN_SECONDS = 0.3;
  /** The new web takes this long to fly from his hand to the top of the screen. */
  const SHOT_SECONDS = 0.12;
  /** On the last web he is slowed to a swing this big (radians), then hangs as usual. */
  const LAND_ANGLE = 0.2;
  /** Gives up on a flight this long, and on the whole trip. */
  const MAX_FLIGHT = 2;
  const MAX_TRIP = 12;

  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  /** a minus b, as an angle between -pi and pi. */
  const turn = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
  /** The angle from straight down (as rig.ropeAngle measures it) of the line from (ax, ay) to (bx, by). */
  const angleOf = (ax, ay, bx, by) => Math.atan2(bx - ax, by - ay);

  /** Smooth curve from a (slope ma) at s = 0 to b (slope mb) at s = 1. Slopes are per unit of s. */
  function hermite(a, ma, b, mb, s) {
    const s2 = s * s;
    const s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * a + (s3 - 2 * s2 + s) * ma + (3 * s2 - 2 * s3) * b + (s3 - s2) * mb;
  }

  /** His body's angle from his hand, now and one step ago. */
  function bodyAngles(rig) {
    const { ankle, head } = rig;
    return { now: angleOf(ankle.x, ankle.y, head.x, head.y), before: angleOf(ankle.px, ankle.py, head.px, head.py) };
  }

  /**
   * Where a web from the top of the screen, square to his path and ahead of him, would be tied (x,
   * window units), if it would be between `length` and `longest` long; else null. Such a web takes
   * his weight without changing his speed. Speeds are per step.
   */
  function squareWeb(x, y, vx, vy, dir, length, longest) {
    const depth = y - ANCHOR_Y;
    if (vy <= 0 || vx * dir <= 0 || depth <= 0) {
      return null; // still rising: a web square to his path would be behind him
    }
    // Falling nearly straight down, the square web would be far off to the side and absurdly long.
    const ahead = (vy * depth) / vx;
    const web = Math.hypot(ahead, depth);
    return web >= length && web <= longest ? x + ahead : null;
  }

  /**
   * Follows a throw from (x, y), moving (vx, vy) per step, exactly as the rig moves him in the air,
   * until test(x, y, vx, vy) gives a catch. Returns { steps, x, y, vx, vy, anchorX, last } or null.
   */
  function flightTo(x, y, vx, vy, test) {
    const fall = GRAVITY * STEP * STEP;
    const most = Math.round(MAX_FLIGHT / STEP);
    for (let steps = 1; steps <= most; steps++) {
      vy += fall;
      x += vx;
      y += vy;
      const caught = test(x, y, vx, vy);
      if (caught) {
        return { steps, x, y, vx, vy, ...caught };
      }
    }
    return null;
  }

  class Travel {
    /**
     * rig: the Rig. dir: -1 (left) or 1 (right). targetX: where the last web goes (screen units).
     * ropeLength: his usual rope length.
     */
    constructor(rig, dir, targetX, ropeLength) {
      this.rig = rig;
      this.dir = Math.sign(dir) || 1;
      this.targetX = targetX;
      this.ropeLength = ropeLength;
      /** 'swing' (on a web, heading for the next), 'fly' (between webs) or 'land' (on the last web). */
      this.phase = 'swing';
      this.hops = 0;
      this.steps = 0;
      this.time = 0;
      this.anchorX = 0;
      this.nextX = 0;
      this.hopsLeft = 0;
      this.energy = 0;
      this.align = null;
      this.flight = null;
      this.windUp = false;
      /** Setting off from still: pushed forward from the lean back on, until his first swing tops out. */
      this.launching = false;
      /** Full forward swings on this web (through the bottom and up) that ended without letting go. */
      this.misses = 0;
      this.goingOn = false;
      this.through = false;
      this.lastReach = null;
      this.done = false;
    }

    /** Starts from wherever he is now, swinging or still. left: the window's left edge (screen units). */
    begin(left) {
      const rig = this.rig;
      rig.travelling = true;
      rig.steered = true;
      // Already swinging (say from a click), he goes from there; from still, he winds up first.
      this.windUp = rig.motion() < 0.5;
      this.launching = this.windUp;
      this.anchorX = left + rig.anchor.x;
      this.plan();
      this.startAlign();
    }

    /** Ends it where he is: he hangs from the web he has (a new one straight up if in the air) and settles as usual. */
    stop() {
      const rig = this.rig;
      if (rig.free) {
        rig.reattach(rig.ankle.x);
      }
      rig.travelling = false;
      rig.steered = false;
      rig.travelPush = 0;
      this.flight = null;
      this.done = true;
    }

    /**
     * Call after each physics step, with the window's left edge (screen units). Returns null, or what
     * just happened: { type: 'release' } when he lets go, { type: 'catch', anchorX, last } when a new
     * web catches him (anchorX in screen units).
     */
    step(left) {
      if (this.done) {
        return null;
      }
      this.time += STEP;
      this.steps++;
      if (this.time > MAX_TRIP) {
        this.stop();
        return null;
      }
      if (this.phase === 'fly') {
        return this.fly(left);
      }
      this.steerOnWeb();
      return this.phase === 'land' ? this.land() : this.swing(left);
    }

    /** While he flies: the new web on its way up, { x, y, share } (window units, share 0..1 of the way), or null. */
    aim(left) {
      const f = this.flight;
      if (!f) {
        return null;
      }
      const share = 1 - ((f.steps - this.steps) * STEP) / SHOT_SECONDS;
      return share > 0 ? { x: f.anchorX - left, y: ANCHOR_Y, share: Math.min(1, share) } : null;
    }

    // ---- The phases ----------------------------------------------------------------------------

    swing(left) {
      const rig = this.rig;
      const ankle = rig.ankle;
      this.pump(this.energy, true);
      const vx = ankle.x - ankle.px;
      const vy = ankle.y - ankle.py;
      const forward = rig.ropeAngle * this.dir;
      const goingOn = vx * this.dir > 0;
      if (goingOn && forward < 0) {
        this.through = true; // swinging forward through the bottom: this swing is a real try
      }
      if (this.goingOn && !goingOn) {
        this.launching = false;
        if (this.through && forward > RELEASE_LOW) {
          this.misses++;
        }
        this.through = false;
      }
      this.goingOn = goingOn;
      const speed = Math.hypot(vx, vy) / STEP;
      if (!goingOn || vy >= 0 || forward < RELEASE_LOW || speed < SLOWEST_RELEASE * Math.sqrt(GRAVITY * this.ropeLength)) {
        this.lastReach = null;
        return null;
      }
      // Let go once a throw from here would reach the next web on a rope of the usual length.
      const flight = flightTo(ankle.x, ankle.y, vx, vy, (x, y, fx, fy) => this.catchAt(x, y, fx, fy, left, false));
      const reach = flight ? (left + flight.anchorX) * this.dir : null;
      // Past the moment that would throw him furthest: letting go later only falls shorter.
      const fading = reach !== null && this.lastReach !== null && reach < this.lastReach;
      this.lastReach = reach;
      if (!flight) {
        return null;
      }
      // Well short of the next web: he does not let go, but swings back and comes round again
      // with more speed, as on a playground swing. Short on the last hop at all would mean one
      // more tiny hop at the end, so that waits too, but only once: after that he goes anyway,
      // as far as he can, and makes up the rest with another hop rather than keep trying.
      const last = this.hopsLeft === 1;
      const short = this.nextX * this.dir - reach;
      const allowed = this.misses > 0 ? Infinity : (last ? 0.02 : 0.12) * Math.abs(this.nextX - this.anchorX);
      if (short > 0 && ((forward < RELEASE_HIGH && !fading) || short > allowed)) {
        return null;
      }
      const planned = last ? flightTo(ankle.x, ankle.y, vx, vy, (x, y, fx, fy) => this.catchAt(x, y, fx, fy, left, true)) : flight;
      return this.letGo(planned || flight, left, last);
    }

    letGo(flight, left, last) {
      const rig = this.rig;
      rig.release();
      rig.travelPush = 0;
      // His body turns from where it is to where it should be as the web catches him, at the speeds
      // it has at each end, so it never jumps or suddenly spins.
      const body = bodyAngles(rig);
      const from = { angle: body.now, rate: turn(body.now, body.before) };
      const rope = angleOf(flight.anchorX, ANCHOR_Y, flight.x, flight.y);
      const ropeRate = turn(rope, angleOf(flight.anchorX, ANCHOR_Y, flight.x - flight.vx, flight.y - flight.vy));
      const hang = rope * (1 - CATCH_HANG);
      // In a short flight he only turns part of the way (the rest after the catch), so he never whips round.
      const time = clamp((flight.steps * STEP) / TURN_SECONDS, 0, 1);
      const share = time * time * (3 - 2 * time);
      this.flight = {
        steps: flight.steps,
        anchorX: left + flight.anchorX,
        last,
        from,
        to: {
          angle: from.angle + share * turn(hang, from.angle) + (1 - share) * from.rate * flight.steps,
          rate: share * ropeRate + (1 - share) * from.rate,
        },
      };
      this.phase = 'fly';
      this.steps = 0;
      return { type: 'release' };
    }

    fly(left) {
      const rig = this.rig;
      const ankle = rig.ankle;
      this.steerInFlight();
      const vx = ankle.x - ankle.px;
      const vy = ankle.y - ankle.py;
      let caught = this.catchAt(ankle.x, ankle.y, vx, vy, left, this.flight.last);
      if (!caught) {
        if (this.steps * STEP < MAX_FLIGHT) {
          return null;
        }
        caught = { anchorX: ankle.x, last: false }; // far too long in the air: a web straight up
      }
      rig.reattach(caught.anchorX);
      this.hops++;
      this.anchorX = left + caught.anchorX;
      this.flight = null;
      this.misses = 0;
      this.goingOn = false;
      this.through = false;
      this.lastReach = null;
      this.startAlign();
      if (caught.last) {
        this.phase = 'land';
      } else {
        this.phase = 'swing';
        this.plan();
      }
      return { type: 'catch', anchorX: this.anchorX, last: caught.last };
    }

    land() {
      const wanted = this.energyAt(LAND_ANGLE, 0);
      const energy = this.pump(wanted, false);
      if (energy <= wanted && this.steps >= this.align.steps) {
        this.stop();
      }
      return null;
    }

    // ---- Helpers -------------------------------------------------------------------------------

    /**
     * Where the next web should go if he is caught right now (window units), or null if not yet.
     * Normally a web square to his path, of his usual length. On the last hop, the far spot itself
     * as soon as a square web from there would do (a little shorter is fine: he lowers himself after).
     */
    catchAt(x, y, vx, vy, left, last) {
      const longest = this.ropeLength * LONGEST_WEB;
      if (last) {
        const reach = squareWeb(x, y, vx, vy, this.dir, this.ropeLength / 2, longest);
        if (reach !== null && (left + reach - this.targetX) * this.dir >= 0) {
          return { anchorX: this.targetX - left, last: true };
        }
      }
      const anchorX = squareWeb(x, y, vx, vy, this.dir, this.ropeLength, longest);
      if (anchorX === null) {
        return null;
      }
      // Just short of the far spot: tie it there rather than make one more tiny hop. The web is a
      // little off square to his path, which he barely feels.
      if (last && Math.abs(left + anchorX - this.targetX) <= SNAP * this.ropeLength) {
        return { anchorX: this.targetX - left, last: true };
      }
      return { anchorX, last: false };
    }

    /**
     * Splits what is left of the trip into equal hops and works out how much energy (speed and
     * height together) his swing needs for the next one.
     */
    plan() {
      const length = this.rig.ropeLength;
      const distance = Math.max(0, (this.targetX - this.anchorX) * this.dir);
      this.hopsLeft = Math.max(1, Math.round(distance / (HOP * length)), Math.ceil(distance / (HOP_MAX * length)));
      const hop = distance / this.hopsLeft;
      this.nextX = this.anchorX + this.dir * hop;
      // Swinging up to angle a, then a throw over distance r, makes a hop of 2 length sin(a) + r.
      const a = clamp(Math.asin(clamp((hop - MIN_FLIGHT * length) / (2 * length), 0, 1)), RELEASE_LOW, RELEASE_PLAN);
      const r = Math.max(MIN_FLIGHT * length, hop - 2 * length * Math.sin(a));
      // Aimed a little past the next web: a swing that comes out short has to go round again, while
      // one with energy to spare just lets go a little lower.
      this.energy = this.energyAt(a, Math.sqrt((GRAVITY * r * SPARE) / Math.sin(2 * a)));
    }

    /**
     * The energy of his swing: speed and height together, summed over his hand and the points of the
     * web, each by its weight. The web is light but not weightless, so his hand alone gains and loses
     * energy to it through each swing.
     */
    energyNow() {
      const rig = this.rig;
      let sum = 0;
      for (let i = 1; i < rig.ropeCount; i++) {
        const p = rig.particles[i];
        const vx = (p.x - p.px) / STEP;
        const vy = (p.y - p.py) / STEP;
        sum += ((vx * vx + vy * vy) / 2 - GRAVITY * (p.y - ANCHOR_Y)) / p.w;
      }
      return sum;
    }

    /** The same, for the web swinging straight and stiff at this angle with his hand at this speed. */
    energyAt(angle, speed) {
      const rig = this.rig;
      const n = rig.ropeCount - 1;
      let sum = 0;
      for (let i = 1; i <= n; i++) {
        const share = i / n;
        sum += ((speed * share) ** 2 / 2 - GRAVITY * rig.ropeLength * share * Math.cos(angle)) / rig.particles[i].w;
      }
      return sum;
    }

    /** The weight that energyNow sums over. */
    weight() {
      const rig = this.rig;
      let sum = 0;
      for (let i = 1; i < rig.ropeCount; i++) {
        sum += 1 / rig.particles[i].w;
      }
      return sum;
    }

    /**
     * Pushes his swing up to an energy (see energyNow), as pumping a playground swing does, or
     * (landing) brakes it down to one. With speedUp false it only brakes. On the way across, a swing
     * with more energy than needed is not braked, only one above SWING_MAX: he just lets go lower.
     * Braking it back down overshot, and the hop then fell short. Returns the energy now.
     */
    pump(wanted, speedUp) {
      const rig = this.rig;
      const vx = rig.ankle.x - rig.ankle.px;
      const energy = this.energyNow();
      // Never more than a swing up to SWING_MAX: that would carry him up to the top of the screen.
      const ceiling = this.energyAt(SWING_MAX, 0);
      const least = Math.min(wanted, ceiling);
      const most = speedUp ? ceiling : least;
      // Nor any pushing on beyond the highest point he lets go at.
      const pushing = speedUp && energy < least && rig.ropeAngle * Math.sign(vx) < RELEASE_HIGH;
      const scale = PUSH_GAIN / (this.weight() * this.ropeLength);
      const moving = Math.sign(vx);
      const first = this.hops === 0;
      let push = 0;
      if (this.windUp && this.time < WINDUP_SECONDS) {
        push = -this.dir * WINDUP_PUSH;
      } else if (pushing && this.launching) {
        // From the lean back straight into a push forward, even while still going back: a quick
        // start. Only until this first swing tops out (see below for why not after).
        push = this.dir * Math.min(LAUNCH_PUSH, scale * (least - energy));
      } else if (pushing && moving !== 0) {
        // As on a playground swing, always pushed the way he is going, so every push adds to the
        // swing. Do NOT push one way regardless: a steady push only tilts where he hangs, and he
        // hovered there tilted, barely moving, for seconds.
        if (moving === this.dir) {
          push = moving * Math.min(first ? LAUNCH_PUSH : PUSH_MAX, scale * (least - energy));
        } else if (rig.ropeAngle * this.dir > -(first ? WINDUP_ANGLE : BACK_PUMP_ANGLE)) {
          push = moving * Math.min(first ? WINDUP_PUSH : PUSH_MAX, scale * (least - energy));
        }
      } else if (energy > most && Math.abs(vx) > STEP) {
        push = -moving * Math.min(PUSH_MAX, scale * (energy - most));
      }
      rig.travelPush += (push - rig.travelPush) * PUSH_EASE;
      return energy;
    }

    /** From now, his body comes into line with his web over ALIGN_SECONDS, from the angle and spin it has. */
    startAlign() {
      const rope = this.ropeAngles();
      const body = bodyAngles(this.rig);
      this.align = {
        offset: turn(body.now, rope.now),
        rate: turn(body.now, body.before) - turn(rope.now, rope.before),
        steps: Math.round(ALIGN_SECONDS / STEP),
      };
      this.steps = 0;
    }

    ropeAngles() {
      const { anchor, ankle } = this.rig;
      return { now: angleOf(anchor.x, anchor.y, ankle.x, ankle.y), before: angleOf(anchor.x, anchor.y, ankle.px, ankle.py) };
    }

    /** How far his body is turned from the line of the web, `steps` steps after startAlign. */
    offsetAt(steps) {
      const a = this.align;
      return steps >= a.steps ? 0 : hermite(a.offset, a.rate * a.steps, 0, 0, Math.max(0, steps) / a.steps);
    }

    steerOnWeb() {
      const rope = this.ropeAngles();
      this.rig.placeBody(rope.now + this.offsetAt(this.steps), rope.before + this.offsetAt(this.steps - 1));
    }

    steerInFlight() {
      const f = this.flight;
      const angle = (k) => (k <= f.steps
        ? hermite(f.from.angle, f.from.rate * f.steps, f.to.angle, f.to.rate * f.steps, Math.max(0, k) / f.steps)
        : f.to.angle + f.to.rate * (k - f.steps));
      this.rig.placeBody(angle(this.steps), angle(this.steps - 1));
    }

    /**
     * Where he should swing to, along the top of the work area: the other side from where his web is
     * now (left or right of the middle), as far in as the Left and Right positions in his menu.
     * Returns { dir, targetX } in screen units.
     */
    static plan(anchorX, work) {
      const fraction = (anchorX - work.x) / work.width;
      const toRight = fraction < 0.5;
      return { dir: toRight ? 1 : -1, targetX: work.x + work.width * (toRight ? 0.88 : 0.12) };
    }
  }

  const api = { Travel };
  if (node) {
    module.exports = api;
  } else {
    (root.SH || (root.SH = {})).travel = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
