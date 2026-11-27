// Point layers (stars, far galaxies): tile streaming, level-of-detail selection, the nearest-point tracker and the
// HDR point-sprite pass. A layer is an octree of tiles on its own integer grid (see pipeline/octree.mjs).
import { GLOBALS, HDR } from './gpu.js';
import { cam } from './camera.js';

const SHADER = /*wgsl*/`
${GLOBALS}
struct Layer {
  camQ: vec3i, pad0: i32,        // camera on this layer's grid: integer part
  camF: vec3f, step: f32,        // ... fractional part, and parsecs per grid unit
  far: vec3f, magOff: f32,       // offset used instead of camQ when the camera is outside the grid cube; absmag bias
  sigma0: f32, gain: f32,        // tightest sprite in CSS pixels; brightness multiplier (fades the layer)
}
@group(1) @binding(0) var<uniform> L: Layer;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) col: vec3f, @location(2) prm: vec4f, @location(3) seg: f32 }

// B-V colour index -> linear RGB of a black body at that temperature, luminance 1
fn starColour(bv: f32) -> vec3f {
  let t = 4600.0 * (1.0 / (0.92 * bv + 1.7) + 1.0 / (0.92 * bv + 0.62));
  let x = t / 100.0;
  var c: vec3f;
  if (x <= 66.0) { c.r = 1.0; c.g = clamp(0.390082 * log(x) - 0.631841, 0.0, 1.0); }
  else { c.r = clamp(1.292936 * pow(x - 60.0, -0.1332047), 0.0, 1.0); c.g = clamp(1.129891 * pow(x - 60.0, -0.0755148), 0.0, 1.0); }
  if (x >= 66.0) { c.b = 1.0; } else if (x <= 19.0) { c.b = 0.0; } else { c.b = clamp(0.543207 * log(x - 10.0) - 1.196254, 0.0, 1.0); }
  c = pow(c, vec3f(2.2));
  let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  return mix(vec3f(1.0), c / l, 1.7);  // extra saturation: star colours are subtle, and the eye wants to see them
}

const PEAK = 1.2;     // brighter stars grow instead of exceeding this centre value
const CORE = 3.2;     // ... up to this sigma in CSS pixels
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) s: vec4u) -> VO {
  var o: VO;
  let corner = vec2f(f32(vi & 1u) * 2.0 - 1.0, f32(vi >> 1u) * 2.0 - 1.0);
  let rel = (vec3f(vec3i(s.xyz) - L.camQ) - L.camF) * L.step + L.far;
  let d2 = max(dot(rel, rel), 1e-24);
  let absmag = f32(s.w >> 16u) * 0.001 - L.magOff;
  // energy in CSS-pixel units: exposure * 10^(-0.4 m), m = absmag + 5 log10(d / 10 pc)
  let e = G.exposure * L.gain * exp(-0.9210340 * absmag) * 100.0 / d2;
  var s0 = L.sigma0 * G.pxScale;
  if (L.sigma0 > 0.9) { s0 *= 0.85 + 0.55 * fract(f32((s.x * 7u + s.y * 13u + s.z * 29u) & 1023u) / 1024.0 * 7.13); }   // galaxies come in sizes
  // A star's disc grows with its brightness only so far (CORE pixels): beyond that it would read as a ball. The
  // rest shows as glare, a wide soft halo whose reach grows with the logarithm of the excess.
  let ep = e * G.pxScale * G.pxScale;
  // galaxies are extended: the brighter ones spread into soft blobs long before a star would
  let pk = select(PEAK, 0.3, L.sigma0 > 0.9);
  let sigma = min(max(s0, sqrt(ep / (6.2831853 * pk))), CORE * G.pxScale);
  let peak = min(ep / (6.2831853 * sigma * sigma), 40.0);
  let over = log2(1.0 + ep / (6.2831853 * PEAK * CORE * CORE * G.pxScale * G.pxScale));   // 1 where the disc stops growing
  let glare = smoothstep(0.6, 1.6, over);
  // the sprite only needs to reach where its Gaussian has faded from sight: most stars are faint, and a snug quad
  // for them saves most of the fill
  let snug = clamp(sqrt(2.0 * log(max(peak / 0.0008, 1.2))), 0.9, 3.6);
  let reach = sigma * min(snug + 2.6 * over * glare, 40.0);
  let p = project(rel);
  if (peak < 0.0035 || p.z > 1.0) { o.pos = vec4f(0.0, 0.0, 2.0, 1.0); return o; }
  let half = reach + 1.0;
  // Speed: where this point was when the shutter opened. Flying fast, the near ones are drawn out into streaks
  // along their path across the view (the far ones barely move, as from a train window).
  var ax = vec2f(1.0, 0.0); var seg = 0.0; var mid = p.xy;
  let p1 = project(rel + G.motion);
  if (p1.z <= 1.0) {
    let st = (p1.xy - p.xy) * G.viewport * 0.5; let sl = length(st);
    if (sl > 0.75) { ax = st / sl; seg = min(sl, 110.0 * G.pxScale) * 0.5; mid = p.xy + ax * seg * 2.0 / G.viewport; }
  }
  let off = ax * corner.x * (half + seg) + vec2f(-ax.y, ax.x) * corner.y * half;
  o.pos = vec4f(mid + off * 2.0 / G.viewport, 0.5, 1.0);
  o.uv = vec2f(corner.x * (half + seg), corner.y * half);
  o.seg = seg;
  o.col = starColour(f32((s.w >> 8u) & 255u) / 80.0 - 0.5);
  if (L.sigma0 > 0.9) {
    // the galaxy layer: no two galaxies are alike, so each point gets its own size and tint (from its position)
    var hsh = fract(vec3f(s.xyz & vec3u(65535u)) * vec3f(0.1031, 0.1030, 0.0973)); hsh += dot(hsh, hsh.yzx + 33.33);
    let k = fract((hsh.x + hsh.y) * hsh.z);
    o.col = mix(vec3f(1.0, 0.80, 0.58), vec3f(0.66, 0.80, 1.0), k * k);
  }
  // the same light spread along the streak: dimmer, though less than in proportion, so that the streaks read
  o.prm = vec4f(peak / pow(1.0 + seg / (1.25 * sigma), 0.55), sigma, reach / sigma, min(0.045 * over, 0.7) * glare);
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let along = max(abs(i.uv.x) - i.seg, 0.0);                  // distance to the streak's segment (a point when still)
  let r2 = (along * along + i.uv.y * i.uv.y) / (i.prm.y * i.prm.y);
  let core = exp(-0.5 * r2);
  // glare: falls off as a power law and reaches zero at the edge of the sprite
  let q = clamp(1.0 - r2 / (i.prm.z * i.prm.z), 0.0, 1.0);
  let halo = i.prm.w / (1.0 + r2 * 0.5 + r2 * r2 * 0.004) * q * q;
  // faint wide skirt on bright stars, fading to zero at the quad edge
  let skirt = 0.035 / (1.0 + r2 * r2 * 0.08) * max(0.0, 1.0 - r2 / 12.96) * smoothstep(1.2, 3.0, i.prm.y / G.pxScale);
  return vec4f(i.col * i.prm.x * (core + skirt) + vec3f(1.0, 0.98, 0.95) * halo, 1.0);
}`;

