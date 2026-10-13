/*
 * The drawn Spider-Man (no image files).
 *
 * SpideyFigure.draw(ctx, armOffset, web) draws him upright in a 100-unit-tall space with his feet
 * at (0, 0) and his head at (0, -100). The caller turns and scales the canvas first.
 *   armOffset: how far the loose arms lag behind the swing (radians, about -0.7..0.7).
 *   web(alpha): returns the CSS colour of the web strands at that opacity.
 */
(function (root) {
  'use strict';

  const RED = '#c8202a';
  const BLUE = '#1f4a9a';
  const INK = '#0e0e14';
  const WHITE = '#f5f5f5';

  function draw(ctx, armOffset, web) {
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

    drawArm(-1, armOffset);
    drawArm(1, armOffset);
    drawLegs();
    drawTorso();
    drawHead();
    drawAnkleWrap();
  }

  const api = { draw };
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.SpideyFigure = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
