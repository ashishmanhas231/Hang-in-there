'use strict';
/*
 * Unit tests. Plain Node, no Electron and no screen:  node --test test/
 * Each test that touches files gets its own temporary ~/.spidey-hang (SPIDEY_HANG_HOME).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const D = path.join(__dirname, '..', 'src');
const { Rig, STEP } = require(path.join(D, 'renderer/shared/rig.js'));
const IM = require(path.join(D, 'renderer/shared/images.js'));
const { HeroLook, Stage } = require(path.join(D, 'renderer/shared/stage.js'));
const fixtures = require('./fixtures.js');

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spidey-test-'));
  process.env.SPIDEY_HANG_HOME = dir;
  return dir;
}

/** A medium Spidey as the snapshot test lays him out. */
function mediumRig() {
  const rig = new Rig();
  const body = 150;
  const rope = 280;
  const reach = rope + body * 1.32;
  rig.build(2 * reach + 40, reach + 30, reach + 20, rope, body);
  return rig;
}

function run(rig, seconds, autoSwing = false, each) {
  let t = 0;
  while (t < seconds) {
    rig.simulate(t, false, autoSwing, null, null);
    t += STEP;
    if (each) each(t);
  }
}

// ---- Physics ---------------------------------------------------------------------------------

test('rope holds its length through a hard swing', () => {
  const rig = mediumRig();
  rig.kick(3, 1);
  let worst = 1;
  run(rig, 10, false, () => (worst = Math.max(worst, rig.ropeStretch)));
  assert.ok(worst < 1.02, `rope stretched to ${worst}`);
});

test('he settles and goes still on his own', () => {
  const rig = mediumRig();
  rig.kick(1, 1);
  run(rig, 15);
  assert.ok(rig.motion() < 0.02, `still moving: ${rig.motion()}`);
  assert.ok(Math.abs(rig.ropeAngle) < 0.01);
});

test('swing on his own holds a steady swing of about 25-35 degrees', () => {
  const rig = mediumRig();
  rig.kick(0.8, 1);
  let peak = 0;
  run(rig, 40, true, (t) => {
    if (t > 25) peak = Math.max(peak, Math.abs(rig.ropeAngle));
  });
  const degrees = (peak * 180) / Math.PI;
  assert.ok(degrees > 20 && degrees < 36, `peak ${degrees.toFixed(1)} degrees`);
});

test('swing on his own stays small near a screen edge', () => {
  const rig = mediumRig();
  rig.visibleRight = rig.anchor.x + 120; // the screen ends just right of the web
  rig.kick(0.8, 1);
  let peak = 0;
  run(rig, 30, true, (t) => {
    if (t > 15) peak = Math.max(peak, Math.abs(rig.ropeAngle));
  });
  assert.ok(peak < rig.swingRoom() + 0.12, `peak ${peak} over room ${rig.swingRoom()}`);
});

test('roomToSwing slides the web in from the edges, or centres it on a narrow screen', () => {
  const work = { x: 0, width: 1920 };
  const needed = Rig.distanceForFullSwing(280, 150);
  assert.equal(Rig.roomToSwing(1900, 280, 150, work), 1920 - needed);
  assert.equal(Rig.roomToSwing(10, 280, 150, work), needed);
  assert.equal(Rig.roomToSwing(900, 280, 150, work), 900);
  assert.equal(Rig.roomToSwing(10, 280, 150, { x: 100, width: 300 }), 250);
});

test('picking: body ends, rope points, the knot, and empty space', () => {
  const rig = mediumRig();
  run(rig, 0.1);
  const head = rig.pick({ x: rig.head.x, y: rig.head.y - 10 });
  assert.equal(head, rig.head);
  assert.equal(rig.pick({ x: rig.ankle.x, y: rig.ankle.y + 5 }), rig.ankle);
  const mid = rig.particles[5];
  assert.equal(rig.pick({ x: mid.x + 3, y: mid.y }), mid);
  assert.equal(rig.pick({ x: rig.anchor.x + 300, y: 200 }), null);
  assert.ok(rig.nearAnchor({ x: rig.anchor.x + 5, y: 5 }));
  assert.ok(!rig.nearAnchor({ x: rig.anchor.x + 40, y: 5 }));
});

test('a reeled-in rope plays all the way out before he counts as still', () => {
  const rig = mediumRig();
  const full = rig.ropeLength;
  rig.reel(12);
  rig.ropeTarget = full;
  assert.equal(rig.reeling, true);
  let t = 0;
  while (rig.reeling && t < 30) {
    rig.simulate(t, false, false, null, null);
    t += STEP;
  }
  assert.equal(rig.reeling, false, 'reached its length');
  assert.ok(Math.abs(rig.ropeLength - full) <= 0.5, `rope ${rig.ropeLength} of ${full}`);
});

test('moving the knot keeps him where he was', () => {
  const rig = mediumRig();
  const before = rig.head.x;
  rig.shiftAll(-50);
  rig.moveAnchor(rig.anchor.x - 50);
  assert.equal(rig.head.x, before - 50);
  assert.equal(rig.motion(), 0);
});

// ---- Pictures --------------------------------------------------------------------------------

test('a hanging picture ties on at the middle of its top edge and is sized to his body', () => {
  const p = fixtures.pixels(100, 200).rect(30, 20, 70, 180, [255, 0, 0, 255]);
  const m = IM.measureFigure(p.data, 100, 200, false, 150);
  assert.deepEqual(m.box, { x: 30, y: 20, width: 40, height: 160 });
  assert.equal(m.attachX, 19.5);
  assert.equal(m.attachY, 0);
  assert.ok(Math.abs(m.balanceDegrees) < 0.5);
  assert.ok(Math.abs(m.box.height * m.scale - 150 * 1.3) < 1e-9);
});

test('a lopsided picture tilts so its weight hangs below the tie-on point', () => {
  // A thin hook at top left, a heavy block lower right.
  const p = fixtures.pixels(200, 200).rect(10, 0, 20, 100, [0, 0, 0, 255]).rect(10, 100, 190, 190, [0, 0, 0, 255]);
  const m = IM.measureFigure(p.data, 200, 200, false, 150);
  assert.ok(m.balanceDegrees > 20, `tilt ${m.balanceDegrees}`);
});

test('flip ties an upright picture on at its bottom edge', () => {
  const p = fixtures.person([255, 0, 0, 255]);
  const m = IM.measureFigure(p.data, 200, 400, true, 150);
  assert.equal(m.attachY, m.box.height);
});

test('a completely transparent picture is refused', () => {
  const p = fixtures.pixels(10, 10);
  assert.throws(() => IM.measureFigure(p.data, 10, 10, false, 150), /transparent/);
});

test('a picture held by a grip ties on there, keeps its pose turned by tilt, and knows its face', () => {
  const p = fixtures.person([255, 0, 0, 255]); // box 10..190 x 20..390
  const hold = { grip: { x: 150, y: 300 }, tilt: -7, face: { x: 100, y: 50 }, faceSize: 30 };
  const m = IM.measureFigure(p.data, 200, 400, false, 150, 1.3, hold);
  assert.equal(m.attachX, 150 - m.box.x);
  assert.equal(m.attachY, 300 - m.box.y);
  assert.equal(m.balanceDegrees, -7, 'no tipping to balance under a grip');
  assert.ok(m.gripped);
  const figure = new IM.CustomFigure(m, false, null, 1);
  const face = figure.facePoint();
  // The face is above and left of the grip; turned 7 degrees anticlockwise it stays above it.
  assert.ok(face.y < 0 && face.x < 0, JSON.stringify(face));
  assert.ok(Math.abs(Math.hypot(face.x, face.y) - Math.hypot(50, 250) * m.scale) < 1e-6);
  assert.equal(face.r, 30 * m.scale);
  assert.equal(new IM.CustomFigure(IM.measureFigure(p.data, 200, 400, false, 150), false, null, 1).facePoint(), null);
});

test('a picture knows the hand new webs shoot from, turned with it, and has none unless hero.json names one', () => {
  const p = fixtures.person([255, 0, 0, 255]); // box 10..190 x 20..390
  const m = IM.measureFigure(p.data, 200, 400, false, 150, 1.3, { grip: { x: 100, y: 20 }, tilt: 90, hand: { x: 100, y: 120 } });
  const hand = new IM.CustomFigure(m, false, null, 1).handPoint();
  // 100 picture pixels below the grip, turned a quarter turn clockwise: to the left of it.
  assert.ok(Math.abs(hand.x + 100 * m.scale) < 1e-9 && Math.abs(hand.y) < 1e-9, JSON.stringify(hand));
  assert.equal(new IM.CustomFigure(IM.measureFigure(p.data, 200, 400, false, 150), false, null, 1).handPoint(), null);
});

test('a new web leaves from his hand, and after it catches slides to where he holds it', () => {
  const rig = mediumRig();
  const stage = new Stage(rig, null);
  assert.deepEqual(stage.handPoint(), stage.at(rig.ankle), 'no hand: where he is tied on');
  const figure = { size: { x: 60, y: 120 }, draw() {}, facePoint: () => null, handPoint: () => ({ x: 30, y: -40 }) };
  stage.look = new HeroLook('x', 'web', { hang: figure });
  const hand = stage.handPoint();
  assert.ok(Math.hypot(hand.x - rig.ankle.x, hand.y - rig.ankle.y) > 40, 'away from the tie-on point');
  stage.aim = { x: rig.ankle.x + 200, y: 0, share: 0.5 };
  const line = stage.aimLine();
  assert.ok(Math.hypot(line[line.length - 1].x - hand.x, line[line.length - 1].y - hand.y) < 1e-9, 'the shot starts at his hand');
  stage.advance(1 / 60);
  stage.aim = null; // caught
  stage.advance(1 / 60);
  assert.ok(stage.handover && !stage.settled, 'handing over');
  const rope = stage.sampleRope();
  stage.pullEndToHand(rope);
  const end = rope[rope.length - 1];
  assert.ok(Math.hypot(end.x - hand.x, end.y - hand.y) < Math.hypot(rig.ankle.x - hand.x, rig.ankle.y - hand.y), 'still near the hand');
  for (let i = 0; i < 20; i++) stage.advance(1 / 60);
  assert.equal(stage.handover, null);
});

