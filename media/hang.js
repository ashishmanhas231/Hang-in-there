/*
 * Spidey Hang - webview script.
 *
 * Physics: a web rope made of Verlet particles (position-based, no velocities stored).
 * The last rope particle is Spidey's ankle. A second particle is his head.
 * A fixed-length stick joins ankle and head, so he swings like a double pendulum.
 *
 * The drawing code only reads the particle positions. It never changes them.
 */
(function () {
  'use strict';

  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;

  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d');

  // ---- Tuning ---------------------------------------------------------------------------
  const STEP = 1 / 240;          // physics step in seconds
  const ITERATIONS = 24;         // constraint passes per step (more = stiffer rope)
  const GRAVITY = 1800;          // px / s^2
  const DAMPING = 0.9988;        // velocity kept per step (air drag)
  const MAX_SPEED = 2600;        // px / s, stops a wild drag from exploding the rope
  const BREEZE = 140;            // px / s^2, peak sideways push when idleBreeze is on
  const ANCHOR_Y = 6;            // where the rope is tied, from the top edge

  // Inverse masses. Smaller = heavier. The body is heavier than the rope so it leads the swing.
  const W_ROPE = 1;
  const W_ANKLE = 0.6;
  const W_HEAD = 0.4;

  // ---- State ----------------------------------------------------------------------------
  let width = 0;
  let height = 0;
  let dpr = 1;
  let bodyLen = 100;
  let ropeLen = 200;

  let particles = [];
  let constraints = [];
  let ankle = null;
  let head = null;
  let ropeCount = 0;             // number of particles in the rope, including the anchor and ankle

  let settings = { idleBreeze: true };
  let simTime = 0;
  let drag = null;               // { particle, downX, downY, moved }
  let pointer = { x: 0, y: 0 };

  let webRgb = [204, 204, 204];  // refreshed from the VS Code theme
  let prevTheta = null;
  let armOffset = 0;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ---- Setup ----------------------------------------------------------------------------
  function particle(x, y, w) {
    return { x, y, px: x, py: y, w };
  }

  function link(a, b, len) {
    constraints.push({ a, b, len });
  }

  /** Builds a fresh rope and body, hanging straight down. */
  function build() {
    particles = [];
    constraints = [];

    const segments = clamp(Math.round(ropeLen / 16), 8, 28);
    const segLen = ropeLen / segments;
    const cx = width / 2;

    for (let i = 0; i <= segments; i++) {
      const isAnchor = i === 0;
      const isAnkle = i === segments;
      const w = isAnchor ? 0 : isAnkle ? W_ANKLE : W_ROPE;
      particles.push(particle(cx, ANCHOR_Y + i * segLen, w));
    }
    ankle = particles[segments];
    ropeCount = particles.length;

    head = particle(cx, ankle.y + bodyLen, W_HEAD);
    particles.push(head);

    for (let i = 0; i < segments; i++) {
      link(particles[i], particles[i + 1], segLen);
    }
    link(ankle, head, bodyLen);

    prevTheta = null;
    armOffset = 0;
    kick(0.7);
  }

  function layout() {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(60, Math.round(rect.width));
    const h = Math.max(80, Math.round(rect.height));
    const ratio = window.devicePixelRatio || 1;

    if (w === width && h === height && ratio === dpr) {
      return;
    }
    width = w;
    height = h;
    dpr = ratio;

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);

    bodyLen = clamp(Math.min(height * 0.3, width * 0.62), 56, 170);
    ropeLen = Math.max(30, height - ANCHOR_Y - bodyLen * 1.1 - 12);
    build();
  }

  // ---- Forces ---------------------------------------------------------------------------
  /**
   * Gives the rope a sideways shove. Strength 1 is a clear swing.
   * Verlet stores no velocity, so we move the previous position instead.
   */
  function kick(strength, direction) {
    const dir = direction || (Math.random() < 0.5 ? -1 : 1);
    const count = particles.length;
    for (let i = 1; i < count; i++) {
      const p = particles[i];
      const along = i >= ropeCount ? 1 : i / (ropeCount - 1);
      p.px -= dir * strength * 520 * along * STEP;
    }
  }

  // ---- Simulation -----------------------------------------------------------------------
  function integrate(dt) {
    const wind = settings.idleBreeze
      ? BREEZE * (0.6 * Math.sin(simTime * 0.8) + 0.4 * Math.sin(simTime * 1.9 + 1.3))
      : 0;
    const maxMove = MAX_SPEED * dt;

    for (const p of particles) {
      if (p.w === 0) {
        continue;
      }
      let vx = (p.x - p.px) * DAMPING;
      let vy = (p.y - p.py) * DAMPING;

      const speed = Math.hypot(vx, vy);
      if (speed > maxMove) {
        vx *= maxMove / speed;
        vy *= maxMove / speed;
      }

      p.px = p.x;
      p.py = p.y;
      p.x += vx + wind * dt * dt;
      p.y += vy + GRAVITY * dt * dt;
    }
  }

  function solve(c) {
    const a = c.a;
    const b = c.b;
    const wsum = a.w + b.w;
    if (wsum === 0) {
      return;
    }
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1e-6;
    const diff = (d - c.len) / d;
    const ka = (a.w / wsum) * diff;
    const kb = (b.w / wsum) * diff;
    a.x += dx * ka;
    a.y += dy * ka;
    b.x -= dx * kb;
    b.y -= dy * kb;
  }

  /** Keeps everything inside the view. A little bounce so he does not stick to the wall. */
  function contain() {
    for (let i = 1; i < particles.length; i++) {
      const p = particles[i];
      const bodyPart = i >= ropeCount - 1;
      const side = bodyPart ? bodyLen * 0.42 : 4;
      const floor = height - (bodyPart ? bodyLen * 0.12 : 4);

      // Verlet has no velocity field. Moving px flips the speed and keeps 30% of it.
      const vx = p.x - p.px;
      if (p.x < side) {
        p.x = side;
        p.px = side + vx * 0.3;
      } else if (p.x > width - side) {
        p.x = width - side;
        p.px = p.x + vx * 0.3;
      }
      if (p.y > floor) {
        p.py = p.y = floor;
      }
    }
  }

  function simulate(dt) {
    integrate(dt);

    if (drag) {
      const p = drag.particle;
      p.x += (pointer.x - p.x) * 0.3;
      p.y += (pointer.y - p.y) * 0.3;
    }

    for (let i = 0; i < ITERATIONS; i++) {
      for (const c of constraints) {
        solve(c);
      }
    }
    contain();
  }

  // ---- Pointer --------------------------------------------------------------------------
  function toLocal(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /** Picks what the user grabbed: an end of the body, or a point on the rope. */
  function pick(x, y) {
    const ax = ankle.x;
    const ay = ankle.y;
    const sx = head.x - ax;
    const sy = head.y - ay;
    const lenSq = sx * sx + sy * sy || 1;
    const t = clamp(((x - ax) * sx + (y - ay) * sy) / lenSq, 0, 1);
    const nearX = ax + sx * t;
    const nearY = ay + sy * t;

    if (Math.hypot(x - nearX, y - nearY) < bodyLen * 0.3) {
      return t > 0.5 ? head : ankle;
    }

    let best = null;
    let bestDist = 18;
    for (let i = 1; i < ropeCount - 1; i++) {
      const p = particles[i];
      const d = Math.hypot(x - p.x, y - p.y);
      if (d < bestDist) {
        best = p;
        bestDist = d;
      }
    }
    return best;
  }

  canvas.addEventListener('pointerdown', (event) => {
    const pt = toLocal(event);
    pointer = pt;
    const p = pick(pt.x, pt.y);

    if (!p) {
      // Click on empty space: blow him away from the click.
      kick(0.8, pt.x < (ankle.x + head.x) / 2 ? 1 : -1);
      return;
    }
    drag = { particle: p, downX: pt.x, downY: pt.y, moved: false };
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('dragging');
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!drag) {
      return;
    }
    pointer = toLocal(event);
    if (Math.hypot(pointer.x - drag.downX, pointer.y - drag.downY) > 4) {
      drag.moved = true;
    }
  });

  function release(event) {
    if (!drag) {
      return;
    }
    if (!drag.moved) {
      // A plain click on him gives a nudge instead of a drag.
      kick(0.9, pointer.x < (ankle.x + head.x) / 2 ? 1 : -1);
    }
    drag = null;
    canvas.classList.remove('dragging');
    try {
      canvas.releasePointerCapture(event.pointerId);
    } catch (e) {
      // Pointer already released. Nothing to do.
    }
  }
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  // ---- Drawing --------------------------------------------------------------------------
  const RED = '#c8202a';
  const BLUE = '#1f4a9a';
  const INK = '#0e0e14';
  const WHITE = '#f5f5f5';

  const web = (alpha) => `rgba(${webRgb[0]}, ${webRgb[1]}, ${webRgb[2]}, ${alpha})`;

  function readTheme() {
    const match = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(getComputedStyle(document.body).color);
    if (match) {
      webRgb = [Number(match[1]), Number(match[2]), Number(match[3])];
    }
  }

  /** A quarter-web fanning out from a corner. sx is +1 for the left corner, -1 for the right. */
  function drawCornerWeb(cx, cy, sx, radius, alpha) {
    const spokes = 5;
    const rings = 4;
    const angles = [];
    for (let i = 0; i < spokes; i++) {
      angles.push((i / (spokes - 1)) * (Math.PI / 2));
    }
    const at = (angle, r) => [cx + sx * Math.cos(angle) * r, cy + Math.sin(angle) * r];

    ctx.beginPath();
    for (const a of angles) {
      const end = at(a, radius);
      ctx.moveTo(cx, cy);
      ctx.lineTo(end[0], end[1]);
    }
    for (let ring = 1; ring <= rings; ring++) {
      const r = (radius * ring) / rings;
      for (let i = 0; i < spokes - 1; i++) {
        const p1 = at(angles[i], r);
        const p2 = at(angles[i + 1], r);
        const control = at((angles[i] + angles[i + 1]) / 2, r * 0.82);
        ctx.moveTo(p1[0], p1[1]);
        ctx.quadraticCurveTo(control[0], control[1], p2[0], p2[1]);
      }
    }
    ctx.strokeStyle = web(alpha);
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }

  /** The knot at the top where the rope is tied, drawn as a small half web. */
  function drawAnchorWeb(cx) {
    const radius = 20;
    ctx.beginPath();
    const spokes = 7;
    for (let i = 0; i < spokes; i++) {
      const a = (i / (spokes - 1)) * Math.PI;
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx + Math.cos(a) * radius, Math.sin(a) * radius);
    }
    for (let ring = 1; ring <= 2; ring++) {
      const r = (radius * ring) / 2;
      for (let i = 0; i < spokes - 1; i++) {
        const a1 = (i / (spokes - 1)) * Math.PI;
        const a2 = ((i + 1) / (spokes - 1)) * Math.PI;
        const am = (a1 + a2) / 2;
        ctx.moveTo(cx + Math.cos(a1) * r, Math.sin(a1) * r);
        ctx.quadraticCurveTo(cx + Math.cos(am) * r * 0.8, Math.sin(am) * r * 0.8, cx + Math.cos(a2) * r, Math.sin(a2) * r);
      }
    }
    ctx.strokeStyle = web(0.55);
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }

  function drawRope() {
    ctx.beginPath();
    ctx.moveTo(particles[0].x, 0);
    ctx.lineTo(particles[0].x, particles[0].y);
    ctx.lineTo(particles[1].x, particles[1].y);
    for (let i = 1; i < ropeCount - 1; i++) {
      const p = particles[i];
      const n = particles[i + 1];
      ctx.quadraticCurveTo(p.x, p.y, (p.x + n.x) / 2, (p.y + n.y) / 2);
    }
    ctx.lineTo(ankle.x, ankle.y);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = web(0.95);
    ctx.lineWidth = 1.7;
    ctx.stroke();
  }

  /** A limb that gets thinner from (x1, y1) to (x2, y2). */
  function limb(x1, y1, x2, y2, w1, w2, fill) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;

    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(x1 + (nx * w1) / 2, y1 + (ny * w1) / 2);
    ctx.lineTo(x2 + (nx * w2) / 2, y2 + (ny * w2) / 2);
    ctx.lineTo(x2 - (nx * w2) / 2, y2 - (ny * w2) / 2);
    ctx.lineTo(x1 - (nx * w1) / 2, y1 - (ny * w1) / 2);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.arc(x1, y1, w1 / 2, 0, Math.PI * 2);
    ctx.arc(x2, y2, w2 / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawArm(side, offset) {
    const shoulderX = side * 13;
    const shoulderY = -77;
    // Angle from straight "up" (toward the head in the upright drawing).
    const angle = side * 0.5 + offset;
    const bend = side * 0.3;

    const elbowX = shoulderX + Math.sin(angle) * 17;
    const elbowY = shoulderY - Math.cos(angle) * 17;
    const handX = elbowX + Math.sin(angle + bend) * 16;
    const handY = elbowY - Math.cos(angle + bend) * 16;

    limb(shoulderX, shoulderY, elbowX, elbowY, 8, 6.5, RED);
    limb(elbowX, elbowY, handX, handY, 6.5, 5.5, RED);

    ctx.fillStyle = RED;
    ctx.beginPath();
    ctx.arc(handX, handY, 3.6, 0, Math.PI * 2);
    ctx.fill();

    // Web-shooter band on the wrist.
    const wristX = elbowX + (handX - elbowX) * 0.7;
    const wristY = elbowY + (handY - elbowY) * 0.7;
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(wristX, wristY, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawLegs() {
    for (const side of [-1, 1]) {
      limb(side * 6.5, -46, side * 3, -16, 10.5, 7, BLUE);
      limb(side * 3, -16, side * 2.5, -2, 7, 5.5, RED);
    }
  }

  function drawTorso() {
    ctx.beginPath();
    ctx.moveTo(-14, -78);
    ctx.lineTo(14, -78);
    ctx.lineTo(10, -52);
    ctx.lineTo(11, -44);
    ctx.lineTo(-11, -44);
    ctx.lineTo(-10, -52);
    ctx.closePath();

    ctx.fillStyle = RED;
    ctx.fill();

    ctx.save();
    ctx.clip();
    ctx.fillStyle = BLUE;
    ctx.fillRect(-20, -60, 40, 20);
    ctx.restore();

    ctx.strokeStyle = 'rgba(14, 14, 20, 0.55)';
    ctx.lineWidth = 0.7;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Web lines on the chest.
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(-14, -78);
    ctx.lineTo(14, -78);
    ctx.lineTo(10, -52);
    ctx.lineTo(-10, -52);
    ctx.closePath();
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(0, -78);
    ctx.lineTo(0, -52);
    for (const y of [-73, -66, -59]) {
      ctx.moveTo(-14, y - 3);
      ctx.quadraticCurveTo(0, y + 3, 14, y - 3);
    }
    ctx.strokeStyle = 'rgba(14, 14, 20, 0.7)';
    ctx.lineWidth = 0.55;
    ctx.stroke();
    ctx.restore();

    // Spider emblem.
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
    ctx.lineWidth = 0.9;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const side of [-1, 1]) {
      ctx.moveTo(0, -69);
      ctx.lineTo(side * 6.2, -73.5);
      ctx.moveTo(0, -68);
      ctx.lineTo(side * 7, -68.5);
      ctx.moveTo(0, -67);
      ctx.lineTo(side * 6.4, -63);
      ctx.moveTo(0, -66.5);
      ctx.lineTo(side * 4.6, -60.5);
    }
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(0, -66, 1.9, 3.6, 0, 0, Math.PI * 2);
    ctx.ellipse(0, -71, 1.3, 1.5, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawHead() {
    ctx.beginPath();
    ctx.ellipse(0, -90, 9.6, 11, 0, 0, Math.PI * 2);
    ctx.fillStyle = RED;
    ctx.fill();

    ctx.save();
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(0, -102);
    ctx.lineTo(0, -79);
    for (const y of [-97, -91, -85]) {
      ctx.moveTo(-10, y);
      ctx.quadraticCurveTo(0, y + 5, 10, y);
    }
    ctx.strokeStyle = 'rgba(14, 14, 20, 0.6)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
    ctx.restore();

    ctx.beginPath();
    ctx.ellipse(0, -90, 9.6, 11, 0, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(14, 14, 20, 0.55)';
    ctx.lineWidth = 0.7;
    ctx.stroke();

    // Eyes: slanted so the inner corners sit lower.
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(side * 4.7, -89, 4.5, 2.8, -side * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = WHITE;
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  /** The web wrapped around his ankles, where the rope is tied. */
  function drawAnkleWrap() {
    ctx.strokeStyle = web(0.95);
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.ellipse(0, -5, 6.6, 1.9, 0, 0, Math.PI * 2);
    ctx.ellipse(0, -9, 6.2, 1.7, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -1, 1.6, 0, Math.PI * 2);
    ctx.fillStyle = web(0.95);
    ctx.fill();
  }

  /**
   * Draws him upright in a 100-unit-tall space with his feet at (0, 0) and his head at (0, -100).
   * The transform then turns that so his feet sit on the ankle particle and his head on the head particle.
   * When he hangs, that turns him upside down.
   */
  function drawSpidey(frameDt) {
    const dx = head.x - ankle.x;
    const dy = head.y - ankle.y;
    const theta = Math.atan2(dy, dx) + Math.PI / 2;

    if (prevTheta !== null && frameDt > 0) {
      let delta = theta - prevTheta;
      delta = ((delta + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      const angularSpeed = delta / frameDt;
      // Loose arms lag behind the swing.
      const target = clamp(-angularSpeed * 0.1, -0.7, 0.7);
      armOffset += (target - armOffset) * 0.12;
    }
    prevTheta = theta;

    ctx.save();
    ctx.translate(ankle.x, ankle.y);
    ctx.rotate(theta);
    const s = bodyLen / 100;
    ctx.scale(s, s);

    drawArm(-1, armOffset);
    drawArm(1, armOffset);
    drawLegs();
    drawTorso();
    drawHead();
    drawAnkleWrap();

    ctx.restore();
  }

  function draw(frameDt) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const corner = clamp(Math.min(width, height) * 0.4, 40, 120);
    drawCornerWeb(0, 0, 1, corner, 0.22);
    drawCornerWeb(width, 0, -1, corner, 0.22);
    drawAnchorWeb(particles[0].x);

    drawRope();
    drawSpidey(frameDt);
  }

  // ---- Main loop ------------------------------------------------------------------------
  let lastNow = performance.now();
  let accumulator = 0;

  function frame(now) {
    const frameDt = Math.min(0.05, (now - lastNow) / 1000);
    lastNow = now;
    accumulator += frameDt;

    while (accumulator >= STEP) {
      simulate(STEP);
      accumulator -= STEP;
      simTime += STEP;
    }
    draw(frameDt);
    requestAnimationFrame(frame);
  }

  // ---- Messages from the extension ------------------------------------------------------
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || !particles.length) {
      return;
    }
    switch (message.type) {
      case 'settings':
        settings = Object.assign(settings, message.settings);
        break;
      case 'push':
        kick(typeof message.strength === 'number' ? message.strength : 1);
        break;
      case 'reset':
        build();
        break;
    }
  });

  // ---- Start ----------------------------------------------------------------------------
  new ResizeObserver(layout).observe(canvas);
  new MutationObserver(readTheme).observe(document.documentElement, { attributes: true });
  new MutationObserver(readTheme).observe(document.body, { attributes: true });
  readTheme();
  layout();

  requestAnimationFrame((now) => {
    lastNow = now;
    requestAnimationFrame(frame);
  });

  if (vscode) {
    vscode.postMessage({ type: 'ready' });
  }
})();
