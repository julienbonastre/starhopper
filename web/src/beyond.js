// Galaxies beyond the reach of the survey: a statistical continuation of the large-scale structure, so the map does
// not end in a wall. Procedural fill, hidden by the "measured only" toggle. Points live on world-anchored lattices
// (one per luminosity class), thinned by a cosmic-web density made of ridged noise, and only appear where the
// catalogue has run out for that class: far away, and behind the plane of the Milky Way, which hides the sky.
import { GLOBALS, HDR } from './gpu.js';
import { cam } from './camera.js';
import { NGP } from './poses.js';

const SHADER = /*wgsl*/`
${GLOBALS}
@group(0) @binding(1) var noiseTex: texture_3d<f32>;
@group(0) @binding(2) var noiseSmp: sampler;
struct Fill { cell: vec3i, n: i32, frac: vec3f, size: f32, cam: vec3f, mag: f32, per: u32, level: u32, expect: f32, gain: f32, lo: f32, hi: f32, p0: f32, p1: f32, pole: vec3f, p2: f32 }
@group(1) @binding(0) var<uniform> F: Fill;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) col: vec3f, @location(2) prm: vec2f }
fn pcg3(v: vec3u) -> vec3u {
  var x = v * 1664525u + 1013904223u;
  x.x += x.y * x.z; x.y += x.z * x.x; x.z += x.x * x.y; x ^= x >> vec3u(16u);
  x.x += x.y * x.z; x.y += x.z * x.x; x.z += x.x * x.y; return x;
}
fn vnoise(p: vec3f) -> f32 {
  let i = floor(p); var f = p - i; f = f * f * (3.0 - 2.0 * f);
  return textureSampleLevel(noiseTex, noiseSmp, (i + f + 0.5) / 64.0, 0.0).r;
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  var o: VO; o.pos = vec4f(0.0, 0.0, 2.0, 1.0);
  let corner = vec2f(f32(vi & 1u) * 2.0 - 1.0, f32(vi >> 1u) * 2.0 - 1.0);
  let ci = ii / F.per; let n = u32(F.n);
  let g = vec3i(i32(ci % n), i32((ci / n) % n), i32(ci / (n * n))) - F.n / 2;
  let h = pcg3(bitcast<vec3u>(F.cell + g) + vec3u(ii % F.per, F.level * 7919u + 77u, 0u));
  let h2 = pcg3(h);
  let u1 = vec3f(h) / 4294967296.0; let u2 = vec3f(h2) / 4294967296.0;
  let rel = (vec3f(g) + u1 - F.frac) * F.size;
  let world = rel + F.cam;                                  // from the Sun
  let D = length(world);
  // where the survey has run out for this class: beyond its reach, or behind the Milky Way's disc
  let sb = abs(dot(world, F.pole)) / max(D, 1.0);
  let need = max(smoothstep(F.lo, F.hi, D), (1.0 - smoothstep(0.09, 0.2, sb)) * smoothstep(1.5e7, 5.0e7, D));
  if (need <= 0.0) { return o; }
  // the web: a wall wherever one noise field crosses its mid-level, a filament where two walls meet, a cluster
  // where the filaments knot; voids everywhere else
  let q = world / 6.0e7;
  let t1 = (vnoise(q + 3.1) * 0.7 + vnoise(q * 2.6 + 17.0) * 0.3 - 0.5) / 0.1;
  let t2 = (vnoise(q.zxy * 1.1 + 41.7) * 0.7 + vnoise(q.yzx * 2.9 + 5.3) * 0.3 - 0.5) / 0.1;
  let r1 = exp(-t1 * t1 * 3.0); let r2 = exp(-t2 * t2 * 1.6);
  let web = 7.0 * r1 * r2 + 0.7 * r1 + 0.015;
  if (u2.x >= F.expect * web * need) { return o; }
  let absmag = F.mag + (u2.y - 0.5) * 2.0;
  let d2 = max(dot(rel, rel), 1.0);
  let fade = 1.0 - smoothstep(0.8, 1.0, max(abs(f32(g.x)), max(abs(f32(g.y)), abs(f32(g.z)))) / f32(F.n / 2));
  let e = G.exposure * F.gain * fade * G.proc * exp(-0.9210340 * absmag) * 100.0 / d2 * G.pxScale * G.pxScale;
  let s0 = 1.0 * G.pxScale;
  let sigma = min(max(s0, sqrt(e / (6.2831853 * 2.6))), 6.0 * G.pxScale);
  let peak = min(e / (6.2831853 * sigma * sigma), 20.0);
  let p = project(rel);
  if (peak < 0.0035 || p.z > 1.0) { return o; }
  let half = sigma * clamp(sqrt(2.0 * log(max(peak / 0.0008, 1.2))), 0.9, 3.6) + 1.0;
  o.pos = vec4f(p.xy + corner * half * 2.0 / G.viewport, 0.5, 1.0);
  o.uv = corner * half; o.prm = vec2f(peak, sigma);
  o.col = mix(vec3f(1.0, 0.86, 0.68), vec3f(0.78, 0.86, 1.0), u2.z * u2.z);      // mostly old and yellow, some blue
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  return vec4f(i.col * i.prm.x * exp(-0.5 * dot(i.uv, i.uv) / (i.prm.y * i.prm.y)), 1.0);
}`;
// luminosity classes: absolute magnitude, cell size (pc), galaxies per cell, space density (per cubic Mpc, from the
// galaxy luminosity function), and the distances from the Sun between which the survey loses this class
const CLASSES = [
  { mag: -19, size: 6e6, per: 2, dens: 4e-3, lo: 4e7, hi: 1.3e8 },
  { mag: -20.7, size: 2.4e7, per: 12, dens: 5e-4, lo: 8e7, hi: 2.2e8 },
  { mag: -22.2, size: 9.6e7, per: 12, dens: 8e-6, lo: 1.6e8, hi: 2.7e8 },
];