const MAX_DRAW = 2048, FETCHES = 8, SCAN_PER_FRAME = 60000, UPLOAD_PER_FRAME = 400_000;   // bytes

let shared;   // pipeline and layouts, built once for all layers
export async function initPoints(gpu, globalsBuf, dir, quality, opt) {
  const { device, queue } = gpu;
  const idx = await (await fetch(dir + 'index.json')).json();
  const N = idx.nodes.length, HALF = idx.half, STEP = idx.step;
  const level = new Uint8Array(N), ox = new Float64Array(N), oy = new Float64Array(N), oz = new Float64Array(N), size = new Float64Array(N);
  const count = new Uint32Array(N), kids = new Int32Array(N * 8), qm = new Float32Array(N * 9);
  const state = new Uint8Array(N), lastUse = new Uint32Array(N), bufs = new Array(N).fill(null), cpu = new Array(N).fill(null);
  idx.nodes.forEach((n, i) => {
    level[i] = n[0]; size[i] = (2 * HALF) / 2 ** n[0];
    ox[i] = n[1] * size[i] - HALF; oy[i] = n[2] * size[i] - HALF; oz[i] = n[3] * size[i] - HALF;
    count[i] = n[4]; kids.set(n[5], i * 8); qm.set(n[6], i * 9);
  });
  if (!shared) {
    const module = device.createShaderModule({ code: SHADER });
    const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }] });
    const layerLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: {} }] });
    shared = { layerLayout, pipeline: device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout, layerLayout] }),
      vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: 16, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'uint32x4' }] }] },
      fragment: { module, entryPoint: 'fs', targets: [{ format: HDR, blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } } }] },
      primitive: { topology: 'triangle-strip' },
    }), bind: device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: globalsBuf } }] }) };
  }
  const { pipeline, bind } = shared;
  const layerData = new ArrayBuffer(64), lf = new Float32Array(layerData), li = new Int32Array(layerData);
  const layerBuf = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const layerBind = device.createBindGroup({ layout: shared.layerLayout, entries: [{ binding: 0, resource: { buffer: layerBuf } }] });

  const stack = new Int32Array(256), drawId = new Int32Array(MAX_DRAW), drawCount = new Uint32Array(MAX_DRAW), drawDist = new Float64Array(MAX_DRAW);
  const wantId = new Int32Array(FETCHES);
  let nDraw = 0, loading = 0, frame = 0, loadedStars = 0, drawnStars = 0, pending = 0;
  // the star nearest the camera (found by scanning the loaded tiles a slice at a time)
  const near = { dist: Infinity, x: 0, y: 0, z: 0, absmag: 0, ci: 0.65, tile: -1, k: -1 };
  let scanT = 0, scanK = 0;

  const load = (i) => {
    state[i] = 1; loading++;
    fetch(dir + i + '.bin').then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }).then((ab) => { ready.push(i, ab); }).catch(() => { state[i] = 0; loading--; });
  };
  // Tiles that have arrived wait here and go to the GPU a little at a time, so a burst of arrivals (flying back into
  // a galaxy) never lands in one frame.
  const ready = [];
  const upload = () => {
    let bytes = 0;
    while (ready.length && bytes < UPLOAD_PER_FRAME) {
      const i = ready.shift(), ab = ready.shift();
      const b = device.createBuffer({ size: ab.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      queue.writeBuffer(b, 0, ab); bytes += ab.byteLength;
      bufs[i] = b; cpu[i] = new Uint32Array(ab); state[i] = 2; loadedStars += count[i]; lastUse[i] = frame; loading--;
    }
  };
  const evict = () => {
    // drop the least recently used tiles that are not needed any more
    while (loadedStars > opt.budget) {
      let best = -1, age = 120;
      for (let i = 0; i < N; i++) if (state[i] === 2 && frame - lastUse[i] > age) { age = frame - lastUse[i]; best = i; }
      if (best < 0) break;
      bufs[best].destroy(); bufs[best] = null; cpu[best] = null; state[best] = 0; loadedStars -= count[best];
      if (near.tile === best) near.tile = -1;
    }
  };

  // magLimit: faintest apparent magnitude that still draws. Chooses tiles and, in each, the brightest-first prefix.
  function update(magLimit) {
    frame++;
    if (ready.length) upload();
    const px = cam.p[0], py = cam.p[1], pz = cam.p[2];
    let sp = 0, nWant = 0;
    nDraw = 0; drawnStars = 0; pending = 0;
    stack[sp++] = 0;
    while (sp) {
      const i = stack[--sp], s = size[i];
      const dx = Math.max(ox[i] - px, 0, px - ox[i] - s), dy = Math.max(oy[i] - py, 0, py - oy[i] - s), dz = Math.max(oz[i] - pz, 0, pz - oz[i] - s);
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // faintest absolute magnitude visible from the nearest point of this node
      const need = d > 1e-9 ? magLimit - 5 * Math.log10(d / 10) : Infinity;
      if (qm[i * 9] > need) continue;                         // not even its brightest star shows
      for (let c = 0; c < 8; c++) { const k = kids[i * 8 + c]; if (k >= 0 && sp < 255) stack[sp++] = k; }
      if (state[i] === 2) {
        lastUse[i] = frame;
        let n = count[i];
        if (qm[i * 9 + 8] > need) { let r = 1; while (r < 8 && qm[i * 9 + r] <= need) r++; n = Math.min(n, Math.ceil((r / 8) * (n - 1)) + 1); }
        if (nDraw < MAX_DRAW) { drawId[nDraw] = i; drawCount[nDraw] = n; drawDist[nDraw] = d; nDraw++; drawnStars += n; }
      } else if (state[i] === 0) { pending++; if (nWant < FETCHES) wantId[nWant++] = i; else for (let w = 0; w < FETCHES; w++) if (level[wantId[w]] > level[i]) { wantId[w] = i; break; } }
      else pending++;
    }
    for (let w = 0; w < nWant && loading < FETCHES; w++) load(wantId[w]);
    if ((frame & 63) === 0) evict();
    if (opt.track) trackNearest();
  }

  function trackNearest() {
    const cx = (cam.p[0] + HALF) / STEP, cy = (cam.p[1] + HALF) / STEP, cz = (cam.p[2] + HALF) / STEP;
    if (near.tile >= 0 && cpu[near.tile]) {
      const a = cpu[near.tile], k = near.k * 4, dx = a[k] - cx, dy = a[k + 1] - cy, dz = a[k + 2] - cz;
      near.dist = Math.sqrt(dx * dx + dy * dy + dz * dz) * STEP;
    } else { near.dist = Infinity; near.tile = -1; }
    let budget = SCAN_PER_FRAME, guard = nDraw + 1;
    while (budget > 0 && nDraw && guard-- > 0) {
      if (scanT >= nDraw) { scanT = 0; scanK = 0; }
      const t = drawId[scanT], a = cpu[t];
      if (!a || drawDist[scanT] > near.dist) { scanT++; scanK = 0; continue; }
      const end = Math.min(count[t], scanK + budget);
      let best = near.dist / STEP; best *= best;
      for (let k = scanK; k < end; k++) {
        const dx = a[k * 4] - cx, dy = a[k * 4 + 1] - cy, dz = a[k * 4 + 2] - cz, d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < best) { best = d2; near.tile = t; near.k = k; }
      }
      near.dist = Math.sqrt(best) * STEP;
      budget -= end - scanK; scanK = end;
      if (scanK >= count[t]) { scanT++; scanK = 0; }
    }
    if (near.tile >= 0 && cpu[near.tile]) {
      const a = cpu[near.tile], k = near.k * 4;
      near.x = a[k] * STEP - HALF; near.y = a[k + 1] * STEP - HALF; near.z = a[k + 2] * STEP - HALF;
      near.absmag = (a[k + 3] >>> 16) * 0.001 - opt.magOff; near.ci = ((a[k + 3] >>> 8) & 255) / 80 - 0.5;
    }
  }

  function draw(pass, gain) {
    // this layer's camera: exact integer + fraction on its grid, or a plain offset once outside the cube
    let inside = true;
    for (let a = 0; a < 3; a++) if (Math.abs(cam.p[a]) >= HALF) inside = false;
    for (let a = 0; a < 3; a++) {
      if (inside) { const g = (cam.p[a] + HALF) / STEP, q = Math.floor(g); li[a] = q; lf[4 + a] = g - q; lf[8 + a] = 0; }
      else { li[a] = 0; lf[4 + a] = 0; lf[8 + a] = -HALF - cam.p[a]; }
    }
    lf[7] = STEP; lf[11] = opt.magOff; lf[12] = opt.sigma0; lf[13] = gain;
    queue.writeBuffer(layerBuf, 0, layerData);
    if (gain <= 0.001) return;
    pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.setBindGroup(1, layerBind);
    for (let k = 0; k < nDraw; k++) { pass.setVertexBuffer(0, bufs[drawId[k]]); pass.draw(4, drawCount[k]); }
  }
  return { update, draw, near, half: HALF, step: STEP, stats: () => ({ tiles: nDraw, drawn: drawnStars, loaded: loadedStars, pending, loading }) };
}
