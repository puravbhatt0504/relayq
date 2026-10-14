// Sound for the hill, synthesised with Web Audio, so there are no files to download. It stays silent
// until the viewer turns it on (browsers only allow audio after a click anyway).
/* global window, setTimeout */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function createSound() {
  let ctx = null, out = null, noise = null, on = false, paused = false, wind = null, rumble = null, gravel = null, clock = 0;
  const budget = { t: 0, n: 0 }; // one-shots per 100 ms, so a hundred landings don't turn into one roar

  function buffer(fill) {
    const b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    fill(b.getChannelData(0));
    return b;
  }
  function bed(buf, type, freq, q) { // a looping noise layer whose level follows the scene
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain(), p = ctx.createStereoPanner();
    s.buffer = buf; s.loop = true; f.type = type; f.frequency.value = freq; f.Q.value = q; g.gain.value = 0;
    s.connect(f).connect(g).connect(p).connect(out);
    s.start();
    return { f, g, p };
  }
  function init() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 5;
    out = ctx.createGain(); out.gain.value = 0;
    out.connect(comp).connect(ctx.destination);
    noise = buffer((d) => { for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; });
    const brown = buffer((d) => { let l = 0; for (let i = 0; i < d.length; i++) { l = (l + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = l * 3.5; } });
    wind = bed(brown, "bandpass", 420, 0.6);
    rumble = bed(brown, "lowpass", 150, 0.7);
    gravel = bed(noise, "bandpass", 1500, 0.9);
  }

  const env = (param, t, a, peak, d) => {
    param.setValueAtTime(0.0001, t);
    param.exponentialRampToValueAtTime(peak, t + a);
    param.exponentialRampToValueAtTime(0.0001, t + a + d);
  };
  function burst(t, dest, type, freq, q, a, d, peak) {
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noise; f.type = type; f.frequency.value = freq; f.Q.value = q;
    env(g.gain, t, a, peak, d);
    s.connect(f).connect(g).connect(dest);
    s.start(t, Math.random() * 1.5); s.stop(t + a + d + 0.05);
    return f;
  }
  function tone(t, dest, f0, f1, a, d, peak, type = "sine") {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + a + d);
    env(g.gain, t, a, peak, d);
    o.connect(g).connect(dest);
    o.start(t); o.stop(t + a + d + 0.05);
  }
  function shot(pan, vol, build) {
    if (!on || paused || vol < 0.01) return;
    const t = ctx.currentTime;
    if (t - budget.t > 0.1) { budget.t = t; budget.n = 0; }
    if (budget.n++ >= 6) return;
    const g = ctx.createGain(), p = ctx.createStereoPanner();
    g.gain.value = vol; p.pan.value = clamp(pan, -0.9, 0.9);
    g.connect(p).connect(out);
    build(t, g);
    setTimeout(() => { g.disconnect(); p.disconnect(); }, 3000);
  }

  return {
    get on() { return on; },
    toggle() {
      if (!ctx) init();
      on = !on;
      if (on) ctx.resume();
      out.gain.setTargetAtTime(on ? 0.9 : 0, ctx.currentTime, 0.08);
      return on;
    },
    pause(p) {
      if (!ctx || p === paused) return;
      paused = p;
      if (on) out.gain.setTargetAtTime(p ? 0 : 0.9, ctx.currentTime, 0.1);
    },
    // Called every frame: wind drifts on its own; rumble and gravel follow how much rock is rolling.
    update(dt, roll, pan) {
      if (!on || paused) return;
      clock += dt;
      const t = ctx.currentTime, gust = 0.5 + 0.5 * Math.sin(clock * 0.31) * Math.sin(clock * 0.13 + 1);
      wind.g.gain.setTargetAtTime(0.05 + 0.08 * gust, t, 0.6);
      wind.f.frequency.setTargetAtTime(300 + 260 * gust, t, 0.8);
      wind.p.pan.setTargetAtTime(Math.sin(clock * 0.07) * 0.5, t, 1);
      const r = clamp(roll / 6, 0, 1);
      rumble.g.gain.setTargetAtTime(r * 0.9, t, 0.12);
      rumble.f.frequency.setTargetAtTime(110 + r * 120, t, 0.2);
      gravel.g.gain.setTargetAtTime(r * 0.07 * (0.4 + Math.random() * 0.9), t, 0.015); // crackle
      rumble.p.pan.setTargetAtTime(clamp(pan, -0.8, 0.8), t, 0.2);
      gravel.p.pan.setTargetAtTime(clamp(pan, -0.8, 0.8), t, 0.2);
    },
    // A boulder hitting the ground; `s` is the impact speed in m/s.
    thud(s, pan, vol = 1) {
      const v = clamp(s / 14, 0, 1);
      shot(pan, (0.2 + 0.8 * v) * vol, (t, d) => {
        tone(t, d, 70 + 40 * v, 32, 0.004, 0.3 + 0.4 * v, 0.9);
        burst(t, d, "lowpass", 300 + 700 * v, 0.7, 0.003, 0.15 + 0.25 * v, 0.9);
        burst(t, d, "bandpass", 2400, 1.3, 0.001, 0.04, 0.3 * v + 0.02); // the crack of stone
      });
    },
    // Rock on rock.
    knock(s, pan) {
      const v = clamp(s / 4, 0, 1);
      shot(pan, 0.12 + 0.4 * v, (t, d) => {
        burst(t, d, "bandpass", 700 + Math.random() * 900, 4, 0.001, 0.06, 0.8);
        tone(t, d, 190 + Math.random() * 60, 130, 0.002, 0.08, 0.35, "triangle");
      });
    },
    // A boot on grass and grit.
    step(pan, vol) {
      shot(pan, 0.06 * vol, (t, d) => {
        burst(t, d, "bandpass", 1600 + Math.random() * 1400, 1.1, 0.004, 0.06 + Math.random() * 0.03, 1);
        burst(t, d, "lowpass", 260, 0.7, 0.003, 0.05, 0.5);
      });
    },
    // A rock getting away: grinding as it starts to roll back.
    slip(pan) {
      shot(pan, 0.55, (t, d) => {
        const f = burst(t, d, "bandpass", 700, 1.4, 0.06, 0.9, 0.7);
        f.frequency.exponentialRampToValueAtTime(160, t + 0.9);
        tone(t, d, 75, 42, 0.05, 0.7, 0.5);
      });
    },
    // A job that has used up its retries.
    dead(pan) {
      shot(pan, 0.4, (t, d) => {
        tone(t, d, 196, 98, 0.01, 0.7, 0.3, "triangle");
        tone(t + 0.02, d, 185, 92, 0.01, 0.7, 0.18, "triangle");
      });
    },
    // A delivery over the line: the flag snaps and a soft bell.
    chime(pan) {
      shot(pan, 0.32, (t, d) => {
        burst(t, d, "bandpass", 520, 0.8, 0.02, 0.3, 0.45);
        tone(t + 0.03, d, 659.25, 659.25, 0.01, 1.4, 0.32);
        tone(t + 0.12, d, 987.77, 987.77, 0.01, 1.2, 0.2);
        tone(t + 0.12, d, 1975.5, 1975.5, 0.005, 0.5, 0.04);
      });
    },
  };
}
