// Ambient sound, synthesised with Web Audio: nothing is loaded. A low drone whose pitch follows the scale you are at,
// a breath of filtered noise that opens up with speed, and a faint high shimmer close to things. Over that, music
// that is composed as it plays and never repeats: slow chords that melt into one another and now and then a few
// bell notes, in a long reverberation. Its key follows the scale you are at.
let ctx = null, master, drone = [], droneGain, noiseFilter, noiseGain, shimmer = [], shimmerGain, on = false, volume = 0.7, engine = 1;
let out, meter, music, nextChord = 0, nextBell = 0, chordI = 0, seed = 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
// chords as semitones above the root, spread wide: I add 9, vi 7, IV maj 7, V sus, iii 7, IV add 9
const CHORDS = [[0, 7, 14, 16, 23], [-3, 4, 12, 16, 19], [5, 12, 16, 21, 28], [-5, 2, 9, 14, 19], [4, 11, 14, 19, 23], [-7, 0, 9, 12, 19]];
const BELLS = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];   // the major pentatonic, two octaves
// root note per scale: Solar System, stellar neighbourhood, Milky Way, Local Group, cosmic web (falling fifths)
const ROOT = [110, 82.41, 65.41, 49, 36.71];

function build() {
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  master = ctx.createGain(); master.gain.value = 0;
  // a little space: two feedback delays into the output
  const wet = ctx.createGain(); wet.gain.value = 0.35;
  for (const [t, fb] of [[0.31, 0.45], [0.47, 0.38]]) { const d = ctx.createDelay(1), g = ctx.createGain(); d.delayTime.value = t; g.gain.value = fb; master.connect(d); d.connect(g); g.connect(d); d.connect(wet); }
  // everything leaves through a gentle limiter, so a dense moment cannot clip
  out = ctx.createDynamicsCompressor(); out.threshold.value = -14; out.ratio.value = 6; out.attack.value = 0.02; out.release.value = 0.4;
  meter = ctx.createAnalyser(); meter.fftSize = 2048; out.connect(ctx.destination); out.connect(meter);
  master.connect(out); wet.connect(out);
  // drone: root, a fifth and an octave, each slightly detuned against a twin so they beat slowly
  droneGain = ctx.createGain(); droneGain.gain.value = 0.09;
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
  // music: its own bus into a long reverberation (an impulse of decaying noise, different in each ear)
  music = ctx.createGain(); music.gain.value = 0.9;
  const len = Math.floor(ctx.sampleRate * 5.5), ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) { const a = ir.getChannelData(c); for (let i = 0; i < len; i++) a[i] = (rnd() * 2 - 1) * Math.pow(1 - i / len, 3.2) * (i < 600 ? i / 600 : 1); }
  const rev = ctx.createConvolver(), revGain = ctx.createGain(); rev.buffer = ir; revGain.gain.value = 0.7;
  music.connect(rev); rev.connect(revGain); revGain.connect(master); music.connect(master);
}
const hz = (root, semi) => root * Math.pow(2, semi / 12);
// one chord: each note a pair of detuned voices through a soft low-pass, swelling for seconds and fading for longer
function chord(root, t) {
  const notes = CHORDS[chordI], hold = 15 + rnd() * 8;
  // move by a step or stay near: never the same chord twice
  chordI = (chordI + 1 + Math.floor(rnd() * 3)) % CHORDS.length;
  const lp = ctx.createBiquadFilter(), g = ctx.createGain(); lp.type = 'lowpass'; lp.frequency.value = 900; lp.Q.value = 0.3;
  lp.frequency.setValueAtTime(500, t); lp.frequency.linearRampToValueAtTime(1300, t + hold * 0.5); lp.frequency.linearRampToValueAtTime(450, t + hold + 9);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.11, t + 6); g.gain.setValueAtTime(0.11, t + hold); g.gain.linearRampToValueAtTime(0, t + hold + 10);
  lp.connect(g); g.connect(music);
  for (let k = 0; k < notes.length; k++) for (const det of [-6, 6]) {
    const o = ctx.createOscillator(), og = ctx.createGain(); o.type = k < 2 ? 'sine' : 'triangle'; o.frequency.value = hz(root, notes[k]); o.detune.value = det + (rnd() - 0.5) * 4;
    og.gain.value = k < 2 ? 0.9 : 0.45 / (1 + k * 0.25); o.connect(og); og.connect(lp); o.start(t); o.stop(t + hold + 10.5);
  }
  return hold;
}
// a bell: a sine with a faint inharmonic partial, struck and left to ring, somewhere between the ears
function bell(root, t, semi, amp) {
  const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain(), g = ctx.createGain(), f = hz(root * 4, semi);
  if (pan.pan) pan.pan.value = rnd() * 1.4 - 0.7;
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(amp, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0004, t + 5.5);
  for (const [m, a] of [[1, 1], [2.01, 0.22], [3.02, 0.06]]) { const o = ctx.createOscillator(), og = ctx.createGain(); o.frequency.value = f * m; og.gain.value = a; o.connect(og); og.connect(g); o.start(t); o.stop(t + 5.6); }
  g.connect(pan); pan.connect(music);
}

