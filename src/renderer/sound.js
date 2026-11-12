'use strict';
/*
 * Sounds, made on the spot with Web Audio: no sound files.
 *   thwip   a web shooting out: a short burst of noise swept from high to low
 *   whoosh  a hard fling: a soft swell of noise rising and falling
 *
 * The audio engine is started only to play one and put to sleep (suspended) straight after, so it
 * costs nothing while he is quiet. Off unless Personality > Sounds is on.
 */
(function (root) {
  const SH = (root.SH = root.SH || {});

  let ctx = null;
  let noise = null;
  let sleepTimer = null;
  let lastPlay = 0;

  function engine() {
    if (!ctx) {
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) {
        return null;
      }
      ctx = new AC({ latencyHint: 'interactive' });
      // One second of white noise, made once and reused.
      noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        data[i] = Math.random() * 2 - 1;
      }
    }
    clearTimeout(sleepTimer);
    if (ctx.state === 'suspended') {
      ctx.resume();
    }
    return ctx;
  }

  /** Suspends the engine once the sound has played out. */
  function sleepAfter(seconds) {
    clearTimeout(sleepTimer);
    sleepTimer = setTimeout(() => ctx && ctx.state === 'running' && ctx.suspend(), seconds * 1000 + 300);
  }

  /** Noise through a band-pass filter whose centre and loudness follow the given curves. */
  function burst({ duration, from, to, q, peak, attack }) {
    const c = engine();
    if (!c) {
      return;
    }
    const t = c.currentTime + 0.01;
    const src = c.createBufferSource();
    src.buffer = noise;
    const filter = c.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = q;
    filter.frequency.setValueAtTime(from, t);
    filter.frequency.exponentialRampToValueAtTime(to, t + duration);
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(filter).connect(gain).connect(c.destination);
    src.start(t, Math.random() * 0.4, duration + 0.05);
    sleepAfter(duration);
  }

  /** Not more than one sound every 80 ms, so a burst of events never stacks up into a roar. */
  function allowed() {
    const now = performance.now();
    if (now - lastPlay < 80) {
      return false;
    }
    lastPlay = now;
    return true;
  }

  SH.sound = {
    enabled: false,
    thwip() {
      if (this.enabled && allowed()) {
        burst({ duration: 0.13, from: 5200, to: 900, q: 3.5, peak: 0.35, attack: 0.006 });
      }
    },
    whoosh(strength = 1) {
      if (this.enabled && allowed()) {
        burst({ duration: 0.45, from: 380, to: 1500, q: 0.9, peak: 0.12 + 0.12 * Math.min(1, strength), attack: 0.16 });
      }
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