// ---- Looks -----------------------------------------------------------------------------------

test('missing poses fall back: grab and fly to swing, swing to hang', () => {
  const hang = { name: 'hang' };
  const swing = { name: 'swing' };
  const look = new HeroLook('x', 'web', { hang, swing });
  assert.equal(look.pose('grab'), swing);
  assert.equal(look.pose('fly'), swing);
  assert.equal(look.pose('swing'), swing);
  assert.equal(new HeroLook('x', 'web', { hang }).pose('fly'), hang);
  assert.equal(new HeroLook('x', 'chain', { hang }).line, 'web', 'only the web is drawn');
});

test('hit testing never reads a pixel back when the pointer is far from him', () => {
  const rig = mediumRig();
  const stage = new Stage(rig, null);
  stage.look = new HeroLook('x', 'web', { hang: { size: { x: 60, y: 120 }, draw() {}, facePoint: () => null } });
  let reads = 0;
  const alphaAt = () => {
    reads++;
    return 255;
  };
  assert.equal(stage.hitTest({ x: 5, y: rig.ankle.y + 300 }, alphaAt), false);
  assert.equal(reads, 0);
  assert.equal(stage.hitTest({ x: rig.ankle.x + 20, y: rig.ankle.y + 40 }, alphaAt), true);
  assert.equal(reads, 1);
});

// ---- Motion of a picture hero ----------------------------------------------------------------

/** A picture that counts how often it is drawn. */
function countingPicture(name) {
  return { name, draws: 0, size: { x: 60, y: 120 }, draw() { this.draws++; }, facePoint: () => null, handPoint: () => null };
}

/** A canvas that only remembers its last scale. */
function fakeContext() {
  const ctx = { globalAlpha: 1, lastScale: null };
  for (const name of ['save', 'restore', 'translate', 'rotate', 'beginPath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'stroke', 'fill', 'ellipse']) {
    ctx[name] = () => {};
  }
  ctx.scale = (x, y) => (ctx.lastScale = [x, y]);
  ctx.createRadialGradient = () => ({ addColorStop() {} });
  return ctx;
}

test('a pose change snaps: the old picture tucks in, the new one springs out past full size, one at a time', () => {
  const rig = mediumRig();
  const stage = new Stage(rig, null);
  const hang = countingPicture('hang');
  const swing = countingPicture('swing');
  stage.look = new HeroLook('x', 'web', { hang, swing });
  stage.dragging = true; // grab: shows at once, and falls back to the swing picture
  stage.advance(1 / 60);
  assert.equal(stage.shown, swing);
  const seen = [];
  for (let i = 0; i < 20; i++) {
    const before = hang.draws + swing.draws;
    const { picture, scale } = stage.pictureNow();
    stage.draw(fakeContext());
    assert.equal(hang.draws + swing.draws - before, 1, 'one picture per frame');
    seen.push([picture.name, scale]);
    stage.advance(1 / 60);
  }
  assert.equal(seen[0][0], 'hang', 'the old picture first');
  assert.ok(seen.some(([n, k]) => n === 'hang' && k < 0.95), 'tucks in');
  assert.ok(seen.some(([n, k]) => n === 'swing' && k > 1.02), 'springs out past full size');
  assert.equal(stage.snap, null);
  assert.deepEqual(stage.pictureNow(), { picture: swing, scale: 1 });
});

test('follow-through trails the swing by at most 6 degrees, and he still goes still', () => {
  const rig = mediumRig();
  const stage = new Stage(rig, null);
  stage.look = new HeroLook('x', 'web', { hang: countingPicture('hang') });
  rig.kick(3, 1);
  let most = 0;
  let t = 0;
  for (let frame = 0; frame < 60 * 40; frame++) {
    for (let i = 0; i < 4; i++) {
      rig.simulate(t, false, false, null, null);
      t += STEP;
    }
    stage.advance(1 / 60);
    most = Math.max(most, Math.abs(stage.sway));
  }
  assert.ok(most > 0.01 && most <= (6 * Math.PI) / 180 + 1e-9, `sway peaked at ${most}`);
  assert.ok(rig.motion() < 0.02 && stage.settled, 'settled');
});

test('a jerk stretches a picture a little for under half a second; never the drawing, never with reduced motion', () => {
  const rig = mediumRig();
  const stage = new Stage(rig, null);
  stage.jerk(1);
  assert.equal(stage.stretch, null, 'the drawn figure keeps its shape');
  stage.look = new HeroLook('x', 'web', { hang: countingPicture('hang') });
  stage.jerk(1);
  assert.ok(stage.stretchNow() > 1.04 && stage.stretchNow() <= 1.045 + 1e-9);
  assert.equal(stage.settled, false);
  for (let i = 0; i < 30; i++) stage.advance(1 / 60);
  assert.equal(stage.stretch, null);
  assert.equal(stage.stretchNow(), 1);
  stage.reducedMotion = true;
  stage.jerk(1);
  assert.equal(stage.stretch, null);
});

test('reduced motion: poses change at once, with no snap', () => {
  const rig = mediumRig();
  const stage = new Stage(rig, null);
  const swing = countingPicture('swing');
  stage.look = new HeroLook('x', 'web', { hang: countingPicture('hang'), swing });
  stage.reducedMotion = true;
  stage.dragging = true;
  stage.advance(1 / 60);
  assert.equal(stage.snap, null);
  assert.deepEqual(stage.pictureNow(), { picture: swing, scale: 1 });
});

test('a reminder thwip shoots from his hand to the bubble in 0.15 s, fades, and lets him go still', () => {
  const rig = mediumRig();
  const stage = new Stage(rig, null);
  stage.look = new HeroLook('x', 'web', { hang: countingPicture('hang') });
  stage.tether = { to: { x: 10, y: 10 }, age: 0 };
  stage.advance(1 / 60);
  assert.equal(stage.settled, false);
  stage.draw(fakeContext());
  for (let i = 0; i < 30; i++) stage.advance(1 / 60);
  assert.equal(stage.tether, null, 'gone after the fade');
  assert.equal(stage.settled, true);
  stage.reducedMotion = true;
  stage.tether = { to: { x: 10, y: 10 }, age: 0 };
  stage.advance(1 / 60);
  assert.equal(stage.tether, null, 'no thwip with reduced motion');
});

test('hover reads a pixel only inside the picture, turned as it is drawn', () => {
  const rig = mediumRig();
  const stage = new Stage(rig, null);
  const p = fixtures.person([255, 0, 0, 255]); // box 10..190 x 20..390
  const m = IM.measureFigure(p.data, 200, 400, false, 150);
  stage.look = new HeroLook('x', 'web', { hang: new IM.CustomFigure(m, false, null, 1) });
  let reads = 0;
  const alphaAt = () => {
    reads++;
    return 255;
  };
  const ankle = stage.at(rig.ankle);
  // Just beside the picture, though well within its diagonal of the tie-on point: no pixel read.
  assert.equal(stage.hitTest({ x: ankle.x + m.box.width * m.scale, y: ankle.y + 20 }, alphaAt), false);
  assert.equal(reads, 0);
  // On him: one pixel read.
  assert.equal(stage.hitTest({ x: ankle.x, y: ankle.y + m.box.height * m.scale * 0.5 }, alphaAt), true);
  assert.equal(reads, 1);
});

test('a picture knows which way it faces: from hero.json, else from the side of his web hand', () => {
  const p = fixtures.person([255, 0, 0, 255]); // box 10..190 x 20..390
  const figure = (hold) => new IM.CustomFigure(IM.measureFigure(p.data, 200, 400, false, 150, 1.3, hold), false, null, 1);
  assert.equal(figure({ grip: { x: 100, y: 20 }, hand: { x: 20, y: 200 } }).facing, -1, 'hand to the left');
  assert.equal(figure({ grip: { x: 100, y: 20 }, hand: { x: 180, y: 200 } }).facing, 1, 'hand to the right');
  assert.equal(figure({ grip: { x: 100, y: 20 }, hand: { x: 102, y: 200 } }).facing, 0, 'hand in the middle: never mirrored');
  assert.equal(figure({ grip: { x: 100, y: 20 }, hand: { x: 20, y: 200 }, faces: 1 }).facing, 1, 'hero.json wins');
  assert.equal(figure({}).facing, 0);
});

test('swinging the other way he is mirrored to face it, turning round edge-on, and turns back after', () => {
  const rig = mediumRig();
  const stage = new Stage(rig, null);
  const picture = { ...countingPicture('hang'), facing: 1, handPoint: () => ({ x: 30, y: 40 }), facePoint: () => ({ x: 20, y: 60, r: 10 }) };
  stage.look = new HeroLook('x', 'web', { hang: picture });
  const hand = stage.handPoint();
  stage.facing = 1;
  stage.advance(1 / 60);
  assert.equal(stage.mirror, 1, 'already facing that way');
  stage.facing = -1;
  const seen = [];
  for (let i = 0; i < 30; i++) {
    stage.advance(1 / 60);
    seen.push(stage.mirror);
  }
  assert.equal(stage.mirror, -1);
  assert.ok(seen.some((m) => Math.abs(m) < 0.15), 'edge-on half way round');
  assert.ok(seen.indexOf(-1) >= 8 && seen.indexOf(-1) <= 13, `turned round in ${seen.indexOf(-1) + 1} frames`);
  // His hand and face are mirrored with him, about the line of his body.
  const mirrored = stage.handPoint();
  const ankle = stage.at(rig.ankle);
  const theta = stage.bodyAngle() - Math.PI;
  const across = (pt) => (pt.x - ankle.x) * Math.cos(theta) + (pt.y - ankle.y) * Math.sin(theta);
  assert.ok(Math.abs(across(mirrored) + across(hand)) < 1e-9, 'hand on the other side');
  const ctx = fakeContext();
  stage.drawBody(ctx);
  assert.ok(ctx.lastScale[0] < 0, 'drawn mirrored');
  stage.facing = 0; // settled: back as drawn
  for (let i = 0; i < 30; i++) stage.advance(1 / 60);
  assert.equal(stage.mirror, 1);
  stage.reducedMotion = true;
  stage.facing = -1;
  stage.advance(1 / 60);
  assert.equal(stage.mirror, -1, 'reduced motion: turns at once');
});

test('a somersault turns him about his middle and tucks him in, and the hover test follows', () => {
  const rig = mediumRig();
  const stage = new Stage(rig, null);
  const p = fixtures.person([255, 0, 0, 255]);
  const m = IM.measureFigure(p.data, 200, 400, false, 150);
  stage.look = new HeroLook('x', 'web', { hang: new IM.CustomFigure(m, false, null, 1) });
  const ankle = stage.at(rig.ankle);
  const onHim = { x: ankle.x, y: ankle.y + m.box.height * m.scale * 0.5 };
  const alphaAt = () => 255;
  assert.equal(stage.hitTest(onHim, alphaAt), true);
  // Half way round: where he was is empty; the same point turned about his middle is him.
  stage.spin = Math.PI;
  stage.tuck = 1;
  assert.ok(!stage.settled);
  const c = stage.pivot();
  assert.equal(stage.hitTest({ x: 2 * c.x - onHim.x, y: 2 * c.y - onHim.y }, alphaAt), true);
  stage.spin = 0;
  stage.tuck = 0;
  assert.ok(stage.settled || stage.mirror === 1);
});

test('drawing a frame reuses its lists of points: nothing new is allocated as he moves', () => {
  const rig = mediumRig();
  const stage = new Stage(rig, null);
  stage.look = new HeroLook('x', 'web', { hang: countingPicture('hang') });
  const first = stage.sampleRope();
  const copy = first.map((q) => ({ ...q }));
  rig.kick(2, 1);
  run(rig, 0.2);
  stage.draw(fakeContext());
  const again = stage.sampleRope();
  assert.equal(again, first, 'the same list');
  assert.ok(again.some((q, i) => q.x !== copy[i].x), 'with new points');
  stage.letGoWeb();
  assert.notEqual(stage.letGo.line, again, 'the web he let go of keeps its own copy');
});

// ---- Heroes ----------------------------------------------------------------------------------

test('hero.json: comments, trailing commas, grip, tilt and face', () => {
  const home = tempHome();
  const heroes = require(path.join(D, 'lib/heroes.js'));
  const dir = path.join(home, 'Test hero');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hang.png'), fixtures.person([255, 0, 0, 255]).png());
  fs.writeFileSync(path.join(dir, 'Swing.PNG'), fixtures.person([0, 0, 255, 255]).png());
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a picture');
  fs.writeFileSync(path.join(dir, 'hero.json'), `{
    // a comment
    "line": "none", /* another */
    "poses": { "Hang": { "tilt": -7, "faceSize": 40, "points": { "grip": [1, 2], "face": [3, 4], } }, "swing": { "faces": "left" } },
  }`);
  const hero = heroes.readFolder(dir);
  assert.deepEqual(Object.keys(hero.poses).sort(), ['hang', 'swing']);
  assert.ok(hero.usable);
  assert.equal(hero.line, 'none');
  assert.deepEqual(hero.poseSettings.hang, { grip: { x: 1, y: 2 }, face: { x: 3, y: 4 }, hand: null, tilt: -7, faceSize: 40, faces: null, file: null });
  assert.equal(hero.poseSettings.swing.faces, -1);
});

test('hero.json: a pose can borrow a picture from another hero folder, never from outside them', () => {
  const home = tempHome();
  const heroes = require(path.join(D, 'lib/heroes.js'));
  const root = path.join(home, 'heroes');
  for (const name of ['Lender', 'Borrower']) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'Lender', 'hang.png'), fixtures.person([255, 0, 0, 255]).png());
  fs.writeFileSync(path.join(home, 'outside.png'), fixtures.person([0, 0, 255, 255]).png());
  fs.writeFileSync(path.join(root, 'Borrower', 'hero.json'), JSON.stringify({ poses: {
    hang: { file: '../Lender/hang.png', points: { hand: [5, 6] } },
    swing: { file: '../../outside.png' },
    fly: { file: '../Lender/missing.png' },
  } }));
  const hero = heroes.readFolder(path.join(root, 'Borrower'));
  assert.deepEqual(Object.keys(hero.poses), ['hang']);
  assert.equal(hero.poses.hang.file, path.join(root, 'Lender', 'hang.png'));
  assert.deepEqual(hero.poseSettings.hang.hand, { x: 5, y: 6 });
  assert.ok(hero.usable);
});

