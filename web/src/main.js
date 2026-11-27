// Starhopper: start-up, the frame loop and the HUD
import { $, initGpu, GLOBALS_SIZE } from './gpu.js';
import { cam, basis, lookQuat, PC_LY, PC_AU, C_PC_S } from './camera.js';
import { flight, initInput, updateFlight, flyTo } from './flight.js';
import { quality, LEVEL, keep } from './quality.js';
import { initPoints } from './points.js';
import { initGalaxies } from './galaxies.js';
import { initPost } from './post.js';
import { initLines } from './lines.js';
import { initLabels } from './labels.js';
import { POSES, setPose } from './poses.js';

const body = document.body, canvas = $('c');
const params = new URLSearchParams(location.search);
let loaded = 0;
const say = (m, to) => { $('s').textContent = m; loaded = to; $('b').style.transform = `scaleX(${to})`; };

async function main() {
  keep('starhopperLoad', 1);
  document.querySelectorAll('#lv button').forEach((b) => {
    b.classList.toggle('on', +b.dataset.l === LEVEL);
    b.onclick = () => { keep('starhopper', b.dataset.l); location.reload(); };
  });
  say('Waking the graphics device', 0.1);
  const gpu = await initGpu(canvas), { device, queue } = gpu;
  gpu.device.lost.then((l) => {
    if (l.reason === 'destroyed') return;
    if (LEVEL < 2) { keep('starhopper', LEVEL + 1); location.reload(); }
    body.className = 'l e'; $('s').textContent = 'The graphics device was lost. Reload the page to try again.';
  });
  const globals = new ArrayBuffer(GLOBALS_SIZE), gf = new Float32Array(globals), gi = new Int32Array(globals);
  const globalsBuf = device.createBuffer({ size: GLOBALS_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const base = 'data/';
  say('Reading the star and galaxy indexes', 0.3);
  const [stars, galPts, gal] = await Promise.all([
    initPoints(gpu, globalsBuf, base + 'stars/', quality, { budget: quality.starBudget, track: true, magOff: 20, sigma0: 0.62 }),
    initPoints(gpu, globalsBuf, base + 'galaxies/', quality, { budget: 400_000, track: false, magOff: 40, sigma0: 1.0 }),
    initGalaxies(gpu, globalsBuf, base, quality)]);
  const post = initPost(gpu, quality);

  const state = { frozen: false, shot: null, snap: 1 };
  // ---- view state
  let resScale = quality.startScale, W = 0, H = 0, pxScale = 1;
  const resize = () => {
    const dpr = Math.min(devicePixelRatio || 1, 3);
    let s = dpr * resScale;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (cw * ch * s * s > quality.maxPixels) s = Math.sqrt(quality.maxPixels / (cw * ch));
    const w = Math.max(2, Math.round(cw * s)), h = Math.max(2, Math.round(ch * s));
    if (w === W && h === H) return;
    W = canvas.width = w; H = canvas.height = h; pxScale = w / cw;
    post.resize(W, H); gal.resize(W, H);
    if (gpu.offscreen) { offTex?.destroy(); offTex = device.createTexture({ size: [W, H], format: gpu.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }); offView = offTex.createView(); }
  };
  let offTex, offView;
  // test rigs: the current frame as a PNG data URL (works in ?offscreen mode, where nothing is presented)
  const capture = async () => {
    await new Promise((r) => { state.shot = r; });
    if (!gpu.offscreen) return canvas.toDataURL('image/png');
    const row = Math.ceil(W * 4 / 256) * 256, buf = device.createBuffer({ size: row * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder(); enc.copyTextureToBuffer({ texture: offTex }, { buffer: buf, bytesPerRow: row }, [W, H]); queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange()), c2 = document.createElement('canvas'); c2.width = W; c2.height = H;
    const g = c2.getContext('2d'), img = g.createImageData(W, H);
    for (let y = 0; y < H; y++) img.data.set(src.subarray(y * row, y * row + W * 4), y * W * 4);
    g.putImageData(img, 0, 0); buf.destroy();
    return c2.toDataURL('image/png');
  };
  new ResizeObserver(resize).observe(canvas); resize();

  // ---- names and constellation figures
  say('Reading names and constellations', 0.5);
  const [names, cons] = await Promise.all([fetch(base + 'names.json').then((r) => r.json()), fetch(base + 'constellations.json').then((r) => r.json())]);
  const lines = initLines(gpu, globalsBuf, 4096), labels = initLabels(gpu, globalsBuf, () => pxScale);
  const LG_CON = 0;
  for (const c of cons) {
    let cx = 0, cy = 0, cz = 0; const np = c.pts.length / 3;
    for (const l of c.lines) for (let k = 1; k < l.length; k++) { const a = l[k - 1] * 3, b = l[k] * 3; lines.add(c.pts[a], c.pts[a + 1], c.pts[a + 2], c.pts[b], c.pts[b + 1], c.pts[b + 2], 0.05, 0.085, 0.17, 0.5, LG_CON); }
    // label on the sky at the figure's mean direction, at a nominal 60 pc so it shifts as you move off
    for (let k = 0; k < np; k++) { const n = Math.hypot(c.pts[k * 3], c.pts[k * 3 + 1], c.pts[k * 3 + 2]) || 1; cx += c.pts[k * 3] / n; cy += c.pts[k * 3 + 1] / n; cz += c.pts[k * 3 + 2] / n; }
    const n = Math.hypot(cx, cy, cz) || 1;
    if (np) labels.add(c.name, 'con', cx / n * 60, cy / n * 60, cz / n * 60, NaN, Infinity, 0, 3.5);
  }
  for (const s of names.stars) if (s[0]) labels.add(s[0] === 'Sol' ? 'Sun' : s[0], 'star', s[2], s[3], s[4], s[5]);
  gal.names.forEach((n, i) => { if (n[1]) labels.add(n[0], 'galaxy', gal.pos(i, 0), gal.pos(i, 1), gal.pos(i, 2), gal.absmag(i), Infinity, gal.radius(i) * 1.2); });
  const show = { lines: true, names: true, proc: true };
  const labelLimit = { star: 0, con: 0, body: 0, deep: 0, galaxy: 0 };
  const kindGain = { star: 1, con: 1, body: 1, deep: 1, galaxy: 1 };

  // start at Earth's distance from the Sun, facing Orion with celestial north up
  setPose(+(params.get('pose') || 1) - 1);

  const magCap = +(params.get('mag') || 13);   // ?mag=6 caps the faintest star drawn (keeps software test rigs fast)
  let exposureBase = 32, exposure = 32, showPerf = false, hudT = 0;
  const E_THRESH = 0.0035 * 2 * Math.PI * 0.62 * 0.62;   // energy at which a star is culled (see stars.js)
  const E_MAX = 2 * Math.PI * 2.6 * 26 * 26;             // energy at which a star sprite stops growing

  initInput(canvas, (code) => {
    if (code === 'KeyH') { showPerf = !showPerf; $('perf').hidden = !showPerf; }
    else if (code === 'Home') flyTo(0, 0, 0, 1.2 / PC_AU, 6);
    else if (code === 'BracketRight') exposureBase = Math.min(4000, exposureBase * 1.25);
    else if (code === 'BracketLeft') exposureBase = Math.max(0.5, exposureBase / 1.25);
    else if (code === 'Equal') flight.throttle = Math.min(4, flight.throttle + 0.25);
    else if (code === 'Minus') flight.throttle = Math.max(-3, flight.throttle - 0.25);
    else if (code === 'Tab') body.classList.toggle('nohud');
    else if (code === 'KeyL') show.lines = !show.lines;
    else if (code === 'KeyN') show.names = !show.names;
    else if (code === 'KeyP') show.proc = !show.proc;
    else if (/^Digit[1-8]$/.test(code)) { setPose(+code[5] - 1); state.snap = 1; }
    else if (code === 'Unlocked' && !params.has('auto')) body.classList.remove('fly');
  });
  const launch = () => { body.classList.add('fly'); canvas.requestPointerLock?.()?.catch?.(() => {}); };
  $('go').onclick = launch;
  canvas.onclick = () => { if (body.classList.contains('fly') && !flight.locked) canvas.requestPointerLock?.()?.catch?.(() => {}); };
  $('menu').onclick = () => body.classList.remove('fly');

  const fmtDist = (pc) => {
    const au = pc * PC_AU, ly = pc * PC_LY;
    if (au < 0.1) return (au * 149597870.7).toFixed(0) + ' km';
    if (au < 2000) return au.toFixed(au < 10 ? 2 : 0) + ' AU';
    if (ly < 1000) return ly.toFixed(ly < 10 ? 2 : 1) + ' ly';
    if (ly < 1e6) return (ly / 1e3).toFixed(ly < 1e4 ? 2 : 1) + ' kly';
    if (ly < 1e9) return (ly / 1e6).toFixed(ly < 1e7 ? 2 : 1) + ' Mly';
    return (ly / 1e9).toFixed(2) + ' Gly';
  };
  const fmtSpeed = (v) => {
    const c = v / C_PC_S;
    const cs = c < 0.01 ? (c * 299792.458).toFixed(0) + ' km/s' : c < 100 ? c.toFixed(2) + ' c' : c < 1e6 ? c.toFixed(0) + ' c' : c.toExponential(2).replace('e+', '×10^') + ' c';
    const ly = v * PC_LY;
    return cs + (ly >= 0.01 ? '  ·  ' + (ly < 1000 ? ly.toFixed(ly < 10 ? 2 : 0) + ' ly/s' : ly < 1e6 ? (ly / 1e3).toFixed(1) + ' kly/s' : (ly / 1e6).toFixed(1) + ' Mly/s') : '');
  };

  let last = performance.now(), time = 0, frames = 0, fpsT = 0, fps = 0, cpuMs = 0;
  let busy = false, conFade = 1, nameFade = 1, labelT = 1, pointGain = 1, procFade = 1;
  const DIFFUSE = 11;   // extended light is lifted relative to point sources, as dark-adapted eyes do
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (document.hidden || busy) return;
    const t0 = performance.now();
    time += dt;
    // context distance: the nearest star (never closer than about ten solar radii) or the galaxy being crossed
    const gn = gal.near;
    let ctx = Math.max(2e-7, stars.near.dist);
    if (gn.id >= 0) ctx = Math.min(ctx, Math.max(gn.edge, gal.radius(gn.id) * 0.03));
    if (show.proc) ctx = Math.min(ctx, gn.spacing);
    flight.context = Math.min(ctx, 3e8);
    if (!state.frozen) updateFlight(dt); else basis();

    // how far outside the nearest galaxy's disc the camera is, in units that make 0..1 "inside" (see adaptation below)
    let out = 1e3, env = 1e9;
    if (gn.id >= 0) {
      const R = gal.radius(gn.id), dx = cam.p[0] - gal.pos(gn.id, 0), dy = cam.p[1] - gal.pos(gn.id, 1), dz = cam.p[2] - gal.pos(gn.id, 2);
      const z = dx * gal.normal(gn.id, 0) + dy * gal.normal(gn.id, 1) + dz * gal.normal(gn.id, 2), r = Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - z * z));
      out = Math.max(Math.abs(z) / (0.12 * R), r / R - 0.2); env = gn.dist / R;
    }
    // exposure. Three adaptations, as an eye would make them:
    //  - down, when a nearby star is in view
    //  - up by a few magnitudes once outside a galaxy's disc, so its surface brightness reads well
    //  - (points only) up further in the voids, so that distant galaxies show: pointGain
    const sm = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    const gainSB = 3.3 * sm(0.6, 2.0, out) + 1.0 * sm(3, 30, env);
    const gainPt = Math.min(5.5, 2.1 * Math.log10(Math.max(env / 3, 1)));
    const n = stars.near;
    let target = exposureBase * Math.pow(10, 0.4 * gainSB);
    if (n.dist < 1e6) {
      const dx = n.x - cam.p[0], dy = n.y - cam.p[1], dz = n.z - cam.p[2], d = Math.max(n.dist, 1e-12);
      const cosA = (dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2]) / d;
      const inView = Math.max(0, Math.min(1, (cosA - 0.2) / 0.5));       // fades out toward the edge of view and behind
      const e1 = Math.pow(10, -0.4 * n.absmag) * 100 / (d * d);         // its energy at exposure 1
      // only part of the way: the star still glares, and the brightest background stars stay in sight
      if (e1 * inView * target > E_MAX) target *= Math.pow(E_MAX / (e1 * inView * target), 0.62);
    }
    if (state.snap) { exposure = target; pointGain = Math.pow(10, 0.4 * gainPt); if (state.snap++ > 3) state.snap = 0; }
    exposure *= Math.pow(target / exposure, 1 - Math.exp(-dt * (target < exposure ? 6 : 1.5)));
    pointGain *= Math.pow(Math.pow(10, 0.4 * gainPt) / pointGain, 1 - Math.exp(-dt * 1.5));
    // catalogue stars keep their in-galaxy exposure: seen from outside they must not outshine the galaxy they sit in
    const starGain = Math.min(1, exposureBase / exposure * 1.0) ** 0.85;
    procFade += ((show.proc ? 1 : 0) - procFade) * (1 - Math.exp(-dt * 5));
    const magLimit = Math.min(magCap, -2.5 * Math.log10(E_THRESH / (exposure * starGain)) + quality.magBias);
    const galLimit = -2.5 * Math.log10(E_THRESH * 2.6 / (exposure * pointGain)) + quality.magBias;
    stars.update(magLimit);
    galPts.update(galLimit);
    gal.update(W, H, pxScale, pointGain, starGain);

    gf[0] = cam.right[0]; gf[1] = cam.right[1]; gf[2] = cam.right[2]; gf[3] = 1 / Math.tan(cam.fov / 2);
    gf[4] = cam.up[0]; gf[5] = cam.up[1]; gf[6] = cam.up[2]; gf[7] = W / H;
    gf[8] = cam.fwd[0]; gf[9] = cam.fwd[1]; gf[10] = cam.fwd[2]; gf[11] = exposure;
    gf[12] = W; gf[13] = H; gf[14] = time; gf[15] = pxScale;
    gf[16] = DIFFUSE; gf[17] = procFade;
    queue.writeBuffer(globalsBuf, 0, globals);

    // constellation figures fade out as the Sun's neighbourhood is left behind
    const fromSol = Math.hypot(cam.p[0], cam.p[1], cam.p[2]);
    conFade += ((show.lines ? 1 : 0) - conFade) * (1 - Math.exp(-dt * 5));
    const conVis = conFade * Math.max(0, Math.min(1, 1 - Math.log10(Math.max(fromSol, 1) / 150) / Math.log10(1000 / 150)));
    lines.gain[LG_CON] = conVis * Math.min(1, Math.sqrt(exposure / 32));
    lines.update();
    nameFade += ((show.names ? 1 : 0) - nameFade) * (1 - Math.exp(-dt * 5));
    kindGain.con = conVis; kindGain.star = kindGain.body = kindGain.deep = kindGain.galaxy = nameFade;
    labelT += dt;
    if (labelT > 0.25) {
      labelT = 0;
      labelLimit.star = labelLimit.body = labelLimit.deep = Math.min(magLimit - 4.2, 4.5); labelLimit.con = 99; labelLimit.galaxy = Math.min(galLimit - 3.5, 14);
      labels.choose(W, H, pxScale, labelLimit, kindGain);
    }
    labels.update(dt, W, H, pxScale, kindGain);

    const enc = device.createCommandEncoder();
    const hadVol = gal.drawVolumes(enc);
    const pass = enc.beginRenderPass(post.sceneAttach());
    gal.draw(pass, hadVol);
    galPts.draw(pass, pointGain);
    lines.draw(pass);
    stars.draw(pass, starGain);
    labels.draw(pass);
    pass.end();
    post.run(enc, gpu.offscreen ? offView : gpu.ctx.getCurrentTexture().createView(), time, 0.09);
    queue.submit([enc.finish()]);
    if (gpu.offscreen) { busy = true; queue.onSubmittedWorkDone().then(() => { busy = false; }); } // software rigs: never queue frames
    if (state.shot) { const r = state.shot; state.shot = null; r(); }

    cpuMs += (performance.now() - t0 - cpuMs) * 0.05;
    frames++; fpsT += dt;
    if (fpsT >= 0.5) { fps = frames / fpsT; frames = 0; fpsT = 0; }
    hudT += dt;
    if (hudT > 0.2) {
      hudT = 0;
      $('hs').textContent = fmtSpeed(flight.speed);
      $('hd').textContent = fmtDist(Math.hypot(cam.p[0], cam.p[1], cam.p[2]));
      $('hn').textContent = n.dist < 30 ? fmtDist(n.dist) : gn.id >= 0 ? gal.names[gn.id][0] + '  ' + fmtDist(gn.dist) : '';
      if (showPerf) { const s = stars.stats(), g2 = galPts.stats(); $('perf').textContent = `${fps.toFixed(0)} fps  cpu ${cpuMs.toFixed(2)} ms\n${W}x${H}\n${s.drawn.toLocaleString()} stars in ${s.tiles} tiles\n${s.loaded.toLocaleString()} loaded, ${s.pending} pending\nexposure ${exposure.toPrecision(3)}  mag ${magLimit.toFixed(1)} / ${galLimit.toFixed(1)}\n${g2.drawn.toLocaleString()} galaxies`; }
    }
  }
  say('Loading the nearest stars', 0.7);
  requestAnimationFrame(frame);
  // ready once the tiles needed for the first view have arrived
  await new Promise((r) => { const t = setInterval(() => { const s = stars.stats(); if (s.tiles > 0 && s.pending === 0 && galPts.stats().pending === 0) { clearInterval(t); r(); } }, 100); });
  say('Ready', 1); $('go').disabled = false; body.classList.remove('l');
  keep('starhopperLoad', '');
  try { localStorage.removeItem('starhopperLoad'); } catch {}
  if (params.has('auto')) body.classList.add('fly');
  // hooks for the tests, the benchmark and screenshots
  window.SH = { settle: () => { state.snap = 1; }, gal, galPts, POSES, setPose, show, cam, flight, stars, state, flyTo, lookQuat, basis, ready: true, capture, setExposure: (e) => { exposureBase = exposure = e; } };
}
main().catch((e) => { console.error(e); body.className = 'l e'; $('s').textContent = (e.cause ? '' : 'Failed to start: ') + e.message; });
