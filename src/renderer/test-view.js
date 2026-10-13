'use strict';
/*
 * Offline test renders. Nothing appears on screen.
 *   snapshot       one frame of a hanging hero after some seconds, plus a log of his motion
 *   export-figure  the drawn figure, upright, on a transparent background
 */
(function () {
  const api = window.spidey;
  const { Rig, STEP, REACH_PAST_HEAD } = SH.rig;
  const { Stage, SILK, loadLook } = SH.stage;

  const web = (alpha) => `rgba(${SILK[0]}, ${SILK[1]}, ${SILK[2]}, ${alpha})`;
  const fixed = (n, digits, width) => n.toFixed(digits).padStart(width || 0);

  async function png(canvas) {
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
  }

  /** One hanging frame. Saved at 2 pixels per unit, so pictures are prepared at that density too. */
  async function snapshot(job) {
    const body = 150;
    const rope = 280;
    const reach = rope + body * (1 + REACH_PAST_HEAD);
    const width = 2 * reach + 40;
    const height = reach + 30;
    const rig = new Rig();
    rig.build(width, height, width / 2, rope, body);
    if (job.edge > 0) {
      rig.visibleRight = width / 2 + job.edge;
    }
    const stage = new Stage(rig, (c, arm) => SpideyFigure.draw(c, arm, web));
    if (job.look) {
      const problems = [];
      stage.look = await loadLook(job.look, body, 2, (m) => problems.push(m));
      if (problems.length > 0) {
        throw new Error(problems.join(' '));
      }
    }
    if (job.kick !== 0) {
      rig.kick(Math.abs(job.kick), Math.sign(job.kick));
    }
    let log = 'time  motion  pose  ropeAngleDegrees  bodyMinusRopeDegrees  ropeStretch  bodyAngleDegrees\n';
    let time = 0;
    while (time < job.seconds) {
      for (let i = 0; i < 4; i++) {
        rig.simulate(time, false, job.swing, null, null);
        time += STEP;
      }
      stage.advance(1 / 60);
      // One row per frame, so frame-to-frame jitter shows up in the log.
      const deg = 180 / Math.PI;
      log += `${fixed(time, 3, 5)}  ${rig.motion().toFixed(6)}  ${stage.currentPose}  ${fixed(rig.ropeAngle * deg, 3, 8)}  ${fixed((rig.bodyAngle - rig.ropeAngle) * deg, 3, 8)}  ${rig.ropeStretch.toFixed(4)}  ${fixed(rig.bodyAngle * deg, 3, 8)}\n`;
    }
    const canvas = new OffscreenCanvas(Math.round(width * 2), Math.round(height * 2));
    const c = canvas.getContext('2d');
    c.scale(2, 2);
    c.fillStyle = 'rgb(30, 30, 30)';
    c.fillRect(0, 0, width / 2, height);
    c.fillStyle = 'rgb(235, 235, 235)';
    c.fillRect(width / 2, 0, width / 2, height);
    stage.draw(c);
    return { bytes: await png(canvas), log };
  }

  /** The drawn figure, upright and large. */
  async function exportFigure() {
    const scale = 6;
    const width = 60 * scale;
    const height = 132 * scale;
    const canvas = new OffscreenCanvas(width, height);
    const c = canvas.getContext('2d');
    c.translate(width / 2, height - 8 * scale);
    c.scale(scale, scale);
    SpideyFigure.draw(c, 0, web);
    return { bytes: await png(canvas), log: '' };
  }

  api.on('test', async (job) => {
    try {
      const run = job.kind === 'snapshot' ? snapshot : exportFigure;
      const result = await run(job);
      api.send('test-done', { ok: true, bytes: result.bytes, log: result.log });
    } catch (err) {
      api.send('test-done', { ok: false, error: err.message });
    }
  });

  api.send('ready');
})();
