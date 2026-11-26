// Starhopper: start-up, the frame loop and the HUD
import { $, initGpu, GLOBALS_SIZE } from './gpu.js';
import { cam, basis, lookQuat, PC_LY, PC_AU, C_PC_S } from './camera.js';
import { flight, initInput, updateFlight, flyTo } from './flight.js';
import { quality, LEVEL, keep } from './quality.js';
import { initStars } from './stars.js';
import { initPost } from './post.js';

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
  say('Reading the star index', 0.3);
  const stars = await initStars(gpu, globalsBuf, base, quality);
  const post = initPost(gpu, quality);

  const state = { frozen: false, shot: null };
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
    post.resize(W, H);
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

  // start at Earth's distance from the Sun, facing Orion with celestial north up
  cam.p[0] = 1 / PC_AU; cam.p[1] = 0; cam.p[2] = 0;
  lookQuat(cam.q, 0.1045, 0.9945, 0.0, 0, 0, 1); basis();

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
  let busy = false;
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (document.hidden || busy) return;
    const t0 = performance.now();
    time += dt;
    // context distance: the nearest star, never closer than about ten solar radii
    flight.context = Math.max(2e-7, Math.min(stars.near.dist, 1e7));
    if (!state.frozen) updateFlight(dt); else basis();

    // exposure: the eye adapts down when a nearby star is in view
    const n = stars.near;
    let target = exposureBase;
    if (n.dist < 1e6) {
      const dx = n.x - cam.p[0], dy = n.y - cam.p[1], dz = n.z - cam.p[2], d = Math.max(n.dist, 1e-12);
      const cosA = (dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2]) / d;
      const inView = Math.max(0, Math.min(1, (cosA - 0.2) / 0.5));       // fades out toward the edge of view and behind
      const e1 = Math.pow(10, -0.4 * n.absmag) * 100 / (d * d);         // its energy at exposure 1
      if (e1 * inView * exposureBase > E_MAX) target = E_MAX / (e1 * inView);
    }
    exposure *= Math.pow(target / exposure, 1 - Math.exp(-dt * (target < exposure ? 6 : 1.5)));
    const magLimit = Math.min(magCap, -2.5 * Math.log10(E_THRESH / exposure) + quality.magBias);
    stars.update(magLimit);

    gf[0] = cam.right[0]; gf[1] = cam.right[1]; gf[2] = cam.right[2]; gf[3] = 1 / Math.tan(cam.fov / 2);
    gf[4] = cam.up[0]; gf[5] = cam.up[1]; gf[6] = cam.up[2]; gf[7] = W / H;
    gf[8] = cam.fwd[0]; gf[9] = cam.fwd[1]; gf[10] = cam.fwd[2]; gf[11] = exposure * Math.pow(10, 0.4 * quality.magBias * 0);
    gf[12] = W; gf[13] = H; gf[14] = time; gf[15] = pxScale;
    stars.writeCamera(gf, gi);
    queue.writeBuffer(globalsBuf, 0, globals);

    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass(post.sceneAttach());
    stars.draw(pass);
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
      $('hn').textContent = n.dist < 1e6 ? fmtDist(n.dist) : '';
      if (showPerf) { const s = stars.stats(); $('perf').textContent = `${fps.toFixed(0)} fps  cpu ${cpuMs.toFixed(2)} ms\n${W}x${H}\n${s.drawn.toLocaleString()} stars in ${s.tiles} tiles\n${s.loaded.toLocaleString()} loaded, ${s.pending} pending\nexposure ${exposure.toPrecision(3)}  mag ${magLimit.toFixed(1)}`; }
    }
  }
  say('Loading the nearest stars', 0.7);
  requestAnimationFrame(frame);
  // ready once the tiles needed for the first view have arrived
  await new Promise((r) => { const t = setInterval(() => { const s = stars.stats(); if (s.tiles > 0 && s.pending === 0) { clearInterval(t); r(); } }, 100); });
  say('Ready', 1); $('go').disabled = false; body.classList.remove('l');
  keep('starhopperLoad', '');
  try { localStorage.removeItem('starhopperLoad'); } catch {}
  if (params.has('auto')) body.classList.add('fly');
  // hooks for the tests, the benchmark and screenshots
  window.SH = { cam, flight, stars, state, flyTo, lookQuat, basis, ready: true, capture, setExposure: (e) => { exposureBase = exposure = e; } };
}
main().catch((e) => { console.error(e); body.className = 'l e'; $('s').textContent = (e.cause ? '' : 'Failed to start: ') + e.message; });