test('the heroes ship with the app, each with its face and hand marked', () => {
  tempHome(); // no heroes of the user's own
  const heroes = require(path.join(D, 'lib/heroes.js'));
  const list = heroes.refresh();
  if (list.length === 0) {
    return; // a checkout without the pictures
  }
  assert.deepEqual(list.map((h) => h.name), ['Animated Spidey - Web Swing', 'Comic Spidey - Web Swing', 'Iconic Spidey - Both',
    'Iconic Spidey - Upside Down', 'Iconic Spidey - Web Swing', 'Iron Spider - Web Swing']);
  for (const hero of list) {
    assert.ok(hero.usable, hero.name);
    for (const [pose, { file }] of Object.entries(hero.poses)) {
      const settings = hero.poseSettings[pose];
      assert.ok(settings && settings.face && settings.hand, `${hero.name} ${pose}: face and hand`);
      assert.ok(file.endsWith('.webp') && fs.existsSync(file), `${hero.name} ${pose}: ${file}`);
    }
  }
  const both = heroes.find('iconic spidey - both');
  assert.deepEqual(Object.keys(both.poses).sort(), ['hang', 'swing']);
  assert.equal(both.poses.hang.file, heroes.find('Iconic Spidey - Upside Down').poses.hang.file, 'borrowed, not a copy');
  assert.equal(both.poses.swing.file, heroes.find('Iconic Spidey - Web Swing').poses.hang.file, 'borrowed, not a copy');
  for (const name of ['Iconic Spidey - Web Swing', 'Iron Spider - Web Swing', 'Animated Spidey - Web Swing', 'Comic Spidey - Web Swing']) {
    assert.ok(heroes.find(name).poseSettings.hang.grip, `${name} is held by his fist`);
    assert.ok([-1, 1].includes(heroes.find(name).poseSettings.hang.faces), `${name} says which way he faces`);
  }
  assert.equal(heroes.find('Iron Spider - Web Swing').poseSettings.hang.faces, 1);
  assert.equal(both.poseSettings.swing.faces, -1);
  assert.equal(heroes.find('nobody'), null);
  assert.equal(heroes.scan(), list, 'read once, then kept');
});

// ---- Settings --------------------------------------------------------------------------------

test('settings: defaults, saving, sizes', () => {
  const home = tempHome();
  const { Settings } = require(path.join(D, 'lib/settings.js'));
  const s = Settings.load();
  assert.equal(s.Hero, 'Iconic Spidey - Upside Down');
  assert.equal(s.StartAutomatically, true);
  assert.equal(s.bodyLength, 150);
  s.Size = 'Large';
  s.Rope = 'Long';
  s.AnchorFraction = 0.3;
  s.save();
  const again = Settings.load();
  assert.equal(again.bodyLength, 200);
  assert.equal(again.ropeFraction, 0.42);
  assert.equal(again.AnchorFraction, 0.3);
});

test('settings: a byte-order mark is tolerated, old keys are dropped, and a broken file means defaults', () => {
  const home = tempHome();
  const { Settings } = require(path.join(D, 'lib/settings.js'));
  fs.writeFileSync(path.join(home, 'settings.json'), '\uFEFF{ "AnchorFraction": 0.5, "Size": "Small", "Hero": "My picture", "ImageFile": "C:\\\\x\\\\figure.png" }');
  const s = Settings.load();
  assert.equal(s.Hero, 'My picture');
  assert.equal(s.Size, 'Small');
  assert.equal(s.ImageFile, undefined, 'settings from older versions are left behind');
  fs.writeFileSync(path.join(home, 'settings.json'), '{ broken');
  assert.equal(Settings.load().Hero, 'Iconic Spidey - Upside Down', 'a broken file means defaults');
});

// ---- Starting at sign-in ---------------------------------------------------------------------

