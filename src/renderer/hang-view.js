'use strict';
/*
 * The hanging overlay.
 *
 * The window is transparent, always on top, and only as big as his swing needs. It ignores the mouse
 * (clicks fall through to the window underneath) except over him, the line and the knot: the main
 * process forwards mouse moves to this page, and the page switches mouse handling on while the pointer
 * is over something it drew. On Linux the window is shaped to what is drawn instead (shared/shape.js).
 *
 * When he stops moving the frame loop stops, so he uses no CPU until something wakes him.
 *
 * Drawing a frame costs far more in Chromium (re-compositing the whole transparent window) than in
 * our own code, so frames are rationed: at most 60 a second, even on 120 Hz screens, and 30 while he
 * only swings on his own or in the breeze with nobody touching him. The physics always runs at its
 * full rate, so the motion is the same either way; only how often it is shown changes.
 */
(function () {
  const api = window.spidey;
  const { Rig, STEP, REACH_PAST_HEAD } = SH.rig;
  const { Stage, SILK, loadLook } = SH.stage;
  const { Travel } = SH.travel;

  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d');
  const web = (alpha) => `rgba(${SILK[0]}, ${SILK[1]}, ${SILK[2]}, ${alpha})`;

  const rig = new Rig();
  const stage = new Stage(rig, (c, armOffset) => SpideyFigure.draw(c, armOffset, web));
  const bubble = new SH.bubble.Bubble(document.getElementById('bubble'));

  /** { left, top, width, height, work: {x, y, width, height}, rope, body } in screen units. */
  let layout = null;
  let flags = { breeze: false, autoSwing: false };
  let dpr = window.devicePixelRatio || 1;
  let lookRequest = 0;

  let animating = false;
  let lastFrame = 0;
  let accumulator = 0;
  let simTime = 0;
  let quietTime = 0;
  /** When something last happened to him (a touch, a push, a reminder), in performance.now() ms. */
  let lastActive = 0;

  const FULL_FRAME = 1 / 60;
  const CALM_FRAME = 1 / 30;
  const CALM_AFTER_MS = 3000;

  let dragged = null;
  let draggingAnchor = false;
  let dragMoved = false;
  let dragStart = { x: 0, y: 0 };
  let dragTarget = { x: 0, y: 0 };
  let lastHover = { x: 0, y: 0 };
  let lastHoverTime = -1;
  let ignoring = true;
  /** Linux: the window catches the mouse only inside a shape sent with every frame (updateShape). */
  let shaping = false;
  let shapeMask = null;
  let lastShape = '';
  let lastShapeAnkle = null;
  /**
   * Linux: where and when he was last clicked. The nudge from a click moves him out from under the
   * pointer, so the spot keeps catching the mouse long enough for the second click of a double-click.
   */
  let clickSpot = null;
  const CLICK_SPOT_MS = 500;

  /** The trip across the screen in progress (travel.js), or null. */
  let travel = null;
  /** This window is open only to deliver reminders while he is taken down (a visit). */
  let visit = false;
  /** Where Big web reminders land, { x, y, size } in window units, or null when none can come. */
  let webSpot = null;
  /** Dropping in: { age, ready } (ready once his picture has loaded), or null. */
  let arriving = null;
  /** Climbing out: { age, fadeAt, sent }, or null. */
  let leaving = null;
  /**
   * The window following him across the screen, or null: { x, v } its left edge (screen units, not
   * rounded) and speed, and with `to` set, a glide there carrying him along (reduced motion). It
   * moves like a weight on a spring, never in jumps: the screen can show a moved window a frame
   * before or after the drawing that goes with it, and a window moved in jumps showed him jolting.
   */
  let camera = null;
  /** How tightly the window follows him (per second), and how calmly it glides with reduced motion. */
  const FOLLOW_SPRING = 8;
  const GLIDE_SPRING = 4;
  /** A plain click on him this soon after another (ms) is a double-click: no nudge, he swings across. */
  const DOUBLE_CLICK_MS = 400;
  let lastClick = -Infinity;

  const log = (message) => api.send('log', message);
  const problem = (message) => api.send('problem', message);

  // ---- Layout and looks -----------------------------------------------------------------

  function sizeCanvas() {
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(layout.width * dpr);
    canvas.height = Math.round(layout.height * dpr);
  }

  function setVisibleArea() {
    rig.visibleLeft = layout.work.x - layout.left;
    rig.visibleRight = layout.work.x + layout.work.width - layout.left;
  }

  /** Hangs him straight with a small swing, sized and placed as the main process worked out. */
  async function setup(data) {
    // A new layout (reset, new size, another screen) ends any trip across the screen.
    endTravel();
    camera = null;
    layout = data.layout;
    flags = data.flags;
    shaping = Boolean(data.shapeMouse);
    lastShape = '';
    lastShapeAnkle = null;
    sizeCanvas();
    rig.build(layout.width, layout.height, layout.anchorX - layout.left, layout.rope, layout.body);
    setVisibleArea();
    stage.resetPose();
    visit = Boolean(data.visit);
    webSpot = data.web || null;
    leaving = null;
    arriving = null;
    rig.ropeEase = SH.rig.ROPE_EASE;
    stage.opacity = 1;
    if (data.arrive && !stage.reducedMotion) {
      // He drops in from his web at the top: the rope starts reeled in and plays out.
      rig.reel(12);
      rig.ropeTarget = 0;
      rig.ropeEase = DROP_EASE;
      stage.opacity = 0;
      arriving = { age: 0, ready: false };
    } else if (data.arrive) {
      arriving = { age: 0.25, ready: false };
    } else {
      rig.kick(0.5);
    }
    wake();
    await applyLook(data.look);
    if (arriving) {
      arriving.ready = true;
      wake();
    } else if (waiting.length && !showing()) {
      // Brought back while dropping in for a reminder: it is still delivered.
      showReminder(waiting.shift());
    }
  }

  /** The window grew to make room for a Big web (main.js growForWeb): everything stays put on screen. */
  function grow(data) {
    if (!layout) {
      return;
    }
    const dx = layout.left - data.left;
    rig.shiftEverything(dx);
    stage.shiftBy(dx);
    layout.left = data.left;
    layout.width = data.width;
    layout.height = data.height;
    webSpot = data.web;
    sizeCanvas();
    setVisibleArea();
    wake();
  }

  /** What the shown look was made from, so the same look at the same size is not decoded again. */
  let lookKey = '';

  async function applyLook(look) {
    const key = look && look.kind === 'hero'
      ? JSON.stringify([look.name, Object.values(look.poses || {}).map((p) => p.file), rig.bodyLength, dpr])
      : 'drawn';
    if (key === lookKey && (key === 'drawn' ? !stage.look : stage.look)) {
      lookRequest++; // anything still loading is out of date
      wake();
      return;
    }
    const request = ++lookRequest;
    const loaded = await loadLook(look, rig.bodyLength, dpr, problem);
    if (request !== lookRequest) {
      return; // a newer look arrived while this one loaded
    }
    stage.look = loaded;
    lookKey = loaded ? key : 'drawn';
    if (loaded) {
      log(`Look: ${loaded.name} (${Object.keys(loaded.poses).join(', ')}), line ${loaded.line}`);
    } else {
      log('Look: drawn Spider-Man');
    }
    wake();
  }

  /** Breeze or "swing on his own" changed. Starting a swing from still gives him a push. */
  function setFlags(data) {
    const turnedOn = data.autoSwing && !flags.autoSwing;
    flags = { breeze: data.breeze, autoSwing: data.autoSwing };
    if (turnedOn && layout && !travel) {
      // Slide the web in from a screen edge if he would not have room to swing there.
      const anchorX = layout.left + rig.anchor.x;
      const roomy = Rig.roomToSwing(anchorX, rig.ropeLength, layout.body, layout.work);
      if (Math.abs(roomy - anchorX) > 0.5) {
        moveAnchorTo(roomy);
        api.send('anchor-dropped', { fraction: (roomy - layout.work.x) / layout.work.width });
        log(`Moved the web in from the screen edge to make room to swing (${Math.round(anchorX)} to ${Math.round(roomy)})`);
      }
      if (rig.motion() < 0.5) {
        rig.kick(0.8);
      }
    }
    wake();
  }

  // ---- Animation loop -------------------------------------------------------------------

  function wake() {
    quietTime = 0;
    lastActive = performance.now();
    if (animating || !layout) {
      return;
    }
    animating = true;
    lastFrame = 0; // the first frame after waking uses a standard 1/60 s step
    accumulator = 0;
    requestAnimationFrame(frame);
  }

  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    webshot.drawWebs(ctx);
    stage.draw(ctx);
    const shot = webshot.inFlight();
    if (shot) {
      stage.drawShot(ctx, shot.to, shot.share);
    }
    updateShape();
  }

  /** Linux: sends the parts of the window that catch the mouse, when they change (shared/shape.js). */
  function updateShape() {
    if (!shaping || !layout) {
      return;
    }
    const { CELL, rectsFromAlpha, rectAround, padCells } = SH.shape;
    const cols = Math.ceil(layout.width / CELL);
    const rows = Math.ceil(layout.height / CELL);
    if (!shapeMask || shapeMask.canvas.width !== cols || shapeMask.canvas.height !== rows) {
      shapeMask = new OffscreenCanvas(cols, rows).getContext('2d', { willReadFrequently: true });
    }
    shapeMask.setTransform(1, 0, 0, 1, 0, 0);
    shapeMask.clearRect(0, 0, cols, rows);
    shapeMask.setTransform(1 / CELL, 0, 0, 1 / CELL, 0, 0);
    stage.draw(shapeMask);
    const moved = lastShapeAnkle ? Math.hypot(rig.ankle.x - lastShapeAnkle.x, rig.ankle.y - lastShapeAnkle.y) : 0;
    lastShapeAnkle = { x: rig.ankle.x, y: rig.ankle.y };
    const rects = rectsFromAlpha(shapeMask.getImageData(0, 0, cols, rows).data, cols, rows, CELL, padCells(moved));
    if (!rig.free) {
      // The knot, which is grabbed a little beyond what is drawn of it (Rig.nearAnchor).
      rects.push(rectAround({ left: rig.anchor.x - 18, top: 0, right: rig.anchor.x + 18, bottom: rig.anchor.y + 18 }));
    }
    if (bubble.visible) {
      rects.push(rectAround(bubble.el.getBoundingClientRect(), 28)); // and its shadow (overlay.css)
    }
    if (webshot.active && !webshot.note.hidden) {
      rects.push(rectAround(webshot.note.getBoundingClientRect(), 4));
    }
    if (clickSpot && performance.now() - clickSpot.at < CLICK_SPOT_MS) {
      rects.push(rectAround({ left: clickSpot.x, top: clickSpot.y, right: clickSpot.x, bottom: clickSpot.y }, 20));
    }
    const key = JSON.stringify(rects);
    if (key !== lastShape) {
      lastShape = key;
      api.send('mouse-shape', rects);
    }
  }

  function frame(nowMs) {
    if (!animating) {
      return;
    }
    const now = nowMs / 1000;
    const moving = travel !== null || camera !== null;
    const calm = (flags.autoSwing || flags.breeze) && !dragged && !draggingAnchor && !bubble.visible && !moving &&
      nowMs - lastActive > CALM_AFTER_MS;
    // Swinging across the screen, every frame the screen can show (120 a second on some screens):
    // it only lasts a few seconds, and it is the fastest he ever moves.
    const interval = moving ? 0 : calm ? CALM_FRAME : FULL_FRAME;
    // A little slack, so a 60 Hz screen whose frames arrive a hair early never skips one.
    if (lastFrame > 0 && now - lastFrame < interval - 0.004) {
      requestAnimationFrame(frame);
      return;
    }
    let frameDt = lastFrame > 0 ? Math.min(0.05, now - lastFrame) : 1 / 60;
    if (frameDt <= 0) {
      frameDt = 1 / 60;
    }
    lastFrame = now;
    recordFrame(frameDt);

    accumulator += frameDt;
    while (accumulator >= STEP) {
      // No breeze or pumping of his own on the way across: travel.js works out each throw exactly.
      rig.simulate(simTime, flags.breeze && !travel, flags.autoSwing && !travel, dragged, dragTarget);
      if (travel) {
        travelStep();
      }
      accumulator -= STEP;
      simTime += STEP;
    }
    follow(frameDt);
    updateArrival(frameDt);
    updateLeaving(frameDt);
    webshot.advance(frameDt);
    stage.aim = travel ? travel.aim(layout.left) : null;
    stage.blend = accumulator / STEP;
    stage.dragging = dragged !== null;
    stage.advance(frameDt);
    draw();
    placeBubble();

    // 0.02 units per step is about 5 units a second: too slow to see.
    const still = !flags.breeze && !flags.autoSwing && !dragged && !draggingAnchor && !moving &&
      !arriving && !leaving && webshot.settled && rig.motion() < 0.02 && stage.settled;
    quietTime = still ? quietTime + frameDt : 0;
    if (quietTime > 0.5) {
      rig.freeze();
      stage.blend = 1;
      draw();
      animating = false;
      return;
    }
    requestAnimationFrame(frame);
  }

  // ---- Swinging across the screen ------------------------------------------------------------

  const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  stage.reducedMotion = reducedMotion();
  if (window.matchMedia) {
    window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => {
      stage.reducedMotion = reducedMotion();
    });
  }

  /** Sends him to the other side of the screen: web to web, or a calm glide with reduced motion. */
  function startTravel() {
    if (!layout || travel || dragged || draggingAnchor) {
      return;
    }
    const from = layout.left + rig.anchor.x;
    const plan = Travel.plan(from, layout.work);
    let targetX = plan.targetX;
    if (flags.autoSwing) {
      // Far enough in from the edge to keep swinging on his own when he gets there.
      targetX = Rig.roomToSwing(targetX, rig.ropeTarget || layout.rope, layout.body, layout.work);
    }
    if (reducedMotion()) {
      log(`Gliding across (reduced motion): web from ${Math.round(from)} to ${Math.round(targetX)}`);
      camera = { x: layout.left, v: 0, to: Math.round(targetX - rig.anchor.x) };
      landed(targetX);
      wake();
      return;
    }
    log(`Swinging across: web from ${Math.round(from)} to ${Math.round(targetX)}`);
    travel = new Travel(rig, plan.dir, targetX, rig.ropeTarget || layout.rope);
    travel.begin(layout.left);
    stage.travelling = true;
    camera = { x: layout.left, v: camera ? camera.v : 0 };
    wake();
  }

  /** After each physics step of a trip. */
  function travelStep() {
    const event = travel.step(layout.left);
    if (event && event.type === 'release') {
      stage.letGoWeb();
    } else if (event && event.type === 'catch') {
      stage.jerk(0.7); // the new web snaps taut
      if (event.last) {
        landed(event.anchorX);
      }
    }
    if (travel.done) {
      if (travel.phase !== 'land') {
        landed(layout.left + rig.anchor.x); // gave up on the way: he stays where he is
      }
      endTravel();
    }
  }

  function endTravel() {
    if (travel && !travel.done) {
      travel.stop();
    }
    travel = null;
    stage.travelling = false;
    stage.aim = null;
    wake(); // full frame rate a while longer, as after any touch, while he settles
  }

  /** He has his last web: remember the spot, as dropping the knot there would. */
  function landed(anchorX) {
    log(`Swung across: web now at ${Math.round(anchorX)}`);
    api.send('anchor-dropped', { fraction: (anchorX - layout.work.x) / layout.work.width });
  }

  /**
   * Moves the window a frame's worth along. While he swings it keeps his hand in the middle,
   * matching his speed so it barely lags; on his last web, and after, it settles centred on the web,
   * as moveAnchorTo leaves it. Everything in the window shifts back by what the window moved, so on
   * screen he goes on exactly as before. A glide (camera.to) carries him along instead.
   */
  function follow(dt) {
    if (!camera) {
      return;
    }
    const swinging = travel !== null && travel.phase !== 'land';
    const spring = camera.to !== undefined ? GLIDE_SPRING : FOLLOW_SPRING;
    const target = camera.to !== undefined ? camera.to
      : layout.left + (swinging ? rig.ankle.x : rig.anchor.x) - layout.width / 2;
    const speed = swinging ? (rig.ankle.x - rig.ankle.px) / STEP : 0;
    camera.v += (spring * spring * (target - camera.x) + 2 * spring * (speed - camera.v)) * dt;
    camera.x += camera.v * dt;
    // Never let him get near the window's edge, whatever the spring is doing.
    const room = layout.width / 2 - rig.bodyLength * 1.4;
    if (swinging && room > 0) {
      camera.x = Math.max(target - room, Math.min(target + room, camera.x));
    }
    const arrived = !travel && Math.abs(target - camera.x) < 0.5 && Math.abs(camera.v) < 5;
    const left = arrived ? Math.round(target) : Math.round(camera.x);
    const step = left - layout.left;
    if (step !== 0) {
      if (camera.to === undefined) {
        rig.shiftEverything(-step);
        stage.shiftBy(-step);
      }
      layout.left = left;
      api.send('move-window', { left });
      setVisibleArea();
    }
    if (arrived) {
      camera = null;
    }
  }

  // ---- Reminder bubble --------------------------------------------------------------------

  /**
   * Where the bubble goes, { x, y, side }: (x, y) is the tip of its tail. Just above his face,
   * whatever the pose: the tail points down at the upper corner of his face, on the side of the web
   * with more screen to spare, and the whole bubble stays inside the visible part of the window.
   */
  function bubbleSpot() {
    const face = stage.facePoint() || { x: rig.head.x, y: rig.head.y, r: layout.body * 0.12 };
    const lo = Math.max(0, rig.visibleLeft);
    const hi = Math.min(layout.width, rig.visibleRight);
    const side = rig.anchor.x - lo >= hi - rig.anchor.x ? 'left' : 'right';
    const room = SH.bubble.MAX_WIDTH + 14;
    const reach = face.r * 0.75;
    const x = side === 'left' ? Math.max(lo + room, face.x - reach) : Math.min(hi - room, face.x + reach);
    const tall = bubble.height || 60;
    const y = Math.max(tall + 6, Math.min(layout.height - 4, face.y - face.r * 0.85));
    return { x, y, side };
  }

  /** Keeps the bubble (and the thwip on its way to it) with him, every frame as he swings. */
  function placeBubble() {
    if (!layout || (!bubble.visible && !stage.tether)) {
      return;
    }
    const spot = bubbleSpot();
    if (stage.tether) {
      stage.tether.to = { x: spot.x, y: spot.y };
    }
    if (bubble.visible) {
      bubble.place(spot.x, spot.y, spot.side);
    }
  }

  /** Reminders that came while another was showing (or while he dropped in) wait their turn. */
  const waiting = [];
  const MAX_WAITING = 5;

  /** Thwip: a web shoots from his hand to where the bubble pops up above his head, then fades. */
  const THWIP_MS = 160;
  let opening = null;

  /** The Big web reminder (shared/webshot.js), shown only on a visit while he is taken down. */
  const webshot = new SH.webshot.WebShot(document.getElementById('webnote'));
  webshot.onChange = () => wake();
  // Once its text is all there, the main process closes it when the mouse moves anywhere on screen.
  webshot.onTyped = () => api.send('web-typed');
  webshot.onDone = () => {
    updateShape(); // Linux: the web no longer catches the mouse
    wake();
    reminderClosed();
  };

  const showing = () => bubble.visible || opening !== null || webshot.active;

  /** item: { text, style }. Waits while one is showing, while he drops in, or while he climbs out. */
  function showReminder(item) {
    if (typeof item === 'string') {
      item = { text: item, style: 'bubble' };
    }
    if (leaving) {
      // A reminder came as he was climbing out: he comes back down for it.
      comeBack();
    }
    if (showing() || arriving) {
      if (waiting.length < MAX_WAITING) {
        waiting.push(item);
      }
      return;
    }
    if (item.style === 'web' && webSpot) {
      log('Reminder shown (web)');
      webshot.prepare(webSpot, dpr);
      webshot.start(item.text, stage.reducedMotion); // the webs catch the eye: no swing, so he goes still
      wake();
      return;
    }
    log('Reminder shown (bubble)');
    rig.kick(0.4); // a little swing to catch the eye
    if (stage.hasHand() && layout) {
      stage.tether = { to: { x: 0, y: 0 }, age: 0 };
      placeBubble();
      opening = setTimeout(() => {
        opening = null;
        bubble.show(item.text);
        placeBubble();
        wake();
      }, stage.reducedMotion ? 0 : THWIP_MS);
    } else {
      bubble.show(item.text);
      placeBubble();
    }
    wake();
  }

  /** One reminder has closed: the next one waiting, or, at the end of a visit, he climbs out. */
  function reminderClosed() {
    if (waiting.length) {
      setTimeout(() => showReminder(waiting.shift()), 500);
    } else if (visit && !leaving) {
      api.send('visit-done');
    }
  }

  bubble.onHidden = () => {
    stage.tether = null;
    updateShape(); // Linux: the bubble no longer catches the mouse
    wake(); // draw him once more
    reminderClosed();
  };

  /** Closes whatever reminder is showing (a click on it, or the "dismiss" command). */
  function dismiss() {
    if (opening) {
      // Still on its way: it never opens.
      clearTimeout(opening);
      opening = null;
      stage.tether = null;
      wake();
      reminderClosed();
    } else if (bubble.visible) {
      bubble.hide();
    } else if (webshot.active) {
      webshot.close();
    }
  }

  // The bubble and the Big web take the mouse while the pointer is over them, so they can be clicked away.
  for (const el of [bubble.el, webshot.note]) {
    el.addEventListener('mousemove', () => {
      if (ignoring) {
        ignoring = false;
        api.send('ignore-mouse', false);
      }
    });
    el.addEventListener('mouseleave', () => {
      if (!dragged && !draggingAnchor && !ignoring) {
        ignoring = true;
        api.send('ignore-mouse', true);
      }
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      api.send('menu');
    });
  }
  bubble.el.addEventListener('click', () => bubble.hide());
  webshot.note.addEventListener('click', () => webshot.close());

  // ---- Dropping in and climbing out (taken down: a visit) --------------------------------------

  /** How fast the rope plays out or reels in as he drops in or climbs out (per physics step). */
  const DROP_EASE = 0.02;
  /** Climbing out is quicker: gone in well under a second. */
  const CLIMB_EASE = 0.05;

  /** Called each frame while he drops in: fades in, lowers himself, then delivers what is waiting. */
  function updateArrival(dt) {
    if (!arriving) {
      return;
    }
    if (!arriving.ready) {
      stage.opacity = 0; // until his picture has loaded, so the drawing never flashes up
      return;
    }
    if (!rig.ropeTarget) {
      rig.ropeTarget = layout.rope;
    }
    arriving.age += dt;
    stage.opacity = Math.min(1, arriving.age / 0.25);
    if (rig.ropeLength >= layout.rope * 0.96 || arriving.age > 2.5) {
      arriving = null;
      stage.opacity = 1;
      rig.ropeEase = SH.rig.ROPE_EASE;
      stage.jerk(0.6); // the web takes his weight
      log('Dropped in');
      if (waiting.length) {
        showReminder(waiting.shift());
      } else if (visit) {
        api.send('visit-done');
      }
    }
  }

  /** He climbs up to his web and out of sight, then says so; the main process closes the window. */
  function leave() {
    if (leaving || !layout) {
      return;
    }
    waiting.length = 0;
    clearTimeout(opening);
    opening = null;
    if (bubble.visible) {
      bubble.hide();
    }
    webshot.close();
    endTravel();
    dragged = null;
    draggingAnchor = false;
    arriving = null;
    // Taken down: from now on this window only delivers reminders, then climbs out again.
    visit = true;
    leaving = { age: 0, fadeAt: stage.reducedMotion ? 0 : null, sent: false };
    if (!stage.reducedMotion) {
      rig.ropeTarget = 6;
      rig.ropeEase = CLIMB_EASE;
    }
    wake();
  }

  /** Called each frame while he climbs out. */
  function updateLeaving(dt) {
    if (!leaving) {
      return;
    }
    leaving.age += dt;
    if (leaving.fadeAt === null && (rig.ropeLength < layout.rope * 0.4 || leaving.age > 0.45)) {
      leaving.fadeAt = leaving.age;
    }
    if (leaving.fadeAt !== null) {
      stage.opacity = 1 - Math.min(1, (leaving.age - leaving.fadeAt) / 0.22);
      if (stage.opacity <= 0 && !leaving.sent) {
        leaving.sent = true;
        log(`Climbed out (${leaving.age.toFixed(2)} s)`);
        api.send('gone');
      }
    }
  }

  /** A reminder came while he climbed out: back down he comes. */
  function comeBack() {
    leaving = null;
    stage.opacity = 1;
    rig.ropeTarget = layout.rope;
    arriving = { age: 0.25, ready: true };
  }

  // ---- Frame timing record (the "stats" command) ------------------------------------------

  let statFrames = 0;
  let statTime = 0;
  let statWorst = 0;
  let statSlow = 0;
  /** Frames drawn since the "metrics" command started measuring. */
  let metricFrames = 0;

  function recordFrame(frameDt) {
    statFrames++;
    metricFrames++;
    statTime += frameDt;
    statWorst = Math.max(statWorst, frameDt);
    if (frameDt > 0.025) {
      statSlow++;
    }
  }

  function logStats() {
    const fps = statTime > 0 ? statFrames / statTime : 0;
    log(`Frames: ${statFrames} in ${statTime.toFixed(1)} s = ${fps.toFixed(1)} per second, worst gap ${Math.round(statWorst * 1000)} ms, dropped (gap over 25 ms) ${statSlow}, animating ${animating}, look ${stage.look ? stage.look.name : 'drawn'}, pose ${stage.currentPose}, rope angle ${(rig.ropeAngle * 180 / Math.PI).toFixed(1)}, web at ${layout ? Math.round(layout.left + rig.anchor.x) : '-'}`);
    statFrames = statTime = statWorst = statSlow = 0;
  }

  /** The "metrics" command: counts frames from its start, then reports them with the page's heap. */
  function metrics(data) {
    if (data.phase === 'start') {
      metricFrames = 0;
      return;
    }
    const heap = performance.memory ? performance.memory.usedJSHeapSize / (1024 * 1024) : null;
    api.send('metrics-data', { id: data.id, frames: metricFrames, heapMB: heap, animating });
  }

  // ---- Mouse ----------------------------------------------------------------------------

  const local = (e) => ({ x: e.clientX, y: e.clientY });

  // One pixel to draw the scene into for hit testing. Do NOT read pixels back from the canvas on
  // screen: Chromium then takes that canvas off the GPU for good, and drawing every frame on the CPU
  // (and copying it to the GPU) cost about a quarter of a CPU core whenever he moved.
  const probe = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });

  /** The drawn alpha (0..255) at a window point: the canvas pixel there, drawn again on its own. */
  function alphaAt(x, y) {
    const px = Math.round(x * dpr);
    const py = Math.round(y * dpr);
    if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) {
      return 0;
    }
    probe.setTransform(1, 0, 0, 1, 0, 0);
    probe.clearRect(0, 0, 1, 1);
    probe.setTransform(dpr, 0, 0, dpr, -px, -py);
    stage.drawBody(probe); // the web and knot are tested by their shape (Stage.hitTest)
    return probe.getImageData(0, 0, 1, 1).data[3];
  }

  /** Lets the mouse through everywhere except over what is drawn (or while dragging). */
  function updateHit(pt) {
    const hit = dragged !== null || draggingAnchor || (layout !== null && stage.hitTest(pt, alphaAt));
    canvas.className = hit ? (dragged || draggingAnchor ? 'grabbing' : 'hand') : '';
    if (hit === ignoring) {
      ignoring = !hit;
      api.send('ignore-mouse', ignoring);
    }
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !layout) {
      return;
    }
    const pt = local(e);
    if (travel) {
      // Caught mid-swing: he stops travelling and hangs from the web he has.
      endTravel();
      landed(layout.left + rig.anchor.x);
    }
    if (rig.nearAnchor(pt)) {
      draggingAnchor = true;
      camera = null; // the knot moves the window now
    } else {
      dragged = rig.pick(pt);
      if (!dragged) {
        return;
      }
      dragStart = pt;
      dragTarget = pt;
      dragMoved = false;
    }
    canvas.setPointerCapture(e.pointerId);
    updateHit(pt);
    wake();
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!layout) {
      return;
    }
    const pt = local(e);
    if (draggingAnchor) {
      moveAnchorTo(e.screenX);
      return;
    }
    if (dragged) {
      dragTarget = pt;
      if (Math.hypot(pt.x - dragStart.x, pt.y - dragStart.y) > 4) {
        dragMoved = true;
      }
      return;
    }
    brushPast(pt);
    updateHit(pt);
  });

  function release(e) {
    // A plain click on him (no drag) gives a nudge away from the click; a second one straight after
    // is a double-click, and sends him across the screen without a second nudge first.
    let double = false;
    if (dragged && !dragMoved) {
      const pt = local(e);
      const now = performance.now();
      double = now - lastClick < DOUBLE_CLICK_MS;
      lastClick = double ? -Infinity : now;
      clickSpot = { x: pt.x, y: pt.y, at: now };
      if (!double) {
        rig.kick(0.9, pt.x < (rig.ankle.x + rig.head.x) / 2 ? 1 : -1);
      }
    }
    if (dragged && dragMoved) {
      stage.jerk(0.8); // let go: the web snaps taut
    }
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // Not captured.
    }
    endDrag();
    updateHit(local(e));
    if (double) {
      startTravel();
    }
    wake();
  }

  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('lostpointercapture', () => {
    if (dragged || draggingAnchor) {
      endDrag();
    }
  });
  canvas.addEventListener('mouseleave', () => {
    if (!dragged && !draggingAnchor && !ignoring) {
      ignoring = true;
      api.send('ignore-mouse', true);
    }
  });
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.send('menu');
  });
  // Anywhere on him or his web, but not the knot, which is for dragging. Usually release() has
  // already started him off; this catches a double-click slower than DOUBLE_CLICK_MS.
  canvas.addEventListener('dblclick', (e) => {
    if (layout && !rig.nearAnchor(local(e))) {
      startTravel();
    }
  });

  function endDrag() {
    if (draggingAnchor) {
      let dropped = layout.left + rig.anchor.x;
      // Dropped too close to a screen edge while swinging on his own: slide back in so he can keep
      // swinging. Left where it was, the swing would shrink to nothing and look broken.
      if (flags.autoSwing) {
        const roomy = Rig.roomToSwing(dropped, rig.ropeLength, layout.body, layout.work);
        if (Math.abs(roomy - dropped) > 0.5) {
          moveAnchorTo(roomy);
          log(`Web dropped too near the screen edge to swing; slid in from ${Math.round(dropped)} to ${Math.round(roomy)}`);
          dropped = roomy;
        }
      }
      api.send('anchor-dropped', { fraction: (dropped - layout.work.x) / layout.work.width });
    }
    dragged = null;
    draggingAnchor = false;
  }

  /** Moving the cursor across him without clicking pushes him, like brushing past a real charm. */
  function brushPast(pt) {
    const now = performance.now() / 1000;
    if (lastHoverTime >= 0 && now - lastHoverTime < 0.1) {
      const dt = Math.max(0.004, now - lastHoverTime);
      const speedX = Math.max(-1500, Math.min(1500, (pt.x - lastHover.x) / dt));
      const part = rig.pickBody(pt);
      if (part && Math.abs(speedX) > 60) {
        Rig.nudge(part, speedX * 0.15);
        wake();
      }
    }
    lastHover = pt;
    lastHoverTime = now;
  }

  /**
   * Moves the knot along the top of the screen; the window moves with it. His body is shifted back
   * by the same amount, so he stays where he was and the rope swings him along.
   * The window stays centred on the knot even past a screen edge: a window squeezed to the screen
   * puts an invisible wall next to him, and hitting it flung him over the top.
   */
  function moveAnchorTo(screenX) {
    const work = layout.work;
    screenX = Math.max(work.x + 20, Math.min(work.x + work.width - 20, screenX));
    const newLeft = Math.round(screenX - layout.width / 2);
    rig.shiftAll(layout.left - newLeft);
    rig.moveAnchor(screenX - newLeft);
    if (newLeft !== layout.left) {
      layout.left = newLeft;
      api.send('move-window', { left: newLeft });
    }
    setVisibleArea();
    wake();
  }

  // ---- Snapshot (the "snapshot" command) --------------------------------------------------

  /** Saves the overlay's own drawing (never the screen behind it) on a dark background. */
  async function snapshot(path) {
    if (!layout) {
      return;
    }
    const canvas2 = new OffscreenCanvas(Math.round(layout.width), Math.round(layout.height));
    const c = canvas2.getContext('2d');
    c.fillStyle = 'rgb(40, 40, 40)';
    c.fillRect(0, 0, canvas2.width, canvas2.height);
    webshot.drawWebs(c);
    stage.draw(c);
    const blob = await canvas2.convertToBlob({ type: 'image/png' });
    api.send('snapshot-data', { path, bytes: new Uint8Array(await blob.arrayBuffer()), status: `pose ${stage.currentPose}` });
  }

  // ---- Messages from the main process ---------------------------------------------------

  api.on('setup', (data) => setup(data));
  api.on('look', (data) => applyLook(data.look));
  api.on('flags', (data) => setFlags(data));
  api.on('push', (data) => {
    const strength = typeof data.strength === 'number' ? data.strength : 1;
    rig.kick(strength);
    stage.jerk(Math.min(1, strength));
    wake();
  });
  api.on('remind', (data) => showReminder({ text: data.text, style: data.style === 'web' ? 'web' : 'bubble' }));
  api.on('dismiss', () => dismiss());
  api.on('leave', () => leave());
  api.on('grow', (data) => grow(data));
  api.on('travel', () => startTravel());
  api.on('snapshot', (data) => snapshot(data.path));
  api.on('stats', () => logStats());
  api.on('metrics', (data) => metrics(data));

  window.addEventListener('resize', () => {
    if (layout && (window.devicePixelRatio || 1) !== dpr) {
      sizeCanvas();
      applyLook(lastLookPayload);
    }
  });
  let lastLookPayload = null;
  api.on('setup', (data) => {
    lastLookPayload = data.look;
  });
  api.on('look', (data) => {
    lastLookPayload = data.look;
  });

  // For the end-to-end tests: a read-only view of what he is doing.
  window.__spideyState = () => ({
    animating,
    pose: stage.currentPose,
    look: stage.look ? stage.look.name : 'drawn',
    line: stage.line,
    left: layout && layout.left,
    anchorX: layout && layout.left + rig.anchor.x,
    ropeAngle: rig.ropeAngle,
    motion: rig.motion(),
    ignoring,
    flags,
    travelling: travel !== null,
    gliding: camera !== null,
    bubble: bubble.visible,
    web: webshot.active,
    visit,
    arriving: arriving !== null,
    leaving: leaving !== null,
    face: stage.facePoint(),
    bubbleRect: bubble.visible ? bubble.el.getBoundingClientRect().toJSON() : null,
  });

  api.send('ready');
})();
