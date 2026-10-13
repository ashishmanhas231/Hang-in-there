'use strict';
/*
 * The hanging overlay.
 *
 * The window is transparent, always on top, and only as big as his swing needs. It ignores the mouse
 * (clicks fall through to the window underneath) except over him, the line and the knot: the main
 * process forwards mouse moves to this page, and the page switches mouse handling on while the pointer
 * is over something it drew.
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
    layout = data.layout;
    flags = data.flags;
    sizeCanvas();
    rig.build(layout.width, layout.height, layout.anchorX - layout.left, layout.rope, layout.body);
    setVisibleArea();
    stage.resetPose();
    rig.kick(0.5);
    wake();
    await applyLook(data.look);
  }

  async function applyLook(look) {
    const request = ++lookRequest;
    const loaded = await loadLook(look, rig.bodyLength, dpr, problem);
    if (request !== lookRequest) {
      return; // a newer look arrived while this one loaded
    }
    stage.look = loaded;
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
    if (turnedOn && layout) {
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
    stage.draw(ctx);
  }

  function frame(nowMs) {
    if (!animating) {
      return;
    }
    const now = nowMs / 1000;
    const calm = (flags.autoSwing || flags.breeze) && !dragged && !draggingAnchor && !bubble.visible &&
      nowMs - lastActive > CALM_AFTER_MS;
    const interval = calm ? CALM_FRAME : FULL_FRAME;
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
      rig.simulate(simTime, flags.breeze, flags.autoSwing, dragged, dragTarget);
      accumulator -= STEP;
      simTime += STEP;
    }
    stage.blend = accumulator / STEP;
    stage.dragging = dragged !== null;
    stage.advance(frameDt);
    draw();
    placeBubble();

    // 0.02 units per step is about 5 units a second: too slow to see.
    const still = !flags.breeze && !flags.autoSwing && !dragged && !draggingAnchor && rig.motion() < 0.02 && stage.settled;
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

  // ---- Reminder bubble --------------------------------------------------------------------

  /**
   * Keeps the bubble just above his face, whatever the pose: its tail points down at the upper
   * corner of his face, on the side of the web with more screen to spare, and the whole bubble stays
   * inside the visible part of the window. Follows him every frame as he swings.
   */
  function placeBubble() {
    if (!bubble.visible || !layout) {
      return;
    }
    const face = stage.facePoint() || { x: rig.head.x, y: rig.head.y, r: layout.body * 0.12 };
    const lo = Math.max(0, rig.visibleLeft);
    const hi = Math.min(layout.width, rig.visibleRight);
    const side = rig.anchor.x - lo >= hi - rig.anchor.x ? 'left' : 'right';
    const room = SH.bubble.MAX_WIDTH + 14;
    const reach = face.r * 0.75;
    const x = side === 'left' ? Math.max(lo + room, face.x - reach) : Math.min(hi - room, face.x + reach);
    const tall = bubble.height || 60;
    const y = Math.max(tall + 6, Math.min(layout.height - 4, face.y - face.r * 0.85));
    bubble.place(x, y, side);
  }

  /** Reminders that came while the bubble was up wait their turn, a few at most. */
  const waiting = [];
  const MAX_WAITING = 5;

  function showReminder(text) {
    if (bubble.visible) {
      if (waiting.length < MAX_WAITING) {
        waiting.push(text);
      }
      return;
    }
    bubble.show(text);
    placeBubble();
    rig.kick(0.4); // a little swing to catch the eye
    wake();
  }

  bubble.onHidden = () => {
    if (waiting.length) {
      setTimeout(() => showReminder(waiting.shift()), 500);
    }
  };

  // The bubble takes the mouse while the pointer is over it, so it can be clicked away.
  bubble.el.addEventListener('mousemove', () => {
    if (ignoring) {
      ignoring = false;
      api.send('ignore-mouse', false);
    }
  });
  bubble.el.addEventListener('mouseleave', () => {
    if (!dragged && !draggingAnchor && !ignoring) {
      ignoring = true;
      api.send('ignore-mouse', true);
    }
  });
  bubble.el.addEventListener('click', () => bubble.hide());
  bubble.el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.send('menu');
  });

  // ---- Frame timing record (the "stats" command) ------------------------------------------

  let statFrames = 0;
  let statTime = 0;
  let statWorst = 0;
  let statSlow = 0;

  function recordFrame(frameDt) {
    statFrames++;
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

  // ---- Mouse ----------------------------------------------------------------------------

  const local = (e) => ({ x: e.clientX, y: e.clientY });

  function alphaAt(x, y) {
    const px = Math.round(x * dpr);
    const py = Math.round(y * dpr);
    if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) {
      return 0;
    }
    return ctx.getImageData(px, py, 1, 1).data[3];
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
    if (rig.nearAnchor(pt)) {
      draggingAnchor = true;
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
    // A plain click on him (no drag) gives a nudge away from the click.
    if (dragged && !dragMoved) {
      const pt = local(e);
      rig.kick(0.9, pt.x < (rig.ankle.x + rig.head.x) / 2 ? 1 : -1);
    }
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // Not captured.
    }
    endDrag();
    updateHit(local(e));
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
    stage.draw(c);
    const blob = await canvas2.convertToBlob({ type: 'image/png' });
    api.send('snapshot-data', { path, bytes: new Uint8Array(await blob.arrayBuffer()), status: `pose ${stage.currentPose}` });
  }

  // ---- Messages from the main process ---------------------------------------------------

  api.on('setup', (data) => setup(data));
  api.on('look', (data) => applyLook(data.look));
  api.on('flags', (data) => setFlags(data));
  api.on('push', (data) => {
    rig.kick(typeof data.strength === 'number' ? data.strength : 1);
    wake();
  });
  api.on('cursor', (pt) => {
    // Linux only: the pointer position, polled by the main process (see followCursor in main.js).
    if (layout && !dragged && !draggingAnchor) {
      if (bubble.contains(pt)) {
        if (ignoring) {
          ignoring = false;
          api.send('ignore-mouse', false);
        }
        return;
      }
      brushPast(pt);
      updateHit(pt);
    }
  });
  api.on('remind', (data) => showReminder(data.text));
  api.on('snapshot', (data) => snapshot(data.path));
  api.on('stats', () => logStats());

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
    bubble: bubble.visible,
    face: stage.facePoint(),
    bubbleRect: bubble.visible ? bubble.el.getBoundingClientRect().toJSON() : null,
  });

  api.send('ready');
})();