test('Windows: the Run value is added, left alone when right, and removed', () => {
  tempHome();
  const startup = require(path.join(D, 'lib/startup.js'));
  let value = null;
  const calls = [];
  const reg = (args) => {
    calls.push(args[0]);
    if (args[0] === 'query') {
      if (value === null) throw new Error('not found');
      return `\r\nHKEY_CURRENT_USER\\...\\Run\r\n    Spidey Hang    REG_SZ    ${value}\r\n`;
    }
    if (args[0] === 'add') value = args[args.indexOf('/d') + 1];
    if (args[0] === 'delete') value = null;
    return '';
  };
  const launch = { exe: 'C:\\Users\\A B\\AppData\\Local\\Programs\\spidey-hang\\Spidey Hang.exe', args: ['--at-login'] };
  startup.sync(true, launch, { platform: 'win32', reg });
  assert.equal(value, '"C:\\Users\\A B\\AppData\\Local\\Programs\\spidey-hang\\Spidey Hang.exe" --at-login');
  startup.sync(true, launch, { platform: 'win32', reg });
  assert.deepEqual(calls, ['query', 'add', 'query'], 'no second write when already right');
  startup.sync(false, launch, { platform: 'win32', reg });
  assert.equal(value, null);
});

test('macOS: a LaunchAgent is written with escaped paths, and removed', () => {
  const home = tempHome();
  const startup = require(path.join(D, 'lib/startup.js'));
  const launch = { exe: '/Users/a&b/Applications/Spidey Hang.app/Contents/MacOS/Spidey Hang', args: ['--at-login'] };
  startup.sync(true, launch, { platform: 'darwin', home });
  const file = path.join(home, 'Library', 'LaunchAgents', 'com.spideyhang.overlay.plist');
  const plist = fs.readFileSync(file, 'utf8');
  assert.match(plist, /<string>\/Users\/a&amp;b\/Applications\/Spidey Hang\.app\/Contents\/MacOS\/Spidey Hang<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  startup.sync(false, launch, { platform: 'darwin', home });
  assert.ok(!fs.existsSync(file));
});

test('Linux: an autostart entry is written and removed', () => {
  const home = tempHome();
  const startup = require(path.join(D, 'lib/startup.js'));
  startup.sync(true, { exe: '/opt/e lectron', args: ['/home/u/app', '--at-login'] }, { platform: 'linux', home });
  const file = path.join(home, '.config', 'autostart', 'spidey-hang.desktop');
  assert.match(fs.readFileSync(file, 'utf8'), /Exec="\/opt\/e lectron" \/home\/u\/app --at-login/);
  startup.sync(false, { exe: 'x', args: [] }, { platform: 'linux', home });
  assert.ok(!fs.existsSync(file));
});

test('with SPIDEY_HANG_HOME set, sign-in entries stay inside it and the registry is never run', () => {
  const home = tempHome();
  const startup = require(path.join(D, 'lib/startup.js'));
  const launch = { exe: '/e', args: ['/a', '--at-login'] };
  startup.sync(true, launch, { platform: 'darwin' });
  assert.ok(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'com.spideyhang.overlay.plist')));
  startup.sync(true, launch, { platform: 'win32' }); // would throw if it tried to run reg.exe on this system
  assert.match(fs.readFileSync(path.join(home, 'log.txt'), 'utf8'), /test mode: the Windows registry is not touched/);
});

// ---- Command channel -------------------------------------------------------------------------

test('commands reach a listening overlay; nothing is sent when none is running', async () => {
  tempHome();
  const ipc = require(path.join(D, 'lib/ipc.js'));
  assert.equal(await ipc.send('ping', 300), false);
  const got = [];
  const server = await ipc.listen((line) => got.push(line));
  try {
    assert.equal(await ipc.send('push 1'), true);
    assert.equal(await ipc.send('image /a path/with spaces.png'), true);
    assert.equal(await ipc.send('x'.repeat(2000)), true);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(got, ['push 1', 'image /a path/with spaces.png'], 'over-long lines are dropped');
  } finally {
    server.close();
  }
});

test('a socket left behind by a crash is cleared on the next start', { skip: process.platform === 'win32' }, async () => {
  const home = tempHome();
  const ipc = require(path.join(D, 'lib/ipc.js'));
  fs.writeFileSync(path.join(home, 'spidey.sock'), '');
  const server = await ipc.listen(() => {});
  server.close();
});