export function initBeyond(gpu, globalsBuf, noise, grid = 28) {
  const { device, queue } = gpu;
  const module = device.createShaderModule({ code: SHADER });
  const l0 = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }, { binding: 1, visibility: GPUShaderStage.VERTEX, texture: { viewDimension: '3d' } }, { binding: 2, visibility: GPUShaderStage.VERTEX, sampler: {} }] });
  const l1 = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: {} }] });
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [l0, l1] }), vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: HDR, blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } } }] },
    primitive: { topology: 'triangle-strip' },
  });
  const bind = device.createBindGroup({ layout: l0, entries: [{ binding: 0, resource: { buffer: globalsBuf } }, { binding: 1, resource: noise.view }, { binding: 2, resource: noise.sampler }] });
  const levels = CLASSES.map((c, level) => {
    const data = new ArrayBuffer(96), buf = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    return { c, level, data, f: new Float32Array(data), i: new Int32Array(data), buf, bind: device.createBindGroup({ layout: l1, entries: [{ binding: 0, resource: { buffer: buf } }] }) };
  });
  let on = false;
  // gain: the same lift the catalogued galaxy points get in the voids. Nothing is drawn from inside a galaxy.
  function update(gain) {
    on = gain > 1.3; if (!on) return;
    for (const L of levels) {
      const c = L.c.size;
      for (let a = 0; a < 3; a++) { const g = cam.p[a] / c, q = Math.floor(g); L.i[a] = q; L.f[4 + a] = g - q; L.f[8 + a] = cam.p[a]; L.f[20 + a] = NGP[a]; }
      L.i[3] = grid; L.f[7] = c; L.f[11] = L.c.mag; L.i[12] = L.c.per; L.i[13] = L.level;
      L.f[14] = L.c.dens * (c / 1e6) ** 3 / L.c.per; L.f[15] = gain; L.f[16] = L.c.lo; L.f[17] = L.c.hi;
      queue.writeBuffer(L.buf, 0, L.data);
    }
  }
  function draw(pass) {
    if (!on) return;
    pass.setPipeline(pipeline); pass.setBindGroup(0, bind);
    for (const L of levels) { pass.setBindGroup(1, L.bind); pass.draw(4, grid * grid * grid * L.c.per); }
  }
  return { update, draw };
}
