// Ambient sound, synthesised with Web Audio: nothing is loaded. A low drone whose pitch follows the scale you are at,
// a breath of filtered noise that opens up with speed, and a faint high shimmer close to things. Silent until asked.
let ctx = null, master, drone = [], droneGain, noiseFilter, noiseGain, shimmer = [], shimmerGain, on = false;
// root note per scale: Solar System, stellar neighbourhood, Milky Way, Local Group, cosmic web (falling fifths)
const ROOT = [110, 82.41, 65.41, 49, 36.71];

function build() {
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  master = ctx.createGain(); master.gain.value = 0;
  // a little space: two feedback delays into the output
  const wet = ctx.createGain(); wet.gain.value = 0.35;
  for (const [t, fb] of [[0.31, 0.45], [0.47, 0.38]]) { const d = ctx.createDelay(1), g = ctx.createGain(); d.delayTime.value = t; g.gain.value = fb; master.connect(d); d.connect(g); g.connect(d); d.connect(wet); }
  master.connect(ctx.destination); wet.connect(ctx.destination);
  // drone: root, a fifth and an octave, each slightly detuned against a twin so they beat slowly
  droneGain = ctx.createGain(); droneGain.gain.value = 0.16;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 0.4;
  for (const [ratio, det, g] of [[1, -4, 1], [1, 5, 1], [1.5, -3, 0.5], [2, 4, 0.35], [0.5, 0, 0.8]]) {
    const o = ctx.createOscillator(), og = ctx.createGain(); o.type = ratio < 1 ? 'sine' : 'triangle'; o.frequency.value = ROOT[0] * ratio; o.detune.value = det; og.gain.value = g;
    o.connect(og); og.connect(lp); o.start(); drone.push({ o, ratio });
  }
  lp.connect(droneGain); droneGain.connect(master);
  // noise: two seconds of white noise, looped, through a band-pass that speed sweeps upward
  const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = buf.getChannelData(0);
  let s = 12345; for (let i = 0; i < d.length; i++) { s = (s * 1664525 + 1013904223) | 0; d[i] = (s >>> 8) / 8388608 - 1; }
  const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
  noiseFilter = ctx.createBiquadFilter(); noiseFilter.type = 'bandpass'; noiseFilter.frequency.value = 180; noiseFilter.Q.value = 0.9;
  noiseGain = ctx.createGain(); noiseGain.gain.value = 0;
  src.connect(noiseFilter); noiseFilter.connect(noiseGain); noiseGain.connect(master); src.start();
  // shimmer: three high partials with their own slow tremolo
  shimmerGain = ctx.createGain(); shimmerGain.gain.value = 0;
  for (const [f, rate] of [[1318.5, 0.11], [1975.5, 0.17], [2637, 0.07]]) {
    const o = ctx.createOscillator(), g = ctx.createGain(), l = ctx.createOscillator(), lg = ctx.createGain();
    o.frequency.value = f; g.gain.value = 0.5; l.frequency.value = rate; lg.gain.value = 0.5; l.connect(lg); lg.connect(g.gain);
    o.connect(g); g.connect(shimmerGain); o.start(); l.start(); shimmer.push(o);
  }
  shimmerGain.connect(master);
}

// turn the sound on or off (must be called from a user gesture the first time)
export function setSound(want) {
  if (want && !ctx) { try { build(); } catch { return false; } }
  if (!ctx) return false;
  on = want;
  if (want) ctx.resume();
  master.gain.setTargetAtTime(want ? 0.55 : 0, ctx.currentTime, 0.6);
  return on;
}
// a few times a second: speed as a 0..1 measure of how fast the view is changing, scale 0..4, closeness 0..1
export function updateSound(speed, scale, close) {
  if (!on) return;
  const t = ctx.currentTime, root = ROOT[Math.max(0, Math.min(4, scale))];
  for (const d of drone) d.o.frequency.setTargetAtTime(root * d.ratio, t, 2.5);
  noiseFilter.frequency.setTargetAtTime(160 + 2200 * speed * speed, t, 0.4);
  noiseGain.gain.setTargetAtTime(0.02 + 0.22 * speed, t, 0.4);
  shimmerGain.gain.setTargetAtTime(0.012 * close, t, 1.2);
}