test('reminders: water on the half hour, lunch at 3 PM, lunch wins when they meet', () => {
  const R = require(path.join(D, 'lib/reminders.js'));
  const at = (h, m, s = 0) => new Date(2026, 9, 13, h, m, s);
  const hm = (d) => `${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

  assert.equal(hm(R.nextHalfHour(at(10, 17))), '13 10:30');
  assert.equal(hm(R.nextHalfHour(at(10, 30))), '13 11:00');
  assert.equal(hm(R.nextHalfHour(at(23, 45))), '14 0:00');
  assert.equal(hm(R.nextDaily(at(14, 59), 15, 0)), '13 15:00');
  assert.equal(hm(R.nextDaily(at(15, 0), 15, 0)), '14 15:00');

  const both = { water: true, lunch: true };
  assert.deepEqual(R.nextReminder(at(14, 40), both), { kind: 'lunch', at: at(15, 0) });
  assert.deepEqual(R.nextReminder(at(15, 0, 1), both), { kind: 'water', at: at(15, 30) });
  assert.deepEqual(R.nextReminder(at(14, 40), { water: true, lunch: false }), { kind: 'water', at: at(15, 0) });
  assert.deepEqual(R.nextReminder(at(16, 0), { water: false, lunch: true }), { kind: 'lunch', at: new Date(2026, 9, 14, 15, 0) });
  assert.equal(R.nextReminder(at(16, 0), { water: false, lunch: false }), null);
});

test('reminders: the clock fires when due and skips one missed while asleep', (t) => {
  const R = require(path.join(D, 'lib/reminders.js'));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = new Date(2026, 9, 13, 14, 59, 30).getTime();
  const shown = [];
  const clock = new R.ReminderClock(() => ({ water: true, lunch: true }), (r) => shown.push(r.kind), () => new Date(now));
  clock.start();
  now += 30 * 1000;
  t.mock.timers.tick(30 * 1000);
  assert.deepEqual(shown, ['lunch']);

  // Asleep from 15:00 to 15:45: the 15:30 water reminder is late by 15 minutes and is skipped.
  now += 45 * 60 * 1000;
  t.mock.timers.tick(60 * 1000);
  assert.deepEqual(shown, ['lunch']);
  assert.equal(clock.next.items[0].kind, 'water');
  assert.equal(new Date(clock.next.at).getMinutes(), 0);
  clock.stop();
});

test('after a build, the unpacked app for this system is found to start', () => {
  const { findBuiltApp } = require(path.join(__dirname, '..', 'scripts', 'dist.js'));
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'spidey-dist-'));
  const touch = (...parts) => {
    const file = path.join(dist, ...parts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    return file;
  };
  assert.equal(findBuiltApp(dist, 'win32', 'x64'), null);
  const exe = touch('win-unpacked', 'Spidey Hang.exe');
  assert.equal(findBuiltApp(dist, 'win32', 'x64'), exe);

  const macBin = ['Spidey Hang.app', 'Contents', 'MacOS', 'Spidey Hang'];
  const intel = touch('mac', ...macBin);
  assert.equal(findBuiltApp(dist, 'darwin', 'arm64'), null);
  assert.equal(findBuiltApp(dist, 'darwin', 'x64'), intel);
  const arm = touch('mac-arm64', ...macBin);
  assert.equal(findBuiltApp(dist, 'darwin', 'arm64'), arm);
  assert.equal(findBuiltApp(dist, 'darwin', 'x64'), intel);

  assert.equal(findBuiltApp(dist, 'linux', 'x64'), null);
  const linuxExe = touch('linux-unpacked', 'spidey-hang');
  assert.equal(findBuiltApp(dist, 'linux', 'x64'), linuxExe);
});

test('Linux: the mouse shape covers what is drawn, grown by the padding, and nothing else', () => {
  const { rectsFromAlpha } = require(path.join(D, 'renderer/shared/shape.js'));
  const cols = 20;
  const rows = 10;
  const alpha = new Uint8ClampedArray(cols * rows * 4);
  const ink = (c, r) => (alpha[(r * cols + c) * 4 + 3] = 40);
  assert.deepEqual(rectsFromAlpha(alpha, cols, rows, 8, 1), [], 'nothing drawn, nothing covered');

  // A 2x3 block of cells, padded by one cell all round: one rectangle, 4 cells wide and 5 tall.
  for (let r = 3; r < 6; r++) {
    ink(5, r);
    ink(6, r);
  }
  assert.deepEqual(rectsFromAlpha(alpha, cols, rows, 8, 1), [{ x: 32, y: 16, width: 32, height: 40 }]);

  // A second mark far away is a second rectangle, and padding stops at the window edge.
  ink(19, 0);
  const rects = rectsFromAlpha(alpha, cols, rows, 8, 1);
  assert.equal(rects.length, 2);
  assert.deepEqual(rects.find((r) => r.x === 144), { x: 144, y: 0, width: 16, height: 16 });

  // Every inked cell is inside a rectangle, and every rectangle is inside the window.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (alpha[(r * cols + c) * 4 + 3] > 0) {
        assert.ok(rects.some((q) => c * 8 >= q.x && c * 8 < q.x + q.width && r * 8 >= q.y && r * 8 < q.y + q.height), `cell ${c},${r}`);
      }
    }
  }
  for (const q of rects) {
    assert.ok(q.x >= 0 && q.y >= 0 && q.x + q.width <= cols * 8 && q.y + q.height <= rows * 8);
  }
  // Standing still it grows by the usual padding; moving fast, by more, up to a limit.
  const { padCells, PAD, MAX_PAD } = require(path.join(D, 'renderer/shared/shape.js'));
  assert.equal(padCells(0), PAD);
  assert.ok(padCells(25) > padCells(5));
  assert.equal(padCells(10000), MAX_PAD);
});

test('Linux: a Wayland desktop starts again under X11, once; X11 desktops and other systems never do', () => {
  const { needsX11Restart, X11_SWITCH } = require(path.join(D, 'lib/linux.js'));
  const argv = ['/opt/Spidey Hang/spidey-hang', '--at-login'];
  const wayland = { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland' };
  assert.equal(needsX11Restart('linux', wayland, argv), true);
  assert.equal(needsX11Restart('linux', { DISPLAY: ':0', XDG_SESSION_TYPE: 'wayland' }, argv), true);
  assert.equal(needsX11Restart('linux', { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }, argv), true);
  // Already restarted (or started from the app menu, which passes the switch).
  assert.equal(needsX11Restart('linux', wayland, [...argv, X11_SWITCH]), false);
  // An X11 desktop, or Wayland with no XWayland to fall back on.
  assert.equal(needsX11Restart('linux', { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' }, argv), false);
  assert.equal(needsX11Restart('linux', { WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland' }, argv), false);
  assert.equal(needsX11Restart('win32', wayland, argv), false);
  assert.equal(needsX11Restart('darwin', wayland, argv), false);
});

test('custom reminders: messages, times and days are cleaned, broken ones dropped', () => {
  const R = require(path.join(D, 'lib/reminders.js'));
  assert.equal(R.cleanCustom({ text: '   ' }), null);
  assert.equal(R.cleanCustom('stretch'), null);
  assert.deepEqual(R.cleanCustom({ id: 'a1', text: '  Stand   up ', type: 'daily', time: '7:05', days: [5, 1, 1, 9], on: false }),
    { id: 'a1', text: 'Stand up', type: 'daily', time: '07:05', days: [1, 5], on: false, style: 'bubble' });
  assert.equal(R.cleanCustom({ text: 'x', style: 'web' }).style, 'web');
  assert.equal(R.cleanCustom({ text: 'x', type: 'every', style: 'web' }).style, 'web');
  assert.equal(R.cleanCustom({ text: 'x', style: 'fireworks' }).style, 'bubble');
  assert.equal(R.cleanCustom({ text: 'x', time: '25:00' }).time, '09:00');
  assert.deepEqual(R.cleanCustom({ text: 'x', days: [] }).days, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(R.cleanCustom({ text: 'x', type: 'every', minutes: 1 }).minutes, R.MIN_EVERY);
  assert.equal(R.cleanCustom({ text: 'x', type: 'every', minutes: 99999 }).minutes, R.MAX_EVERY);
  assert.equal(R.cleanCustom({ text: 'x'.repeat(500) }).text.length, R.MAX_TEXT);
  assert.match(R.cleanCustom({ id: 'bad id!', text: 'x' }).id, /^[A-Za-z0-9_-]+$/);

  const list = R.cleanCustomList([{ id: 'same', text: 'a' }, { id: 'same', text: 'b' }, null, { text: '' }]);
  assert.equal(list.length, 2);
  assert.notEqual(list[0].id, list[1].id);
  assert.deepEqual(R.cleanCustomList('nope'), []);
  assert.equal(R.cleanCustomList(Array.from({ length: 80 }, (_, i) => ({ text: 'r' + i }))).length, R.MAX_CUSTOM);
});

test('custom reminders: daily at a time, every N minutes from midnight, only on chosen days', () => {
  const R = require(path.join(D, 'lib/reminders.js'));
  // 13 October 2026 is a Tuesday.
  const at = (d, h, m) => new Date(2026, 9, d, h, m);
  const daily = R.cleanCustom({ text: 'Standup', type: 'daily', time: '10:30' });
  assert.deepEqual(R.nextCustom(at(13, 9, 0), daily), at(13, 10, 30));
  assert.deepEqual(R.nextCustom(at(13, 10, 30), daily), at(14, 10, 30));

  // Weekdays only: from Friday afternoon the next one is Monday.
  const weekdays = { ...daily, days: [1, 2, 3, 4, 5] };
  assert.deepEqual(R.nextCustom(at(16, 12, 0), weekdays), at(19, 10, 30));

  const every = R.cleanCustom({ text: 'Stretch', type: 'every', minutes: 45 });
  assert.deepEqual(R.nextCustom(at(13, 10, 0), every), at(13, 10, 30));
  assert.deepEqual(R.nextCustom(at(13, 10, 30), every), at(13, 11, 15));
  // The last one of the day, then it starts again at midnight.
  assert.deepEqual(R.nextCustom(at(13, 23, 10), every), at(13, 23, 15));
  assert.deepEqual(R.nextCustom(at(13, 23, 20), every), at(14, 0, 0));
  // Only on Sundays: from Tuesday, the first is Sunday at midnight.
  assert.deepEqual(R.nextCustom(at(13, 9, 0), { ...every, days: [0] }), at(18, 0, 0));
});

test('custom reminders: due together with water or lunch, all are shown; switched off ones never', () => {
  const R = require(path.join(D, 'lib/reminders.js'));
  const at = (h, m) => new Date(2026, 9, 13, h, m);
  const stretch = R.cleanCustom({ id: 's', text: 'Stretch', type: 'every', minutes: 60 });
  const standup = R.cleanCustom({ id: 'u', text: 'Standup', type: 'daily', time: '10:15' });

  let next = R.nextReminders(at(10, 5), { water: true, lunch: true, custom: [stretch, standup] });
  assert.deepEqual(next, { at: at(10, 15), items: [{ kind: 'custom', text: 'Standup', id: 'u', style: 'bubble' }] });

  next = R.nextReminders(at(10, 40), { water: true, lunch: true, custom: [stretch, standup] });
  assert.deepEqual(next.at, at(11, 0));
  assert.deepEqual(next.items.map((i) => i.text), [R.TEXT.water, 'Stretch']);

  // At 3 PM lunch still replaces water, and the custom one comes too.
  next = R.nextReminders(at(14, 40), { water: true, lunch: true, custom: [stretch] });
  assert.deepEqual(next.items.map((i) => i.kind), ['lunch', 'custom']);

  next = R.nextReminders(at(10, 5), { water: false, lunch: false, custom: [{ ...standup, on: false }] });
  assert.equal(next, null);
  assert.deepEqual(R.nextReminder(at(10, 5), { water: false, lunch: false, custom: [standup] }), { kind: 'custom', at: at(10, 15) });
});

test('custom reminders: described in words, and the clock shows every one that is due', (t) => {
  const R = require(path.join(D, 'lib/reminders.js'));
  assert.equal(R.describeCustom({ type: 'every', minutes: 45, days: [0, 1, 2, 3, 4, 5, 6] }), 'Every 45 minutes');
  assert.equal(R.describeCustom({ type: 'every', minutes: 60, days: [1, 2, 3, 4, 5] }), 'Every hour on weekdays');
  assert.equal(R.describeCustom({ type: 'every', minutes: 120, days: [0, 6] }), 'Every 2 hours on weekends');
  assert.match(R.describeCustom({ type: 'daily', time: '10:30', days: [0, 1, 2, 3, 4, 5, 6] }), /^Every day at .*10.30/);
  assert.match(R.describeCustom({ type: 'daily', time: '08:00', days: [1, 3] }), /^On Mon, Wed at /);

  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = new Date(2026, 9, 13, 10, 59, 30).getTime();
  const shown = [];
  const custom = [R.cleanCustom({ text: 'Stretch', type: 'every', minutes: 30 })];
  const clock = new R.ReminderClock(() => ({ water: true, lunch: false, custom }), (r) => shown.push(r.text), () => new Date(now));
  clock.start();
  now += 30 * 1000;
  t.mock.timers.tick(30 * 1000);
  assert.deepEqual(shown, [R.TEXT.water, 'Stretch']);
  clock.stop();
});

test('a reminder shows as a big web only while he is taken down and it asks for one', () => {
  const R = require(path.join(D, 'lib/reminders.js'));
  assert.equal(R.reminderRoute({ down: true, style: 'web' }), 'web');
  assert.equal(R.reminderRoute({ down: true, style: 'bubble' }), 'bubble');
  assert.equal(R.reminderRoute({ down: true }), 'bubble', 'water, lunch and old reminders');
  assert.equal(R.reminderRoute({ down: false, style: 'web' }), 'bubble', 'while he is up, always the bubble');
  assert.equal(R.reminderRoute({ down: false, style: 'bubble' }), 'bubble');
});

test('settings: "taken down" starts off, is kept, and a wrong type in the file is ignored', () => {
  tempHome();
  const { Settings } = require(path.join(D, 'lib/settings.js'));
  const s = new Settings();
  assert.equal(s.Down, false);
  s.Down = true;
  s.save();
  assert.equal(Settings.load().Down, true);
  fs.writeFileSync(path.join(process.env.SPIDEY_HANG_HOME, 'settings.json'), JSON.stringify({ Down: 'yes' }));
  assert.equal(Settings.load().Down, false);
});

test('settings: custom reminders are saved, and broken ones in the file are dropped', () => {
  tempHome();
  const { Settings, DEFAULTS } = require(path.join(D, 'lib/settings.js'));
  const s = new Settings();
  assert.deepEqual(s.CustomReminders, []);
  s.CustomReminders = [{ id: 'w', text: 'Water the plants', type: 'daily', time: '18:00', days: [6], on: true, style: 'web' }];
  s.save();
  assert.deepEqual(Settings.load().CustomReminders, s.CustomReminders);
  assert.deepEqual(DEFAULTS.CustomReminders, []);

  const raw = JSON.parse(fs.readFileSync(path.join(process.env.SPIDEY_HANG_HOME, 'settings.json'), 'utf8'));
  raw.CustomReminders = [{ text: '' }, { text: 'Ok', type: 'every', minutes: '30' }, 42];
  fs.writeFileSync(path.join(process.env.SPIDEY_HANG_HOME, 'settings.json'), JSON.stringify(raw));
  const loaded = Settings.load().CustomReminders;
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].minutes, 30);
  raw.CustomReminders = 'not a list';
  fs.writeFileSync(path.join(process.env.SPIDEY_HANG_HOME, 'settings.json'), JSON.stringify(raw));
  assert.deepEqual(Settings.load().CustomReminders, []);
});

/**
 * Sends Spidey from one side of a screen to the other, as the overlay does: laid out as main.js
 * applyLayout does, the window centred on his hand while he swings, then on his web. Records what
 * the eye would see, step by step.
 */
function swingAcross(screenW, screenH, body, ropeFraction, startFraction, push = 0) {
  const { Travel } = require(path.join(D, 'renderer/shared/travel.js'));
  const hang = body * 1.32;
  const rope = Math.min(Math.max(60, ropeFraction * screenH), Math.max(60, screenH - hang - 30));
  const reach = rope + hang;
  const width = Math.round(2 * reach + 40);
  let left = Math.round(screenW * startFraction - width / 2);
  const rig = new Rig();
  rig.random = () => 0.3;
  rig.build(width, Math.round(Math.min(screenH, reach + 30)), screenW * startFraction - left, rope, body);
  run(rig, 4);
  if (push) {
    rig.kick(push, 1);
    run(rig, 0.4);
  }
  const plan = Travel.plan(screenW * startFraction, { x: 0, width: screenW });
  const travel = new Travel(rig, plan.dir, plan.targetX, rope);
  travel.begin(left);
  const r = { plan, rope, catches: [], releases: [], maxStretch: 1, touched: false, bentSteps: 0, steps: 0,
    slowest: Infinity, jolt: 0, spin: 0, spinJolt: 0, doneAt: null, highest: Infinity, longestWeb: 0 };
  let t = 0;
  let before = null;
  while (t < 15) {
    rig.simulate(t, false, false, null, null);
    t += STEP;
    const event = travel.step(left);
    if (event && event.type === 'release') r.releases.push(t);
    const flip = travel.spinNow(1);
    if (flip.angle) {
      r.flipSteps = (r.flipSteps || 0) + 1;
      r.flipMost = Math.max(r.flipMost || 0, Math.abs(flip.angle));
      r.tuckMost = Math.max(r.tuckMost || 0, flip.tuck);
      r.flipDir = Math.sign(flip.angle);
    }
    if (event && event.type === 'catch') {
      r.catches.push({ ...event, t });
      r.longestWeb = Math.max(r.longestWeb, rig.ropeLength);
    }
    if (travel.done && r.doneAt === null) r.doneAt = t;
    const want = Math.round((travel.done ? left + rig.anchor.x : left + rig.ankle.x) - width / 2);
    rig.shiftEverything(left - want);
    left = want;
    r.touched = r.touched || rig.touching;
    r.highest = Math.min(r.highest, rig.ankle.y, rig.head.y);
    if (travel.done) continue;
    r.steps++;
    if (!rig.free) {
      r.maxStretch = Math.max(r.maxStretch, rig.ropeStretch);
      if (rig.bodyOffRopeEnd() > Math.PI / 3) r.bentSteps++;
    }
    // What the eye sees: his hand's speed, how suddenly it changes, and how fast his body turns.
    const now = {
      vx: (rig.ankle.x - rig.ankle.px) / STEP,
      vy: (rig.ankle.y - rig.ankle.py) / STEP,
      spin: Math.atan2(Math.sin(rig.bodyAngle - Math.atan2(rig.head.px - rig.ankle.px, rig.head.py - rig.ankle.py)),
        Math.cos(rig.bodyAngle - Math.atan2(rig.head.px - rig.ankle.px, rig.head.py - rig.ankle.py))) / STEP,
    };
    if (r.releases.length > 0 && (r.catches.length === 0 || !r.catches.at(-1).last)) {
      r.slowest = Math.min(r.slowest, now.vx * plan.dir);
    }
    if (before) {
      r.jolt = Math.max(r.jolt, Math.hypot(now.vx - before.vx, now.vy - before.vy) / STEP);
      r.spinJolt = Math.max(r.spinJolt, Math.abs(now.spin - before.spin) / STEP);
    }
    r.spin = Math.max(r.spin, Math.abs(now.spin));
    before = now;
  }
  r.endAnchor = left + rig.anchor.x;
  r.ropeLength = rig.ropeLength;
  r.motion = rig.motion();
  r.travelling = rig.travelling;
  return r;
}

test('swinging across: web to web to the other side, landing on the spot', () => {
  const setups = [[1470, 920, 150, 0.27, 0.88], [1920, 1050, 150, 0.27, 0.12], [1470, 920, 110, 0.15, 0.88],
    [2560, 1400, 200, 0.42, 0.88], [1470, 920, 150, 0.27, 0.88, 1.2], [1470, 920, 150, 0.27, 0.55]];
  for (const [w, h, body, rope, from, push] of setups) {
    const r = swingAcross(w, h, body, rope, from, push);
    const label = `${w}x${h} body ${body} rope ${rope} from ${from}${push ? ' already swinging' : ''}`;
    assert.ok(r.catches.length >= 1 && r.catches.length <= 6, `${label}: ${r.catches.length} webs`);
    assert.ok(r.catches.at(-1).last, label);
    assert.ok(Math.abs(r.endAnchor - r.plan.targetX) < 0.5, `${label}: ended at ${r.endAnchor}, wanted ${r.plan.targetX}`);
    assert.ok(r.releases[0] < 1.1, `${label}: first let go after ${r.releases[0].toFixed(2)} s`);
    assert.ok(r.catches.at(-1).t < 4, `${label}: took ${r.catches.at(-1).t.toFixed(1)} s`);
    // Equal hops, each one on: no short extra hop at the end.
    const hops = r.catches.map((c, i) => (c.anchorX - (i ? r.catches[i - 1].anchorX : w * from)) * r.plan.dir);
    assert.ok(Math.min(...hops) > 0.8 * Math.max(...hops), `${label}: hops ${hops.map(Math.round)}`);
    assert.ok(r.maxStretch < 1.02, `${label}: rope stretched ${r.maxStretch}`);
    assert.equal(r.touched, false, `${label}: hit the window edge`);
    assert.ok(r.bentSteps / r.steps < 0.05, `${label}: bent off the rope ${(100 * r.bentSteps / r.steps).toFixed(1)}% of the time`);
    assert.ok(Math.abs(r.ropeLength - r.rope) < 1, `${label}: rope ${r.ropeLength}`);
    assert.ok(r.doneAt !== null && r.doneAt < 7, `${label}: still travelling after ${r.doneAt} s`);
    assert.equal(r.travelling, false);
    assert.ok(r.motion < 0.5, `${label}: still moving ${r.motion}`);
  }
});

test('swinging across is smooth: he never stops between webs, and nothing jerks or whips round', () => {
  const setups = [[1470, 920, 150, 0.27, 0.88], [1920, 1050, 150, 0.27, 0.12], [1470, 920, 110, 0.15, 0.88],
    [2560, 1400, 200, 0.42, 0.88], [1470, 920, 150, 0.27, 0.88, 1.2]];
  for (const [w, h, body, rope, from, push] of setups) {
    const r = swingAcross(w, h, body, rope, from, push);
    const label = `${w}x${h} body ${body} rope ${rope} from ${from}${push ? ' already swinging' : ''}`;
    // Swinging and flying on, never stopping at the top of a swing to grab the next web.
    assert.ok(r.slowest > 150, `${label}: slowed to ${r.slowest.toFixed(0)} a second`);
    // A web catching him square to his path pulls no harder than the swing itself (gravity is 1800):
    // a jerk would show as one step's speed change far above this.
    assert.ok(r.jolt < 4 * 1800, `${label}: speed changed at ${r.jolt.toFixed(0)} a second per second`);
    // His body turns at most about a turn a second, and never starts or stops turning all at once.
    assert.ok(r.spin < 8, `${label}: body turned at ${(r.spin * 180 / Math.PI).toFixed(0)} degrees a second`);
    assert.ok(r.spinJolt < 150, `${label}: body spin changed at ${(r.spinJolt * 180 / Math.PI).toFixed(0)} degrees a second per second`);
  }
});

test('swinging across: right to left is the mirror image of left to right', () => {
  for (const [w, h, body, rope] of [[1470, 920, 150, 0.27], [2560, 1400, 200, 0.42], [1470, 920, 110, 0.15]]) {
    const right = swingAcross(w, h, body, rope, 0.12);
    const left = swingAcross(w, h, body, rope, 0.88);
    const label = `${w}x${h} body ${body} rope ${rope}`;
    assert.equal(right.plan.dir, 1);
    assert.equal(left.plan.dir, -1);
    assert.equal(left.catches.length, right.catches.length, `${label}: webs`);
    left.catches.forEach((c, i) => {
      // Mirrored about the middle of the screen, within a pixel and a step.
      assert.ok(Math.abs((w - c.anchorX) - right.catches[i].anchorX) < 1, `${label}: web ${i} at ${c.anchorX} vs ${right.catches[i].anchorX}`);
      assert.ok(Math.abs(c.t - right.catches[i].t) < 2 * STEP, `${label}: web ${i} at ${c.t} s vs ${right.catches[i].t} s`);
    });
    assert.equal(left.flipDir, -right.flipDir, `${label}: somersaults turn opposite ways`);
  }
});

test('swinging across: every other flight he somersaults, once round, tucked in, and done as the next web catches', () => {
  let flips = 0;
  for (const [w, h, body, rope, from] of [[1470, 920, 150, 0.27, 0.88], [1920, 1050, 150, 0.27, 0.12], [2560, 1400, 200, 0.42, 0.88]]) {
    const r = swingAcross(w, h, body, rope, from);
    const label = `${w}x${h} body ${body} rope ${rope} from ${from}`;
    if (!r.flipSteps) continue;
    flips++;
    assert.ok(r.flipMost > 1.9 * Math.PI && r.flipMost <= 2 * Math.PI + 1e-9, `${label}: turned ${r.flipMost}`);
    assert.ok(r.tuckMost > 0.95, `${label}: tucked ${r.tuckMost}`);
    // Forward, the way his swing turned him: going right, anticlockwise on the screen.
    assert.equal(r.flipDir, -r.plan.dir, label);
  }
  assert.ok(flips >= 2, `somersaulted on ${flips} trips`);
});

test('swinging across: a new web keeps his speed, letting go leaves the old web, and he goes the other way from the right half', () => {
  const { Travel } = require(path.join(D, 'renderer/shared/travel.js'));
  const rig = mediumRig();
  rig.kick(1.5, 1);
  run(rig, 0.3);
  const speed = rig.ankle.x - rig.ankle.px;
  const target = rig.anchor.x + 300;
  rig.reattach(target);
  assert.equal(rig.anchor.x, target);
  assert.ok(Math.abs(rig.ropeLength - Math.hypot(rig.ankle.x - target, rig.ankle.y - rig.anchor.y)) < 1e-6);
  assert.equal(rig.ankle.x - rig.ankle.px, speed);
  assert.ok(rig.ropeStretch < 1.0001);

  // In the air (his body turned by travel.js) the old web stays where it was and his hand flies
  // exactly as a thrown ball does, so travel.js can tell where to catch him.
  const web = rig.particles.slice(0, rig.ropeCount - 1).map((p) => ({ x: p.x, y: p.y }));
  rig.release();
  rig.travelling = true;
  rig.steered = true;
  const vx = rig.ankle.x - rig.ankle.px;
  const vy = rig.ankle.y - rig.ankle.py;
  rig.simulate(0, false, false, null, null);
  assert.deepEqual(rig.particles.slice(0, rig.ropeCount - 1).map((p) => ({ x: p.x, y: p.y })), web);
  assert.ok(Math.abs(rig.ankle.x - rig.ankle.px - vx) < 1e-9);
  assert.ok(Math.abs(rig.ankle.y - rig.ankle.py - (vy + 1800 * STEP * STEP)) < 1e-9);
  assert.equal(rig.pick({ x: web[3].x, y: web[3].y }), null);

  const work = { x: 0, width: 1000 };
  assert.deepEqual(Travel.plan(880, work), { dir: -1, targetX: 120 });
  assert.deepEqual(Travel.plan(300, work), { dir: 1, targetX: 880 });
});

test('swinging across never stalls: every size and rope, still or already swinging, both ways', () => {
  // A long rope on a small screen once needed one huge hop: he swung up to the top of the window,
  // stuck there, and hung about for up to 20 seconds. Already swinging, a steady push held him
  // tilted, barely moving; and letting go while nearly still once tied a web 3000 points away.
  const period = (rope) => 2 * Math.PI * Math.sqrt(rope / 1800);
  for (const [w, h] of [[1280, 720], [1470, 848]]) {
    for (const body of [110, 150, 200]) {
      for (const rope of [0.15, 0.27, 0.42]) {
        for (const from of [0.12, 0.88]) {
          for (const push of [0, 0.9, -0.9]) {
            const r = swingAcross(w, h, body, rope, from, push);
            const label = `${w}x${h} body ${body} rope ${rope} from ${from} push ${push}`;
            const swing = period(r.rope);
            assert.ok(r.doneAt !== null && Math.abs(r.endAnchor - r.plan.targetX) < 0.5, `${label}: did not arrive`);
            assert.ok(r.releases[0] < (push ? 1.25 : 0.8) * swing, `${label}: first let go after ${r.releases[0].toFixed(2)} s`);
            assert.ok(r.catches.at(-1).t - r.releases[0] < 0.75 * swing * r.catches.length, `${label}: slow hops`);
            assert.ok(r.highest > 25, `${label}: went up to ${r.highest.toFixed(0)} from the top`);
            assert.ok(r.longestWeb < 1.25 * r.rope, `${label}: a web ${r.longestWeb.toFixed(0)} long`);
            assert.ok(r.jolt < 4 * 1800 && r.spin < 8, `${label}: jolt ${r.jolt.toFixed(0)}, spin ${r.spin.toFixed(1)}`);
          }
        }
      }
    }
  }
});

// ---- Reminders you set, the focus timer, reactions, your own heroes ---------------------------

test('reminders: water every N minutes lines up with the clock, lunch at the time you pick', () => {
  const R = require(path.join(D, 'lib/reminders.js'));
  const at = (h, m) => new Date(2026, 9, 13, h, m);
  const hm = (d) => `${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  assert.equal(hm(R.nextWater(at(10, 17), 15)), '13 10:30');
  assert.equal(hm(R.nextWater(at(10, 17), 45)), '13 10:30');
  assert.equal(hm(R.nextWater(at(10, 30), 45)), '13 11:15');
  assert.equal(hm(R.nextWater(at(10, 17), 120)), '13 12:00');
  assert.equal(hm(R.nextWater(at(23, 50), 45)), '14 0:00', 'the day starts again at midnight');
  assert.equal(R.cleanWaterMinutes(5), 15);
  assert.equal(R.cleanWaterMinutes(500), 120);
  assert.equal(R.cleanWaterMinutes('x'), 30);

  const next = R.nextReminders(at(11, 50), { water: true, waterMinutes: 60, lunch: true, lunchTime: '12:00' });
  assert.deepEqual(next.items.map((i) => i.kind), ['lunch'], 'lunch wins when they meet');
  assert.equal(hm(R.nextReminders(at(12, 0), { water: false, lunch: true, lunchTime: '12:30' }).at), '13 12:30');
  assert.equal(hm(R.nextReminders(at(12, 0), { water: false, lunch: true, lunchTime: 'nonsense' }).at), '13 15:00');
});

test('reminders: times as people write them, and one-off reminders ("remind in 10 Tea is ready")', (t) => {
  const R = require(path.join(D, 'lib/reminders.js'));
  assert.equal(R.parseClock('9:05'), '09:05');
  assert.equal(R.parseClock('15:00'), '15:00');
  assert.equal(R.parseClock('3pm'), '15:00');
  assert.equal(R.parseClock('3:30 PM'), '15:30');
  assert.equal(R.parseClock('12am'), '00:00');
  assert.equal(R.parseClock('7'), null);
  assert.equal(R.parseClock('25:00'), null);
  const now = new Date(2026, 9, 13, 16, 0);
  assert.deepEqual(R.parseOnce('in 10 Tea is ready', now), { at: new Date(2026, 9, 13, 16, 10), text: 'Tea is ready' });
  assert.deepEqual(R.parseOnce('in 5 min stretch', now), { at: new Date(2026, 9, 13, 16, 5), text: 'stretch' });
  assert.deepEqual(R.parseOnce('at 3pm Call back', now), { at: new Date(2026, 9, 14, 15, 0), text: 'Call back' }, 'past today means tomorrow');
  assert.equal(R.parseOnce('in 0 nothing', now), null);
  assert.equal(R.parseOnce('in ten minutes', now), null);
  assert.equal(R.parseOnce('Tea is ready', now), null);

  // Shown when due, once, and one that came due while asleep is shown as soon as the clock looks.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = now.getTime();
  const once = [{ id: 'a', at: new Date(clock + 90000), text: 'Tea' }, { id: 'b', at: new Date(clock - 3600000), text: 'Missed' }];
  const shown = [];
  const reminderClock = new R.ReminderClock(() => ({ water: false, lunch: false, once }), (item) => {
    shown.push(item.text);
    once.splice(once.findIndex((o) => o.id === item.id), 1);
  }, () => new Date(clock));
  reminderClock.start();
  clock += 10;
  t.mock.timers.tick(10);
  assert.deepEqual(shown, ['Missed']);
  clock += 90000;
  t.mock.timers.tick(60000);
  t.mock.timers.tick(30000);
  assert.deepEqual(shown, ['Missed', 'Tea']);
  assert.equal(reminderClock.next, null, 'nothing left to show');
  reminderClock.stop();
});

test('focus timer: focus, short breaks, a long one every 4th, by the wall clock', () => {
  const { Focus, focusMessage } = require(path.join(D, 'lib/focus.js'));
  const f = new Focus(() => ({ focus: 25, short: 5, long: 15 }));
  const min = 60000;
  assert.equal(f.label(0), '');
  f.start(0);
  assert.equal(f.label(0), '25m');
  assert.equal(f.label(24 * min + 1), '1m');
  assert.equal(f.label(24.5 * min), '30s');
  assert.equal(f.nextTick(0), min, 'wakes once a minute');
  assert.equal(f.nextTick(24.5 * min), 1000, 'once a second in the last minute');
  assert.equal(f.update(10 * min), null);
  const seen = [];
  let t = 0;
  for (let i = 0; i < 8; i++) {
    t = f.endsAt;
    seen.push(f.update(t).next);
  }
  assert.deepEqual(seen, ['short', 'focus', 'short', 'focus', 'short', 'focus', 'long', 'focus']);
  assert.match(focusMessage({ ended: 'focus', next: 'short', minutes: 5 }), /5 minute break/);
  assert.match(focusMessage({ ended: 'focus', next: 'long', minutes: 15 }), /long break: 15/);
  assert.match(focusMessage({ ended: 'short', next: 'focus' }), /Back to it/);

  // Asleep for 3 hours: it lands in the right part, with one change reported.
  const g = new Focus(() => ({ focus: 25, short: 5, long: 15 }));
  g.start(0);
  const change = g.update(3 * 60 * min);
  assert.ok(change && g.endsAt > 3 * 60 * min && g.endsAt - 3 * 60 * min <= 25 * min);
  const phase = g.phase;
  const skipped = g.skip(g.endsAt - 1000);
  assert.equal(skipped.ended, phase);
  assert.notEqual(g.phase, phase);
  g.stop();
  assert.equal(g.running, false);
  assert.equal(g.skip(0), null);
  // A custom first length.
  g.start(0, 50);
  assert.equal(g.endsAt, 50 * min);
});

test('reactions: the first greeting of a day goes by the time of day, then "Welcome back!" and friends', () => {
  const X = require(path.join(D, 'lib/reactions.js'));
  const morning = new Date(2026, 9, 13, 9, 0);
  const first = X.greeting(morning, '2026-10-12');
  assert.deepEqual(first, { text: 'Good morning!', day: '2026-10-13' });
  assert.equal(X.greeting(new Date(2026, 9, 13, 14, 0), '').text, 'Good afternoon!');
  assert.equal(X.greeting(new Date(2026, 9, 13, 20, 0), '').text, 'Good evening!');
  const later = X.greeting(new Date(2026, 9, 13, 15, 0), '2026-10-13', () => 0);
  assert.equal(later.text, X.WELCOME[0]);
  assert.ok(X.WELCOME.includes(X.greeting(morning, '2026-10-13', () => 0.999).text));
});

test('reactions: a battery warning once below 20% and once below 10%, thanks when plugged in', () => {
  const { BatteryWatch } = require(path.join(D, 'lib/reactions.js'));
  const b = new BatteryWatch();
  const say = (level, charging = false) => b.report({ level, charging });
  assert.equal(say(0.5), null);
  assert.match(say(0.19), /19%/);
  assert.equal(say(0.18), null, 'once per drop');
  assert.equal(say(0.21), null);
  assert.equal(say(0.2), null, 'not again for wobbling around the line');
  assert.match(say(0.09), /9%.*Plug me in/);
  assert.equal(say(0.08), null);
  assert.equal(say(0.08, true), 'Thanks for the power-up!');
  assert.equal(say(0.5, true), null);
  assert.match(say(0.15), /15%/, 'warns again after charging');
  // A desktop with no battery reports "charging, 100%": never a word.
  const desk = new BatteryWatch();
  assert.equal(desk.report({ level: 1, charging: true }), null);
  assert.equal(desk.report({ level: 'x', charging: false }), null);
  // Already low when first seen: one warning, for the lower level.
  assert.match(new BatteryWatch().report({ level: 0.05, charging: false }), /Plug me in/);
});

test('antics: every kind comes up, never twice in a row, every 3 to 7 minutes', () => {
  const X = require(path.join(D, 'lib/reactions.js'));
  let seed = 1;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const seen = new Set();
  let last = null;
  for (let i = 0; i < 200; i++) {
    const a = X.pickAntic(random, last);
    assert.notEqual(a, last);
    seen.add(a);
    last = a;
    const delay = X.anticDelay(random);
    assert.ok(delay >= 3 * 60000 && delay <= 7 * 60000, String(delay));
  }
  assert.deepEqual([...seen].sort(), [...X.ANTICS].sort());
  assert.notEqual(X.pickLine(() => 0, X.LINES[0]), X.LINES[0]);
});

test('settings: the new choices have defaults, and numbers out of range are pulled back in', () => {
  tempHome();
  const { Settings } = require(path.join(D, 'lib/settings.js'));
  const s = new Settings();
  assert.equal(s.WaterMinutes, 30);
  assert.equal(s.LunchTime, '15:00');
  assert.deepEqual([s.FocusMinutes, s.ShortBreakMinutes, s.LongBreakMinutes], [25, 5, 15]);
  assert.deepEqual([s.Reactions, s.Antics, s.Sounds, s.Hotkeys, s.HideInFullScreen], [true, true, false, true, true]);
  assert.equal(s.IdleMinutes, 5);
  assert.equal(s.Display, '');
  fs.writeFileSync(path.join(process.env.SPIDEY_HANG_HOME, 'settings.json'),
    JSON.stringify({ WaterMinutes: 3, LunchTime: '12:30', FocusMinutes: 999, IdleMinutes: 0, Sounds: true, Display: 'pointer' }));
  const t = Settings.load();
  assert.deepEqual([t.WaterMinutes, t.LunchTime, t.FocusMinutes, t.IdleMinutes, t.Sounds, t.Display], [15, '12:30', 180, 2, true, 'pointer']);
  t.LunchTime = '1pm';
  t.save();
  assert.equal(Settings.load().LunchTime, '13:00');
});

test('your own heroes: a folder of yours, "(yours)", one replacing a bundled hero, and adding from a picture', () => {
  const home = tempHome();
  const heroes = require(path.join(D, 'lib/heroes.js'));
  const bundled = heroes.refresh().length;
  const dir = heroes.ensureUserDir();
  assert.equal(dir, path.join(home, 'heroes'));
  assert.ok(fs.readFileSync(path.join(dir, 'README.txt'), 'utf8').includes('hang.png'));
  const picture = path.join(home, 'Web Head.png');
  fs.writeFileSync(picture, fixtures.person([200, 30, 30, 255]).png());
  const added = heroes.addFromPicture(picture);
  assert.equal(added.name, 'Web Head');
  assert.equal(added.user, true);
  assert.ok(added.usable && fs.existsSync(path.join(dir, 'Web Head', 'hang.png')));
  assert.equal(heroes.addFromPicture(picture).name, 'Web Head 2', 'a taken name gets a number');
  assert.equal(heroes.scan().length, bundled + 2);
  assert.throws(() => heroes.addFromPicture(path.join(home, 'notes.txt')), /Not a picture/);
  if (bundled > 0) {
    const name = 'Iconic Spidey - Upside Down';
    fs.mkdirSync(path.join(dir, name));
    fs.copyFileSync(picture, path.join(dir, name, 'hang.png'));
    assert.equal(heroes.scan().find((h) => h.name === name).user, undefined, 'kept until reloaded');
    const mine = heroes.refresh().filter((h) => h.name === name);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].user, true);
    assert.equal(heroes.find(name).folderPath, path.join(dir, name));
  }
  assert.equal(heroes.heroNameFor('/a/My:Hero?.png'), 'My Hero');
  fs.rmSync(dir, { recursive: true });
  assert.equal(heroes.refresh().length, bundled);
});