// turn the sound on or off (must be called from a user gesture the first time)
export function setSound(want) {
  if (want && !ctx) { try { build(); } catch { return false; } }
  if (!ctx) return false;
  on = want;
  if (want) ctx.resume();
  master.gain.setTargetAtTime(want ? 0.75 * volume : 0, ctx.currentTime, 0.6);
  if (want) { nextChord = Math.max(nextChord, ctx.currentTime + 0.3); nextBell = Math.max(nextBell, ctx.currentTime + 6); }
  return on;
}
// how loud the engine is (the drone and the rush of speed) against the music, 0..1
export function setEngine(v) { engine = v; }
// 0..1; takes effect at once when the sound is on
export function setVolume(v) { volume = v; if (ctx && on) master.gain.setTargetAtTime(0.75 * volume, ctx.currentTime, 0.1); }
// a few times a second: speed as a 0..1 measure of how fast the view is changing, scale 0..4, closeness 0..1
export function updateSound(speed, scale, close) {
  if (!on) return;
  const t = ctx.currentTime, root = ROOT[Math.max(0, Math.min(4, scale))];
  for (const d of drone) d.o.frequency.setTargetAtTime(root * d.ratio, t, 2.5);
  noiseFilter.frequency.setTargetAtTime(160 + 2200 * speed * speed, t, 0.4);
  noiseGain.gain.setTargetAtTime((0.02 + 0.22 * speed) * engine, t, 0.4);
  droneGain.gain.setTargetAtTime(0.09 * engine, t, 0.4);
  shimmerGain.gain.setTargetAtTime(0.012 * close, t, 1.2);
  // the music: the next chord begins as the last one starts to fade; bells come singly or in twos and threes, with
  // silences between
  if (t >= nextChord) nextChord = t + chord(root * 2, t + 0.1) - 3;
  if (t >= nextBell) {
    const n = rnd() < 0.45 ? 1 : rnd() < 0.6 ? 2 : 3; let at = t + 0.1, i = Math.floor(rnd() * BELLS.length);
    for (let k = 0; k < n; k++) { bell(root * 2, at, BELLS[i], 0.05 + rnd() * 0.04); at += 0.5 + rnd() * 0.9; i = Math.max(0, Math.min(BELLS.length - 1, i + Math.floor(rnd() * 5) - 2)); }
    nextBell = at + 3 + rnd() * 9;
  }
}
// peak of the last few hundredths of a second, 0..1 (for tests)
export function level() { if (!meter) return 0; const a = new Float32Array(meter.fftSize); meter.getFloatTimeDomainData(a); let m = 0; for (const v of a) m = Math.max(m, Math.abs(v)); return m; }
