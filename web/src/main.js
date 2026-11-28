// Starhopper: start-up, the frame loop and the HUD
import { $, initGpu, GLOBALS_SIZE } from './gpu.js';
import { cam, basis, lookQuat, PC_LY, PC_AU, C_PC_S } from './camera.js';
import { flight, initInput, updateFlight, flyTo, cancelGoto } from './flight.js';
import { quality, LEVEL, MOBILE, keep } from './quality.js';
import { initPoints } from './points.js';
import { initGalaxies } from './galaxies.js';
import { initPost } from './post.js';
import { initLines } from './lines.js';
import { initLabels } from './labels.js';
import { POSES, setPose, place } from './poses.js';
import { initBodies } from './bodies.js';
import { initDeep } from './deep.js';
import { initMarkers } from './markers.js';
import { initBeyond } from './beyond.js';
import { initWeb } from './web.js';
import { setSound, setVolume, setEngine, updateSound, level } from './audio.js';
import { PLANETS, orbitPoints, jdNow } from './solar.js';
import { retarget } from './flight.js';
import { facts, wiki } from './info.js';

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
  const base = DATA_BASE;
  // Which build this is. The host lets browsers keep the page for ten minutes, so a page can be older than the site:
  // ask (uncached) what is deployed now and, if it is something else, offer it under an address the cache has not seen.
  $('ver').textContent = (PREVIEW ? 'Preview of pull request #' + PREVIEW + ' \u00b7 ' : '') + 'Build ' + VERSION;
  fetch('version.json?' + Date.now(), { cache: 'no-store' }).then((r) => r.json()).then((v) => {
    if (!v.version || v.version === VERSION) return;
    const a = document.createElement('a'); a.textContent = 'newer build available: load ' + v.version.split(' ')[0];
    a.onclick = () => location.replace(location.pathname + '?b=' + encodeURIComponent(v.version.split(' ')[0]));
    $('ver').append(' \u00b7 ', a);
  }).catch(() => {});
  // a pull request's preview build says so, so that nobody takes it for the live site
  if (PREVIEW) { const b = document.createElement('div'); b.textContent = 'Preview of pull request #' + PREVIEW; b.style.cssText = 'position:fixed;left:50%;top:50px;transform:translateX(-50%);white-space:nowrap;z-index:9;padding:4px 9px;border-radius:999px;background:#c8102e;color:#fff;font:600 11px system-ui;letter-spacing:.04em;pointer-events:none'; document.body.append(b); }
  say('Reading the star and galaxy indexes', 0.3);
  const [stars, galPts, gal] = await Promise.all([
    initPoints(gpu, globalsBuf, base + 'stars/', quality, { budget: quality.starBudget, track: true, magOff: 20, sigma0: 0.62 }),
    initPoints(gpu, globalsBuf, base + 'galaxies/', quality, { budget: 400_000, track: false, magOff: 40, sigma0: 1.0 }),
    initGalaxies(gpu, globalsBuf, base, quality)]);
  const post = initPost(gpu, quality);
  const beyond = initBeyond(gpu, globalsBuf, gal.noise, [28, 22, 16][LEVEL]);
  // nebulae, clusters and exoplanet hosts arrive after the first frame: until then these stand in for them
  let deep = { count: 0, near: { id: -1, edge: Infinity }, update() {}, draw() {}, hasBig: () => false }, markers = { count: 0, update() {}, draw() {} };
  // the planets are placed for today's date (?jd= pins it, for repeatable renders)
  const jd = +(params.get('jd') || 0) || jdNow();
  const bodies = initBodies(gpu, globalsBuf, base, jd, gal.noise, LEVEL === 0 ? 0 : 2048);

  const state = { frozen: false, shot: null, snap: 1, frames: 0, skip: {} };   // skip: passes left out, for profiling
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
  const lines = initLines(gpu, globalsBuf, 8192), labels = initLabels(gpu, globalsBuf, () => pxScale);
  const LG_CON = 0, LG_ORBIT = 1;
  gal.names.forEach((n, i) => { if (n[1]) labels.add(n[0], 'galaxy', gal.pos(i, 0), gal.pos(i, 1), gal.pos(i, 2), gal.absmag(i), Infinity, gal.radius(i) * 1.2, 0, gal.radius(i)); });
  const bodyLabel = [], bodyRow = [];
  // planets: orbit lines (the ellipse each is on today) and names
  {
    const NP = 160, op = new Float64Array(NP * 3);
    PLANETS.forEach((pl, i) => {
      orbitPoints(i, NP, op, jd);
      for (let k = 0; k < NP; k++) { const a = k * 3, b = ((k + 1) % NP) * 3; lines.add(op[a], op[a + 1], op[a + 2], op[b], op[b + 1], op[b + 2], 0.10, 0.13, 0.20, 0.5, LG_ORBIT); }
      bodyLabel[i + 1] = labels.add(pl.name, 'body', bodies.pos(i + 1, 0), bodies.pos(i + 1, 1), bodies.pos(i + 1, 2), NaN, 0.004, bodies.radius(i + 1) * 2.5, -10, bodies.radius(i + 1));
    });
    const mn = bodies.count - 1;   // the Moon: named out to a few million kilometres
    bodyLabel[mn] = labels.add('Moon', 'body', bodies.pos(mn, 0), bodies.pos(mn, 1), bodies.pos(mn, 2), NaN, 2e-7, bodies.radius(mn) * 2.5, -10, bodies.radius(mn));
  }
  labels.occluder(bodies.hides);
  place(0, bodies.night());
  // the picture comes first: figures and names are off until asked for
  const show = { lines: false, names: false, proc: true, sound: true, exo: false, trails: true };
  const labelLimit = { star: 0, con: 0, body: 0, deep: 0, galaxy: 0, target: 99 };
  const kindGain = { star: 1, con: 1, body: 1, deep: 1, galaxy: 1, target: 1 };
  const tgtLabel = labels.add('', 'target', 0, 0, 0, NaN, 0, 0, -100);   // the target marker: hidden (maxDist 0) until something is picked
  let going = null, nightStale = false;   // the catalogue row a fly-to is heading for (it may move); the night viewpoint needs replacing
  const freshNight = () => { if (nightStale) { place(0, bodies.night()); nightStale = false; } };
  const target = { on: false, x: 0, y: 0, z: 0, stop: 0, name: '', row: null };
  const setLock = (on) => { flight.lock = on && target.on; $('tblk').classList.toggle('on', flight.lock); $('tblk').textContent = flight.lock ? 'Locked' : 'Lock'; };

  // start at Earth's distance from the Sun, facing Orion with celestial north up
  if (params.has('pose')) setPose(+params.get('pose') - 1);
  else { const s = bodies.launch(); cam.p.set(s.p); lookQuat(cam.q, s.at[0] - s.p[0], s.at[1] - s.p[1], s.at[2] - s.p[2], s.up[0], s.up[1], s.up[2]); basis(); }

  const magCap = +(params.get('mag') || 13);   // ?mag=6 caps the faintest star drawn (keeps software test rigs fast)
  let exposureBase = 32, exposure = 32, showPerf = false, hudT = 0;
  const E_THRESH = 0.0035 * 2 * Math.PI * 0.62 * 0.62;   // energy at which a star is culled (see stars.js)
  const E_MAX = 2 * Math.PI * 2.6 * 26 * 26;             // energy at which a star sprite stops growing

  initInput(canvas, (code, shifted) => {
    if (code === 'KeyH') { showPerf = !showPerf; $('perf').hidden = !showPerf; }
    else if (code === 'Home' || code === 'Digit0') going = bodyRow[3], flyTo(bodies.pos(3, 0), bodies.pos(3, 1), bodies.pos(3, 2), bodies.radius(3) * 4, 6);
    else if (code === 'KeyO') { setLock(!flight.lock); if (target.on) flash(flight.lock ? 'Locked on to ' + target.name : 'Lock released'); }
    else if (code === 'Comma') stepRate(-1, shifted); else if (code === 'Period') stepRate(1, shifted); else if (code === 'Slash') clockNow(); else if (code === 'KeyT') togglePause();
    else if (code === 'KeyI') { if (target.on) showInfo(!$('info').classList.contains('on')); }
    else if (code === 'KeyG') { if (target.on) { (going = target.row, flyTo(target.x, target.y, target.z, target.stop, 9)); flash(target.name); } }
    else if (code === 'Touch') $('ctx').hidden = true;
    else if (code === 'Tap' || code === 'DoubleTap' || code === 'Hold') {
      const nx = flight.tapX / innerWidth * 2 - 1, ny = 1 - flight.tapY / innerHeight * 2, f = 1 / Math.tan(cam.fov / 2), asp = innerWidth / innerHeight;
      let dx = cam.right[0] * nx * asp / f + cam.up[0] * ny / f + cam.fwd[0], dy = cam.right[1] * nx * asp / f + cam.up[1] * ny / f + cam.fwd[1], dz = cam.right[2] * nx * asp / f + cam.up[2] * ny / f + cam.fwd[2];
      const n = Math.hypot(dx, dy, dz); pick(dx / n, dy / n, dz / n);
      if (code === 'DoubleTap' && target.on) (going = target.row, flyTo(target.x, target.y, target.z, target.stop, 9));
      // held on something: offer to go there, in a small menu beside the finger
      if (code === 'Hold' && target.on) {
        const c = $('ctx'); flight.menu = true; $('ctxn').textContent = target.name;
        c.style.left = Math.max(8, Math.min(innerWidth - 190, flight.tapX + 14)) + 'px'; c.style.top = Math.max(8, Math.min(innerHeight - 110, flight.tapY - 40)) + 'px'; c.hidden = false;
      } else $('ctx').hidden = true;
    }
    else if (code === 'BracketRight') exposureBase = Math.min(4000, exposureBase * 1.25);
    else if (code === 'BracketLeft') exposureBase = Math.max(0.5, exposureBase / 1.25);
    else if (code === 'Equal') flight.throttle = Math.min(4, flight.throttle + 0.25);
    else if (code === 'Minus') flight.throttle = Math.max(-3, flight.throttle - 0.25);
    else if (code === 'Tab') body.classList.toggle('nohud');
    else if (code === 'KeyL') { show.lines = !show.lines; syncToggles(); }
    else if (code === 'KeyN') { show.names = !show.names; syncToggles(); }
    else if (code === 'KeyX') { show.exo = !show.exo; syncToggles(); flash(show.exo ? markers.count.toLocaleString() + ' stars with known planets' : 'Exoplanet hosts hidden'); }
    else if (code === 'KeyM') { show.sound = setSound(!show.sound); syncToggles(); keep('starhopperSound', show.sound ? 1 : 0); flash(show.sound ? 'Sound on' : 'Sound off'); }
    else if (code === 'KeyV') { show.trails = !show.trails; flash(show.trails ? 'Speed streaks on' : 'Speed streaks off'); }
    else if (code === 'KeyP') { show.proc = !show.proc; syncToggles(); flash(show.proc ? 'Procedural fill on' : 'Measured data only'); }
    else if (/^Digit[1-8]$/.test(code)) { cancelGoto(); halt(); freshNight(); setPose(+code[5] - 1); state.snap = 1; flash(POSES[+code[5] - 1].name); }
    else if (code === 'Unlocked' && !params.has('auto')) { body.classList.remove('fly'); if (flight.wheel) flight.thr = 0; }   // the menu is a pause: a scrolled throttle is let go
    else if (code === 'KeyB' && params.has('bench')) { flash('Benchmark running'); runBench().then((r) => { showPerf = true; $('perf').hidden = false; console.log(JSON.stringify(r)); flash('Benchmark done'); $('s').textContent = JSON.stringify(r); body.classList.remove('fly'); }); }
  });
  const flash = (t) => { const m = $('msg'); m.textContent = t; m.classList.add('on'); clearTimeout(flash.t); flash.t = setTimeout(() => m.classList.remove('on'), 2200); };
  document.querySelectorAll('#tg button').forEach((b) => { b.onclick = () => { const k = b.dataset.k; show[k] = k === 'sound' ? setSound(!show[k]) : !show[k]; b.classList.toggle('on', show[k]); if (k === 'sound') keep('starhopperSound', show[k] ? 1 : 0); }; });
  const syncToggles = () => document.querySelectorAll('#tg button').forEach((b) => b.classList.toggle('on', show[b.dataset.k]));
  // sound is on unless it was turned off on an earlier visit; the volume is remembered too. (The sound itself can only
  // start from a tap or a key, so it begins at Launch.)
  try { if (localStorage.starhopperSound === '0') show.sound = false; if (localStorage.starhopperVol) $('volr').value = localStorage.starhopperVol; } catch {}
  syncToggles(); setVolume($('volr').value / 100);
  $('volr').oninput = (e) => { setVolume(e.target.value / 100); keep('starhopperVol', e.target.value); };
  try { if (localStorage.starhopperEng) $('engr').value = localStorage.starhopperEng; } catch {}
  setEngine($('engr').value / 100);
  $('engr').oninput = (e) => { setEngine(e.target.value / 100); keep('starhopperEng', e.target.value); };
  // search: every named star and galaxy; Enter flies to the best match, stopping a comfortable distance short
  // rows: search key, shown name, position, where a fly-to stops, absolute magnitude, kind (0 star, 1 galaxy, 2 planet, 3 nebula or cluster), radius
  const index = [];
  gal.names.forEach((n, i) => index.push([n[0].toLowerCase(), n[0], gal.pos(i, 0), gal.pos(i, 1), gal.pos(i, 2), gal.radius(i) * 3.2, gal.absmag(i), 1, gal.radius(i)]));
  for (let i = 1; i < bodies.count; i++) index.push(bodyRow[i] = [bodies.names[i].toLowerCase(), bodies.names[i], bodies.pos(i, 0), bodies.pos(i, 1), bodies.pos(i, 2), bodies.radius(i) * 4, -99, 2, bodies.radius(i)]);
  // target whatever lies closest to a view ray (unit vector), among the things bright enough to be on screen
  let curMag = 6, curGal = 12;
  function pick(dx, dy, dz) {
    let best = -1, bs = 0.038;                                   // within about two degrees, or inside the object's disc
    for (let i = 0; i < index.length; i++) {
      const r = index[i], x = r[2] - cam.p[0], y = r[3] - cam.p[1], z = r[4] - cam.p[2], d = Math.sqrt(x * x + y * y + z * z);
      if (d < r[8] * 1.5 || d < 1e-12) continue;
      if (r[6] + 5 * Math.log10(d / 10) > (r[7] === 1 ? curGal + 1 : curMag + 0.5)) continue;
      const c = (x * dx + y * dy + z * dz) / d; if (c < 0.99) continue;
      const sc = Math.acos(Math.min(1, c)) - Math.min(r[8] / d * 0.7, 0.2);
      if (sc < bs) { bs = sc; best = i; }
    }
    // nothing there, or the target itself picked again: no target
    if (best >= 0 && target.on && index[best][2] === target.x && index[best][3] === target.y && index[best][4] === target.z) best = -1;
    if (best < 0) { target.on = false; labels.items[tgtLabel].maxDist = 0; $('htr').hidden = true; $('tb').classList.remove('on'); $('arr').classList.remove('on'); setLock(false); showInfo(false); return; }
    setTarget(index[best]);
  }
  function setTarget(r) {
    target.on = true; target.x = r[2]; target.y = r[3]; target.z = r[4]; target.stop = r[5]; target.name = r[1]; target.row = r;
    labels.move(tgtLabel, '\u25C7 ' + r[1], r[2], r[3], r[4], r[8]); labels.items[tgtLabel].maxDist = Infinity; labelT = 1;
    if ($('info').classList.contains('on')) queueMicrotask(() => showInfo(true));   // the card follows the target
    $('htr').hidden = false; $('tb').classList.add('on'); $('tbn').textContent = r[1]; flash(r[1]);
  }
  // Search: the best few matches are listed as you type. Exact names first, then names that start with what was
  // typed, then a word in the name that does, then anywhere in it, then the letters in order with gaps (a typo's
  // worth of slack). Picking one makes it the target; its Fly button, or Enter, goes there.
  const KIND = ['star', 'galaxy', 'Solar System', 'nebula or cluster'];
  function search(text, max = 7) {
    const q = text.trim().toLowerCase().replace(/^m(\d)/, 'm $1').replace(/^ngc(\d)/, 'ngc $1').replace(/^ic(\d)/, 'ic $1'); if (!q) return [];
    const hits = [], seen = new Set();
    for (const r of index) {
      const n = r[0]; let sc = -1;
      if (n === q) sc = 0; else if (n.startsWith(q)) sc = 1 + n.length / 1000;
      else { const at = n.indexOf(q); if (at > 0) sc = (n[at - 1] === ' ' ? 2 : 3) + n.length / 1000; }
      if (sc < 0 && q.length >= 3 && n.length < 40) { let k = 0, gaps = 0, last = -1; for (let c = 0; c < n.length && k < q.length; c++) if (n[c] === q[k]) { if (last >= 0) gaps += c - last - 1; last = c; k++; } if (k === q.length && gaps <= 3) sc = 4 + gaps / 10 + n.length / 1000; }
      if (sc >= 0) hits.push([sc, r]);
    }
    hits.sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const [, r] of hits) { const key = r[1] + r[2]; if (seen.has(key)) continue; seen.add(key); out.push(r); if (out.length >= max) break; }
    return out;
  }
  let sugHits = [];
  const flyHit = (r) => { $('find').blur(); setTarget(r); launch(); going = r; flyTo(r[2], r[3], r[4], r[5], 9); state.snapSoon = 0; };
  function suggest() {
    sugHits = search($('find').value, MOBILE ? 5 : 7);
    $('sug').replaceChildren(...sugHits.map((r, i) => {
      const row = document.createElement('div'), nm = document.createElement('span'), info = document.createElement('small'), go = document.createElement('button');
      nm.textContent = r[1]; info.textContent = KIND[r[7]] + ' \u00b7 ' + fmtDist(Math.hypot(r[2] - cam.p[0], r[3] - cam.p[1], r[4] - cam.p[2])); go.textContent = 'Fly';
      if (!i) row.className = 'sel';
      row.onclick = () => { $('find').blur(); setTarget(r); launch(); };
      go.onclick = (e) => { e.stopPropagation(); flyHit(r); };
      row.append(nm, info, go); return row;
    }));
  }
  $('find').addEventListener('input', suggest);
  $('find').addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key !== 'Enter') return;
    if (!e.target.value.trim()) return;
    const hit = search(e.target.value, 1)[0];
    if (!hit) { $('s').textContent = 'Nothing in the catalogues matches that name'; return; }
    flyHit(hit);
  });
  fetch(base + 'manifest.json').then((r) => r.json()).then((m) => {
    $('crb').innerHTML = m.sources.map((x) => `<p><a href="${x.home}" target="_blank" rel="noopener">${x.title}</a><br>${x.credit}. ${x.licence}.</p>`).join('') + '<p>Procedural fill (galaxy shapes, the Milky Way beyond the catalogue, fill stars) is a model, not data. Press P to hide it.</p>';
  }).catch(() => {});
  // back to low orbit over the daylight side, where every visit begins
  // come to rest: no speed, the throttle back at zero and Hold let go
  const halt = () => { flight.vel.fill(0); flight.thr = 0; flight.cruise = false; $('cz').classList.remove('on'); };
  const toEarth = () => { const s = bodies.launch(); cancelGoto(); halt(); cam.p.set(s.p); lookQuat(cam.q, s.at[0] - s.p[0], s.at[1] - s.p[1], s.at[2] - s.p[2], s.up[0], s.up[1], s.up[2]); basis(); state.snap = 1; };
  const launch = () => {
    body.classList.add('fly');
    // from now on the menu is a pause: its main button resumes, and a second one starts over from the Earth
    $('go').textContent = 'Resume'; $('home').hidden = false; $('x').hidden = false;
    if (show.sound) { show.sound = setSound(true); syncToggles(); }
    // phones fly in landscape: full screen first, since the orientation can only be locked there
    if (MOBILE) document.documentElement.requestFullscreen?.().then(() => screen.orientation?.lock?.('landscape')).catch(() => {});
    else {
      // Chrome refuses to take the pointer again for about a second after Esc gave it back: ask once more then
      const ask = () => canvas.requestPointerLock?.()?.catch?.(() => {});
      const p = canvas.requestPointerLock?.();
      p?.catch?.(() => setTimeout(() => { if (body.classList.contains('fly') && !flight.locked) ask(); }, 1300));
    }
  };
  // Esc leaves the flight for the menu (the browser hands the pointer back); Esc again goes back to the flight
  let unlockedAt = 0; document.addEventListener('pointerlockchange', () => { if (!document.pointerLockElement) unlockedAt = performance.now(); });
  addEventListener('keydown', (e) => { if (e.code === 'Escape' && !e.repeat && !body.classList.contains('fly') && !$('x').hidden && performance.now() - unlockedAt > 350) { e.preventDefault(); $('find').blur(); launch(); } });
  $('go').onclick = launch;
  $('home').onclick = () => { toEarth(); launch(); flash('Earth'); };
  $('x').onclick = launch;
  $('veil').onclick = (e) => { if (e.target === $('veil') && !$('x').hidden) launch(); };   // a tap beside the menu goes back to the flight
  $('cz').onclick = () => { flight.cruise = !flight.cruise; $('cz').classList.toggle('on', flight.cruise); if (!flight.cruise) flight.thr = 0; flash(flight.cruise ? 'Holding speed' : 'Speed released'); };
  // a click looks at what is dead ahead (the pointer is locked to the view) and targets it
  // (a mouse click only: the click a phone makes up after a tap must not lock the pointer, which swallows every touch after it)
  canvas.onclick = (e) => { if (!body.classList.contains('fly') || MOBILE || (e.pointerType && e.pointerType !== 'mouse')) return; if (flight.locked) pick(cam.fwd[0], cam.fwd[1], cam.fwd[2]); else canvas.requestPointerLock?.()?.catch?.(() => {}); };
  // viewpoints and save points (kept in this browser only)
  POSES.forEach((p, i) => { const b = document.createElement('button'); b.textContent = p.name; b.onclick = () => { cancelGoto(); halt(); freshNight(); setPose(i); state.snap = 1; launch(); flash(p.name); }; $('vp').append(b); });
  let saves = []; try { saves = JSON.parse(localStorage.starhopperSaves || '[]'); } catch {}
  const drawSaves = () => {
    $('svl').textContent = '';
    saves.forEach((s, i) => {
      const w = document.createElement('span'), go = document.createElement('button'), del = document.createElement('button');
      go.textContent = s.n; del.textContent = '\u00d7'; del.title = 'Forget this place';
      go.onclick = () => { cancelGoto(); halt(); cam.p.set(s.p); cam.q.set(s.q); basis(); state.snap = 1; launch(); flash(s.n); };
      del.onclick = () => { saves.splice(i, 1); keep('starhopperSaves', JSON.stringify(saves)); drawSaves(); };
      w.append(go, del); $('svl').append(w);
    });
  };
  const save = () => {
    const n = $('svn').value.trim() || ($('hn').textContent.replace(/\s\s.*/, '') || $('scale').textContent || 'Somewhere') + ' ' + (saves.length + 1);
    saves.push({ n: n.slice(0, 40), p: [cam.p[0], cam.p[1], cam.p[2]], q: [cam.q[0], cam.q[1], cam.q[2], cam.q[3]] });
    keep('starhopperSaves', JSON.stringify(saves)); $('svn').value = ''; drawSaves(); $('s').textContent = 'Saved: ' + n;
  };
  $('ctxgo').onclick = () => { $('ctx').hidden = true; flight.menu = false; if (target.on) { (going = target.row, flyTo(target.x, target.y, target.z, target.stop, 9)); flash(target.name); } };
  // the bar under a target: go there (or stop going there), or let it go
  // Stop means stop: without this a throttle held up to hurry the trip would carry straight on
  $('tbgo').onclick = () => { if (flight.goto) { cancelGoto(); halt(); } else if (target.on) { (going = target.row, flyTo(target.x, target.y, target.z, target.stop, 9)); flash(target.name); } };
  // The info card: what the catalogue says about the target, then a few lines and a picture from Wikipedia if it
  // has a page that is plainly about this object. Built with text nodes only: nothing fetched is parsed as HTML.
  let infoRow = null, infoAt = 0;
  const infoEl = (tag, text) => { const e = document.createElement(tag); e.textContent = text; return e; };
  function showFacts(r) {
    const cd = Math.hypot(r[2] - cam.p[0], r[3] - cam.p[1], r[4] - cam.p[2]), ed = Math.hypot(r[2] - bodies.pos(3, 0), r[3] - bodies.pos(3, 1), r[4] - bodies.pos(3, 2));
    const f = facts(r, cd, ed);
    $('inff').replaceChildren(...f.facts.flatMap(([k, v]) => [infoEl('dt', k), infoEl('dd', v)]));
    $('infl').textContent = f.line; $('infl').hidden = !f.line;
    infoAt = performance.now();
    return f.line;
  }
  function showInfo(on) {
    $('info').classList.toggle('on', on && target.on); $('tbi').classList.toggle('on', on && target.on);
    if (!on || !target.on) { infoRow = null; return; }
    const r = infoRow = target.row, line = showFacts(r), el = infoEl;
    $('infn').textContent = r[1] === 'Sol' ? 'Sun' : r[1];
    $('infw').replaceChildren(el('small', 'Looking it up \u2026'));
    wiki(r).then((w) => {
      if (infoRow !== r) return;
      if (!w) { $('infw').replaceChildren(el('small', line ? '' : 'No further information found for this object.')); return; }
      const kids = [];
      if (w.img && /^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(w.img)) { const im = document.createElement('img'); im.src = w.img; im.alt = w.title; im.referrerPolicy = 'no-referrer'; kids.push(im); }
      kids.push(el('p', w.text));
      const cr = el('small', 'Text and picture from '), a = el('a', 'Wikipedia'); a.href = w.url; a.target = '_blank'; a.rel = 'noopener'; cr.append(a, ' (CC BY-SA; the picture\u2019s own licence is on its page).');
      kids.push(cr); $('infw').replaceChildren(...kids);
    });
  }
  $('tbi').onclick = () => showInfo(!$('info').classList.contains('on'));
  $('infx').onclick = () => showInfo(false);
  canvas.addEventListener('pointerdown', () => { if ($('info').classList.contains('on') && MOBILE) showInfo(false); });
  $('tblk').onclick = () => { setLock(!flight.lock); flash(flight.lock ? 'Locked on to ' + target.name : 'Lock released'); };
  // The clock. It starts at the present, running at the true rate; the buttons step through faster rates (and
  // backwards), pause it, or bring it back to now. Only the Sun's family moves: the stars are too far to show it.
  // Rates, in seconds of the clock per second. The single arrows go one small step along the whole ladder (through
  // zero into reverse); the double arrows jump to the next whole unit (second, minute, hour, day, month, year).
  const MAG = [1, 10, 60, 300, 900, 3600, 10800, 21600, 43200, 86400, 259200, 604800, 1209600, 2592000, 7776000, 15552000, 31557600];
  const MAG_NAME = ['real time', '10 s/s', '1 min/s', '5 min/s', '15 min/s', '1 hour/s', '3 hours/s', '6 hours/s', '12 hours/s', '1 day/s', '3 days/s', '1 week/s', '2 weeks/s', '1 month/s', '3 months/s', '6 months/s', '1 year/s'];
  const UNIT = new Set([1, 60, 3600, 86400, 2592000, 31557600]);
  const RATES = [...MAG.map((m) => -m).reverse(), ...MAG], REAL = MAG.length, PAUSE = -1;
  const rateName = (i) => (i === PAUSE ? 'paused' : i >= REAL ? MAG_NAME[i - REAL] : i === REAL - 1 ? 'real time, backwards' : '\u2212' + MAG_NAME[REAL - 1 - i]);
  let simJd = jd, rateI = REAL, lastRun = REAL, clockShown = '', clockAt = 0;
  function setRate(i) { rateI = i === PAUSE ? PAUSE : Math.max(0, Math.min(RATES.length - 1, i)); if (rateI !== PAUSE) lastRun = rateI; $('tcr').textContent = rateName(rateI); $('tcp').innerHTML = rateI === PAUSE ? '&#9654;' : '&#10074;&#10074;'; }
  // a step from paused starts from the rate it was paused at
  const stepRate = (d, unit) => { let i = (rateI === PAUSE ? lastRun : rateI) + d; if (unit) while (i > 0 && i < RATES.length - 1 && !UNIT.has(Math.abs(RATES[i]))) i += d; setRate(i); };
  const togglePause = () => setRate(rateI === PAUSE ? lastRun : PAUSE);
  $('tcs').onclick = () => stepRate(-1, false); $('tcf').onclick = () => stepRate(1, false); $('tcss').onclick = () => stepRate(-1, true); $('tcff').onclick = () => stepRate(1, true); $('tcp').onclick = togglePause;
  const clockNow = () => { simJd = jdNow(); setRate(REAL); clockAt = 0; flash('The present'); };
  $('tcn').onclick = clockNow;
  setRate(REAL);
  // The clock keeps its own time: the flight's step is capped at a tenth of a second, which would run the clock
  // slow on a slow machine. Real time counts every second that passed, hidden tab included; the fast rates count
  // at most one second per frame, so that coming back to the tab does not skip centuries.
  function tick(now) {
    const el = clockAt ? (now - clockAt) / 1000 : 0; clockAt = now;
    if (rateI === PAUSE || state.frozen) return;
    simJd += (rateI === REAL ? el : Math.min(el, 1)) * RATES[rateI] / 86400;
    const cx = cam.p[0], cy = cam.p[1], cz = cam.p[2];
    bodies.setTime(simJd); nightStale = true;
    rode[0] += cam.p[0] - cx; rode[1] += cam.p[1] - cy; rode[2] += cam.p[2] - cz;   // carried by a planet: not the camera's own travel
    if (!flight.goto) going = null;
    for (let i = 1; i < bodies.count; i++) {
      const x = bodies.pos(i, 0), y = bodies.pos(i, 1), z = bodies.pos(i, 2), r = bodyRow[i];
      r[2] = x; r[3] = y; r[4] = z; const lb = labels.items[bodyLabel[i]]; lb.x = x; lb.y = y; lb.z = z;
      if (target.on && target.row === r) { target.x = x; target.y = y; target.z = z; const tl = labels.items[tgtLabel]; tl.x = x; tl.y = y; tl.z = z; }
      if (going === r && flight.goto) retarget(x, y, z);
    }
    const d = new Date((simJd - 2440587.5) * 86400000), text = isFinite(d) ? d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '';
    if (text !== clockShown) $('tcd').textContent = clockShown = text;
  }
  $('tbx').onclick = () => { cancelGoto(); pick(0, 0, 0); };
  $('ctxno').onclick = () => { $('ctx').hidden = true; flight.menu = false; };
  $('svb').onclick = save;
  $('svn').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') save(); });
  drawSaves();
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

  // Everything the first frame does not need: names, constellation figures, nebulae and clusters, exoplanet hosts.
  // Fetched together once the flight is already on screen.
  let web = null, thrShown = 0, joyX = 0, joyY = 0;
  initWeb(gpu, globalsBuf, base).then((w) => { web = w; }).catch((e) => console.warn('no density grid', e));
  const extras = Promise.all([fetch(base + 'names.json').then((r) => r.json()), fetch(base + 'constellations.json').then((r) => r.json()),
    initDeep(gpu, globalsBuf, base, gal.noise), fetch(base + 'exoplanets.json').then((r) => r.json()).catch(() => ({ hosts: [] }))]).then(([names, cons, dp, exo]) => {
    for (const c of cons) {
      let cx = 0, cy = 0, cz = 0; const np = c.pts.length / 3;
      for (const l of c.lines) for (let k = 1; k < l.length; k++) { const a = l[k - 1] * 3, b = l[k] * 3; lines.add(c.pts[a], c.pts[a + 1], c.pts[a + 2], c.pts[b], c.pts[b + 1], c.pts[b + 2], 0.05, 0.085, 0.17, 0.5, LG_CON); }
      // label on the sky at the figure's mean direction, at a nominal 60 pc so it shifts as you move off
      for (let k = 0; k < np; k++) { const n = Math.hypot(c.pts[k * 3], c.pts[k * 3 + 1], c.pts[k * 3 + 2]) || 1; cx += c.pts[k * 3] / n; cy += c.pts[k * 3 + 1] / n; cz += c.pts[k * 3 + 2] / n; }
      const n = Math.hypot(cx, cy, cz) || 1;
      if (np) labels.add(c.name, 'con', cx / n * 60, cy / n * 60, cz / n * 60, NaN, Infinity, 0, 3.5);
    }
    for (const s of names.stars) if (s[0]) labels.add(s[0] === 'Sol' ? 'Sun' : s[0], 'star', s[2], s[3], s[4], s[5]);
    for (const s of names.stars) { if (s[0]) index.push([s[0].toLowerCase(), s[0], s[2], s[3], s[4], 0.0004, s[5], 0, 0]); if (s[1]) index.push([s[1].toLowerCase(), s[0] || s[1], s[2], s[3], s[4], 0.0004, s[5], 0, 0]); }
    deep = dp; markers = initMarkers(gpu, globalsBuf, exo.hosts);
    for (let i = 0; i < deep.count; i++) if (deep.labelled(i)) labels.add(deep.name(i), 'deep', deep.pos(i, 0), deep.pos(i, 1), deep.pos(i, 2), deep.absmag(i) + 2, Infinity, deep.radius(i) * 1.2, 0, deep.radius(i));
    for (let i = 0; i < deep.count; i++) index.push([deep.name(i).toLowerCase(), deep.name(i), deep.pos(i, 0), deep.pos(i, 1), deep.pos(i, 2), deep.radius(i) * 2.6, deep.absmag(i), 3, deep.radius(i)]);
    // (a few hosts are filed under another name than their planets carry, Kepler-90 under KOI-351: both are searchable)
    for (const h of exo.hosts) for (const n of [h[0], ...(h[5] ? h[5].split(',') : [])]) index.push([n.trim().toLowerCase(), n.trim() + (h[4] > 1 ? ', ' + h[4] + ' planets' : ', 1 planet'), h[1], h[2], h[3], 0.0004, 30, 0, 0]);
    // "Inside the Orion nebula" goes where the catalogue puts it: a little in from the near edge, looking through the heart
    { const i = deep.find('Great Orion Nebula'); if (i >= 0) { const c = [deep.pos(i, 0), deep.pos(i, 1), deep.pos(i, 2)], n = Math.hypot(...c), k = 1 - deep.radius(i) * 0.55 / n; place(3, { p: [c[0] * k, c[1] * k, c[2] * k], at: c, up: [0, 0, 1] }); } }
  });

  // ---- GPU timing (timestamp queries, read back a frame or two late) and resolution scaling to hold the frame rate
  const ts = gpu.hasTS ? { set: device.createQuerySet({ type: 'timestamp', count: 2 }), resolve: device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }), read: device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), busy: false } : null;
  const tsBegin = ts && { querySet: ts.set, beginningOfPassWriteIndex: 0 }, tsEnd = ts && { querySet: ts.set, endOfPassWriteIndex: 1 };
  const gpuFail = () => { ts.busy = false; };
  const gpuDone = () => { const a = new BigInt64Array(ts.read.getMappedRange()); const ms = Number(a[1] - a[0]) / 1e6; ts.read.unmap(); ts.busy = false; if (ms > 0 && ms < 500) { gpuMs += (ms - gpuMs) * 0.1; if (bench) { bench.gpu.push(ms); bench.at.push(performance.now()); } } };
  let gpuMs = 0, frameMs = 8, bench = null, scaleT = 0, period = 1 / 30, dtK = 0, winN = 0, winLate = 0, holdT = 0, hold = 6, calm = 0, adaptMag = 0;
  let last = performance.now(), time = 0, frames = 0, fpsT = 0, fps = 0, cpuMs = 0;
  const dts = new Float32Array(128), dtSort = new Float32Array(128);
  let busy = false, exoFade = 0, conFade = 0, nameFade = 0, labelT = 1, pointGain = 1, procFade = 1;
  let starCtx = 1;
  const trail = new Float64Array(3), trailP = new Float64Array(3), rode = new Float64Array(3);   // streak vector, last camera place, how far a planet carried the camera this frame
  const DIFFUSE = 24;   // extended light is lifted relative to point sources, as dark-adapted eyes do
  const sm = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (document.hidden || busy) return;
    state.frames++;
    const t0 = performance.now();
    time += dt;
    // context distance: the nearest star (never closer than about ten solar radii) or the galaxy being crossed
    const gn = gal.near;
    // The nearest star's distance jumps about as stars go by, which made a held speed waver: it is followed
    // smoothly (half a second, in the logarithm). And the top third of the touch throttle is an overdrive that stops
    // slowing for single stars at all, so a galaxy can be crossed in seconds; nebulae, galaxies and planets still slow it.
    const od = sm(0.66, 1, Math.abs(flight.thr));
    const sd = Math.min(3e8, Math.max(2e-7, stars.near.dist) || 3e8);     // no star loaded yet: as if none were near
    starCtx = state.snap ? sd : starCtx * Math.pow(sd / starCtx, 1 - Math.exp(-dt * 2));
    let ctx = starCtx * Math.pow(1e6, od);
    if (gn.id >= 0) ctx = Math.min(ctx, Math.max(gn.edge, gal.radius(gn.id) * 0.03));
    if (show.proc) ctx = Math.min(ctx, gn.spacing * Math.pow(1e6, od));
    if (deep.near.id >= 0) ctx = Math.min(ctx, Math.max(deep.near.edge, deep.radius(deep.near.id) * 0.15));
    flight.context = Math.min(ctx, 3e8);
    const bn = bodies.near;
    if (bn.id >= 0) flight.context = Math.min(flight.context, Math.max(bn.alt, bodies.radius(bn.id) * 0.02));
    tick(now);   // the clock first, so that the flight, the lock and the picture all use this frame's positions
    // Lock: the camera keeps facing the target, and its range changes only while thrust toward or away from it is on,
    // so thrust sideways or up and down carries it around the target in a circle.
    const locked = flight.lock && target.on && !flight.goto && !state.frozen;
    let lx = 0, ly = 0, lz = 0, ld = 0, p0x = cam.p[0], p0y = cam.p[1], p0z = cam.p[2];
    if (locked) { lx = target.x - p0x; ly = target.y - p0y; lz = target.z - p0z; ld = Math.hypot(lx, ly, lz); }
    if (!state.frozen) { if (updateFlight(dt)) halt(); } else basis();
    if (locked && ld > 0) {
      const toward = ((cam.p[0] - p0x) * lx + (cam.p[1] - p0y) * ly + (cam.p[2] - p0z) * lz) / ld, floor = target.stop * 0.25, want = flight.ahead ? Math.max(ld - toward, floor) : ld;
      // as close as the lock goes: a throttle still pushing would only read as speed that goes nowhere
      if (flight.ahead && toward > 0 && ld - toward <= floor && (flight.thr > 0 || flight.cruise)) { halt(); flash('Arrived at ' + target.name); }
      let dx = target.x - cam.p[0], dy = target.y - cam.p[1], dz = target.z - cam.p[2]; const d = Math.hypot(dx, dy, dz);
      if (d > 0) {
        const k = want / d; cam.p[0] = target.x - dx * k; cam.p[1] = target.y - dy * k; cam.p[2] = target.z - dz * k;
        lookQuat(cam.q, dx, dy, dz, cam.up[0], cam.up[1], cam.up[2]); basis();
      }
    }
    // A named star's catalogued place and the place its point is drawn at (stored on a grid) can differ by a
    // fraction of an AU: close enough to tell, the target moves onto the star that is drawn.
    if (target.on && target.row[7] === 0) {
      const n = stars.near, ex = n.x - target.x, ey = n.y - target.y, ez = n.z - target.z, e = Math.hypot(ex, ey, ez);
      if (n.dist < 0.05 && e > 0 && e < Math.max(3 * stars.step, 2e-5)) {
        const r = target.row; r[2] = target.x = n.x; r[3] = target.y = n.y; r[4] = target.z = n.z;
        labels.move(tgtLabel, '\u25C7 ' + r[1], r[2], r[3], r[4], r[8]);
      }
    }
    if (infoRow && infoRow === target.row && now - infoAt >= 500) showFacts(infoRow);
    if (flight.sx !== joyX || flight.sy !== joyY) { joyX = flight.sx; joyY = flight.sy; const k = $('joyk'); k.style.transform = `translate(${(joyX * 26).toFixed(1)}px,${(-joyY * 26).toFixed(1)}px)`; k.className = joyX || joyY ? 'on' : ''; }
    if (flight.thr !== thrShown) { thrShown = flight.thr; const k = $('thrk'); k.style.transform = `translateY(${(-thrShown * innerHeight * 0.32).toFixed(1)}px)`; k.className = thrShown ? 'on' : ''; }
    bodies.update();

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
    const gainSB = 1.75 * sm(0.6, 2.0, out) + 1.0 * sm(3, 30, env);
    const gainPt = Math.min(5.6, 4.2 * Math.log10(Math.max(env / 0.7, 1)));
    const n = stars.near;
    let aim = exposureBase * Math.pow(10, 0.4 * gainSB);
    if (n.dist < 1e6) {
      const dx = n.x - cam.p[0], dy = n.y - cam.p[1], dz = n.z - cam.p[2], d = Math.max(n.dist, 1e-12);
      const cosA = (dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2]) / d;
      const inView = Math.max(0, Math.min(1, (cosA - 0.72) / 0.16));     // only while it is on screen: there is no air out here to scatter it
      const e1 = Math.pow(10, -0.4 * n.absmag) * 100 / (d * d);         // its energy at exposure 1
      // only part of the way, and never by more than a magnitude and a bit: the star glares, but the sky around it
      // stays full of stars however squarely it is faced
      if (e1 * inView * aim > E_MAX) aim *= Math.max(0.3, Math.pow(E_MAX / (e1 * inView * aim), 0.22));
    }
    if (state.snap) { exposure = aim; pointGain = Math.pow(10, 0.4 * gainPt); if (state.snap++ > 3) state.snap = 0; }
    exposure *= Math.pow(aim / exposure, 1 - Math.exp(-dt * (aim < exposure ? 6 : 1.5)));
    pointGain *= Math.pow(Math.pow(10, 0.4 * gainPt) / pointGain, 1 - Math.exp(-dt * 1.5));
    // catalogue stars keep their in-galaxy exposure: seen from outside they must not outshine the galaxy they sit in
    const starGain = Math.min(1, exposureBase / exposure * 1.0) ** 0.85;
    procFade += ((show.proc ? 1 : 0) - procFade) * (1 - Math.exp(-dt * 5));
    const magLimit = Math.min(magCap, -2.5 * Math.log10(E_THRESH / (exposure * starGain)) + quality.magBias + adaptMag);
    const galLimit = -2.5 * Math.log10(E_THRESH * 2.6 / (exposure * pointGain)) + quality.magBias + adaptMag;
    curMag = magLimit; curGal = galLimit;
    stars.update(magLimit);
    galPts.update(galLimit);
    gal.update(W, H, pxScale, pointGain, starGain);
    beyond.update(pointGain);
    // the web's glow belongs to the largest scale only: megaparsecs from the nearest catalogued galaxy
    if (web) web.update(state.skip.web ? 0 : sm(2.5e6, 1.2e7, gn.id >= 0 ? gn.dist : 1e9));
    deep.update((1 / Math.tan(cam.fov / 2)) * (H / pxScale) * 0.5);
    exoFade += ((show.exo ? 1 : 0) - exoFade) * (1 - Math.exp(-dt * 5));
    markers.update(exoFade);

    gf[0] = cam.right[0]; gf[1] = cam.right[1]; gf[2] = cam.right[2]; gf[3] = 1 / Math.tan(cam.fov / 2);
    gf[4] = cam.up[0]; gf[5] = cam.up[1]; gf[6] = cam.up[2]; gf[7] = W / H;
    gf[8] = cam.fwd[0]; gf[9] = cam.fwd[1]; gf[10] = cam.fwd[2]; gf[11] = exposure;
    gf[12] = W; gf[13] = H; gf[14] = time; gf[15] = pxScale;
    gf[16] = DIFFUSE; gf[17] = procFade;
    // Streaks: the camera's travel over a thirtieth of a second, taken from where it actually went (so a fly-to
    // counts), eased so it does not flicker, and held to half the distance of the nearest star so that only what
    // is close streaks. A jump (a viewpoint, a restored place) is not travel.
    {
      const jump = state.snap || dt <= 0, k = 1 - Math.exp(-dt * 8), cap = 0.5 * Math.min(starCtx, flight.context);
      for (let a = 0; a < 3; a++) { const v = jump ? 0 : (cam.p[a] - trailP[a] - rode[a]) / dt * 0.033; trail[a] = jump ? 0 : trail[a] + (v - trail[a]) * k; trailP[a] = cam.p[a]; rode[a] = 0; }
      const n = Math.hypot(trail[0], trail[1], trail[2]), f = !show.trails || n < 1e-30 ? 0 : Math.min(1, cap / n);
      gf[20] = trail[0] * f; gf[21] = trail[1] * f; gf[22] = trail[2] * f;
    }
    queue.writeBuffer(globalsBuf, 0, globals);

    // constellation figures fade out as the Sun's neighbourhood is left behind
    const fromSol = Math.hypot(cam.p[0], cam.p[1], cam.p[2]);
    conFade += ((show.lines ? 1 : 0) - conFade) * (1 - Math.exp(-dt * 5));
    const conVis = conFade * Math.max(0, Math.min(1, 1 - Math.log10(Math.max(fromSol, 1) / 150) / Math.log10(1000 / 150)));
    lines.gain[LG_CON] = conVis * Math.min(1, Math.sqrt(exposure / 32));
    // orbits: shown across the Solar System, fading close to a planet and out past the Kuiper belt
    lines.gain[LG_ORBIT] = conFade * sm(15, 150, bn.alt / bodies.radius(Math.max(bn.id, 0))) * (1 - sm(-3.3, -2.3, Math.log10(Math.max(fromSol, 1e-9))));
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
    // The target's marker: a ring on it while it is in view, and otherwise an arrow at the edge of the screen
    // pointing the way to turn to face it (behind you included).
    if (target.on) {
      const tx = target.x - cam.p[0], ty = target.y - cam.p[1], tz = target.z - cam.p[2];
      const vx = tx * cam.right[0] + ty * cam.right[1] + tz * cam.right[2], vy = tx * cam.up[0] + ty * cam.up[1] + tz * cam.up[2], vz = tx * cam.fwd[0] + ty * cam.fwd[1] + tz * cam.fwd[2];
      const f = 1 / Math.tan(cam.fov / 2), iw = innerWidth, ih = innerHeight, nx = vz > 0 ? vx / vz * f * ih / iw : 9, ny = vz > 0 ? vy / vz * f : 9, a = $('arr');
      const inView = vz > 0 && Math.abs(nx) < 0.9 && Math.abs(ny) < 0.86;
      let px, py, rot = 0;
      if (inView) { px = (nx + 1) * iw / 2; py = (1 - ny) * ih / 2; }
      else {
        // along the on-screen direction to it, out to an inset rectangle
        let ux = vx, uy = vy; const n = Math.hypot(ux, uy) || 1; ux /= n; uy /= n;
        const hw = iw / 2 - 96, hh = ih / 2 - 44, k = Math.min(hw / Math.max(Math.abs(ux), 1e-6), hh / Math.max(Math.abs(uy), 1e-6));
        px = iw / 2 + ux * k; py = ih / 2 - uy * k; rot = Math.atan2(-uy, ux);
      }
      // no ring once the target is a disc bigger than the ring
      const big = inView && target.row[8] / Math.hypot(tx, ty, tz) * f * ih / 2 > 15;
      a.className = big ? '' : inView ? 'on at' : 'on';
      a.style.transform = `translate(${px.toFixed(1)}px,${py.toFixed(1)}px) rotate(${rot.toFixed(3)}rad)`;
    }

    const enc = device.createCommandEncoder();
    // the GPU timer runs from the first pass of the frame (the volume pass when there is one) to the last
    const timed = ts && !ts.busy && (bench || showPerf || (state.frames & 3) === 0), sk = state.skip;
    const hadVol = !sk.vol && gal.drawVolumes(enc, timed ? tsBegin : undefined, sk.deep ? null : deep, web);
    const sceneDesc = post.sceneAttach(); sceneDesc.timestampWrites = timed && !hadVol ? tsBegin : undefined;
    const pass = enc.beginRenderPass(sceneDesc);
    if (!sk.gal) gal.draw(pass, hadVol, sk);
    if (!sk.deep) deep.draw(pass);
    if (!sk.galPts) galPts.draw(pass, pointGain);
    if (!sk.beyond) beyond.draw(pass);
    if (!sk.lines) lines.draw(pass);
    if (!sk.stars) stars.draw(pass, starGain);
    markers.draw(pass);
    if (!sk.bodies) bodies.draw(pass);
    if (!sk.labels) labels.draw(pass);
    pass.end();
    post.run(enc, gpu.offscreen ? offView : gpu.ctx.getCurrentTexture().createView(), time, 0.13, timed ? tsEnd : undefined);
    if (timed) { enc.resolveQuerySet(ts.set, 0, 2, ts.resolve, 0); enc.copyBufferToBuffer(ts.resolve, 0, ts.read, 0, 16); }
    queue.submit([enc.finish()]);
    if (timed) { ts.busy = true; ts.read.mapAsync(GPUMapMode.READ).then(gpuDone, gpuFail); }
    if (gpu.offscreen) { busy = true; queue.onSubmittedWorkDone().then(() => { busy = false; }); } // software rigs: never queue frames
    if (state.shot) { const r = state.shot; state.shot = null; r(); }

    cpuMs += (performance.now() - t0 - cpuMs) * 0.05;
    // Hold the display's frame rate by trading resolution. GPU time alone cannot steer this: an idle GPU clocks
    // down and reports long times for light frames. So the evidence for stepping down is frames actually missed
    // while the GPU is busy; stepping back up is tried whenever frames have been on time for a while, with a
    // hold after each retreat that doubles if the same step fails again.
    if (dt > 0) {
      frameMs += (dt * 1000 - frameMs) * 0.05;
      dts[dtK++ & 127] = dt; winN++; if (dt > period * 1.6) winLate++;
      if (bench) bench.frame.push(dt * 1000);
    }
    scaleT += dt; holdT -= dt;
    if (scaleT > 1.5) {
      const late = winLate / Math.max(1, winN), budget = period * 1000;
      scaleT = 0; winN = winLate = 0;
      // the display's refresh period: the median of recent frame intervals (they jitter a couple of ms either way).
      // Only ever revised downward, so a slow spell is not mistaken for a slower display.
      if (dtK >= 128) { dtSort.set(dts); dtSort.sort(); if (dtSort[64] < period) period = dtSort[64]; }
      if (!gpu.offscreen && !params.has('fixed')) {
        if (late > 0.04 && gpuMs > budget * 0.55 && (resScale > 0.45 || adaptMag > -2)) {
          // resolution first; once that is as low as it goes, fewer (fainter) stars, a quarter magnitude at a time
          if (resScale > 0.6 || adaptMag <= -2) { resScale = Math.max(0.45, resScale * 0.9); resize(); } else adaptMag -= 0.25;
          holdT = hold; hold = Math.min(60, hold * 2); calm = 0;
        } else if (late < 0.01) {
          if (++calm > 20) hold = 6;                                   // long quiet: forget the back-off
          if (holdT <= 0) { if (adaptMag < 0) adaptMag = Math.min(0, adaptMag + 0.125); else if (resScale < quality.startScale) { resScale = Math.min(quality.startScale, resScale * 1.06); resize(); } }
        } else calm = 0;
      }
    }
    frames++; fpsT += dt;
    if (fpsT >= 0.5) { fps = frames / fpsT; frames = 0; fpsT = 0; }
    hudT += dt;
    if (hudT > 0.2) {
      hudT = 0;
      $('hs').textContent = fmtSpeed(flight.speed);
      $('hd').textContent = fmtDist(Math.hypot(cam.p[0] - bodies.pos(3, 0), cam.p[1] - bodies.pos(3, 1), cam.p[2] - bodies.pos(3, 2)) - (bn.id === 3 ? bodies.radius(3) : 0));
      const fromMW = gal.near.id === 0 ? 0 : Math.hypot(cam.p[0] - gal.pos(0, 0), cam.p[1] - gal.pos(0, 1), cam.p[2] - gal.pos(0, 2));
      $('scale').textContent = fromSol < 0.01 ? 'Solar System' : fromSol < 1500 ? 'Stellar neighbourhood' : fromMW < 60000 ? 'Milky Way' : fromMW < 1.6e6 ? 'Local Group' : 'Cosmic web';
      $('hn').textContent = bn.alt < 2e-6 ? bodies.names[bn.id] + '  ' + fmtDist(bn.alt) : n.dist < 30 ? fmtDist(n.dist) : gn.id >= 0 ? gal.names[gn.id][0] + '  ' + fmtDist(gn.dist) : '';
      if (show.sound) updateSound(Math.max(0, Math.min(1, flight.speed / Math.max(flight.context, 1e-12) / 6)), fromSol < 0.01 ? 0 : fromSol < 1500 ? 1 : fromMW < 60000 ? 2 : fromMW < 1.6e6 ? 3 : 4, Math.max(0, Math.min(1, 1 - Math.log10(Math.max(stars.near.dist, 1e-6) / 1e-4) / 4)));
      if (target.on) { const td = Math.hypot(target.x - cam.p[0], target.y - cam.p[1], target.z - cam.p[2]); $('ht').textContent = target.name + '  ' + fmtDist(td); $('tbn').textContent = target.name + '  ' + fmtDist(td); $('tbgo').textContent = flight.goto ? 'Stop' : 'Fly there'; }
      if (showPerf) { const s = stars.stats(), g2 = galPts.stats(); $('perf').textContent = `${fps.toFixed(0)} fps  gpu ${gpuMs.toFixed(2)} ms  cpu ${cpuMs.toFixed(2)} ms\n${W}x${H}  scale ${resScale.toFixed(2)}\n${s.drawn.toLocaleString()} stars in ${s.tiles} tiles\n${s.loaded.toLocaleString()} loaded, ${s.pending} pending\nexposure ${exposure.toPrecision(3)}  mag ${magLimit.toFixed(1)} / ${galLimit.toFixed(1)}\n${g2.drawn.toLocaleString()} galaxies`; }
    }
  }
  say('Loading the nearest stars', 0.7);
  requestAnimationFrame(frame);
  // ready as soon as the first star tile (the brightest stars everywhere) is in: the rest streams in behind it
  // (out between the galaxies no star tile is wanted at all: then a few frames with nothing pending will do)
  await new Promise((r) => { const t = setInterval(() => { const s = stars.stats(); if (s.tiles > 0 || (s.pending === 0 && state.frames > 5)) { clearInterval(t); r(); } }, 50); });
  say('Ready', 1); $('go').disabled = false; body.classList.remove('l');
  keep('starhopperLoad', '');
  try { localStorage.removeItem('starhopperLoad'); } catch {}
  if (params.has('auto')) body.classList.add('fly');
  await extras.catch((e) => console.error(e));
  // hooks for the tests, the benchmark and screenshots
  // scripted fly-through of all eight viewpoints (about 90 s); resolves with frame and GPU time statistics
  // fly to a viewpoint and arrive looking the way it looks
  const poseQ = new Float64Array(4);
  const flyPose = (i, secs) => { freshNight(); going = null; const p = POSES[i]; lookQuat(poseQ, p.at[0] - p.p[0], p.at[1] - p.p[1], p.at[2] - p.p[2], p.up[0], p.up[1], p.up[2]); flyTo(p.p[0], p.p[1], p.p[2], 0, secs, poseQ); };
  const runBench = async (secs = 11) => {
    const stat = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? { avg: +(s.reduce((x, y) => x + y, 0) / s.length).toFixed(2), p99: +s[Math.floor(s.length * 0.99)].toFixed(2), max: +s[s.length - 1].toFixed(2), n: s.length } : null; };
    setPose(0); state.snap = 1; await new Promise((r) => setTimeout(r, 1500));
    bench = { frame: [], gpu: [], at: [] };
    const legs = [];
    for (let i = 1; i <= POSES.length; i++) { const p = POSES[i % POSES.length], g0 = bench.gpu.length, t0 = performance.now(); flyPose(i % POSES.length, secs); await new Promise((r) => setTimeout(r, secs * 1000 + 300)); const g = bench.gpu.slice(g0); legs.push({ to: p.name, avg: +(g.reduce((x, y) => x + y, 0) / Math.max(1, g.length)).toFixed(2), max: +Math.max(0, ...g).toFixed(2), maxAt: +((bench.at[g0 + g.indexOf(Math.max(0, ...g))] - t0) / 1000).toFixed(2), over: g.filter((x) => x > 8.3).length }); }
    const b = bench; bench = null;
    const budget = period * 1000;
    return { frameMs: stat(b.frame), gpuMs: stat(b.gpu), late: b.frame.filter((x) => x > budget * 1.6).length, gpuOver: b.gpu.filter((x) => x > 8.3).length, legs, size: [W, H], scale: resScale, level: LEVEL, mem: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null };
  };
  window.SH = { audioLevel: level, flyPose, deep, bodies, pick, target, labels, bench: runBench, perf: () => ({ fps: +fps.toFixed(1), gpuMs: +gpuMs.toFixed(2), cpuMs: +cpuMs.toFixed(2), size: [W, H], scale: resScale }), frames: () => state.frames, dbg: () => ({ exposure, pointGain, procFade, W, H, pxScale }), settle: () => { state.snap = 1; }, gal, galPts, POSES, setPose, show, cam, flight, stars, state, flyTo, lookQuat, basis, ready: true, capture, setExposure: (e) => { exposureBase = exposure = e; } };
}
main().catch((e) => { console.error(e); body.className = 'l e'; $('s').textContent = (e.cause ? '' : 'Failed to start: ') + e.message; });