test('web-swinging to a chosen spot: near or far, either way, he lands on it and hangs still', () => {
  const { Travel } = require(path.join(D, 'renderer/shared/travel.js'));
  for (const [from, to, ropeShare] of [[0.5, 0.6, 0.27], [0.5, 0.4, 0.15], [0.3, 0.45, 0.42], [0.88, 0.7, 0.27], [0.2, 0.9, 0.27]]) {
    const screenW = 1470;
    const rope = ropeShare * 920;
    const body = 150;
    const reach = rope + body * 1.32;
    const width = Math.round(2 * reach + 40);
    let left = Math.round(screenW * from - width / 2);
    const rig = new Rig();
    rig.build(width, Math.round(Math.min(920, reach + 30 + 0.32 * rope)), screenW * from - left, rope, body);
    run(rig, 2);
    const targetX = screenW * to;
    const travel = new Travel(rig, Math.sign(to - from), targetX, rope);
    travel.begin(left);
    let t = 0;
    while (t < 12) {
      rig.simulate(t, false, false, null, null);
      t += STEP;
      travel.step(left);
      const want = Math.round((travel.done ? left + rig.anchor.x : left + rig.ankle.x) - width / 2);
      rig.shiftEverything(left - want);
      left = want;
    }
    const label = `${from} to ${to}, rope ${ropeShare}`;
    assert.ok(travel.done, label);
    assert.ok(Math.abs(left + rig.anchor.x - targetX) < 0.5, `${label}: ended at ${left + rig.anchor.x}`);
    assert.ok(rig.motion() < 0.5, `${label}: still moving`);
  }
});

test('a bungee drop: the rope plays out longer, comes back, and he goes still again', () => {
  const rig = mediumRig();
  run(rig, 4);
  const base = rig.ropeLength;
  rig.ropeEase = 0.03;
  rig.ropeTarget = base + base / 3;
  run(rig, 0.7);
  assert.ok(rig.ropeLength > base * 1.3, `dropped to ${rig.ropeLength}`);
  assert.ok(rig.reeling === false || rig.ropeLength > base * 1.3);
  rig.ropeEase = 0.012;
  rig.ropeTarget = base;
  assert.equal(rig.reeling, true, 'not still while climbing back');
  run(rig, 6);
  assert.ok(Math.abs(rig.ropeLength - base) < 1, `back to ${rig.ropeLength}`);
  assert.equal(rig.reeling, false);
});
