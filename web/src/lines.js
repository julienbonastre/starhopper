// Thick anti-aliased line segments between float64 world points (constellation figures, orbits).
// Endpoints are made camera-relative on the CPU each frame, so they stay exact at any scale.
import { GLOBALS, HDR } from './gpu.js';
import { cam } from './camera.js';

const SHADER = /*wgsl*/`
${GLOBALS}
struct VO { @builtin(position) pos: vec4f, @location(0) col: vec4f, @location(1) side: f32 }
fn toView(p: vec3f) -> vec3f { return vec3f(dot(p, G.right), dot(p, G.up), dot(p, G.fwd)); }
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) a: vec3f, @location(1) b: vec3f, @location(2) col: vec4f) -> VO {
  var o: VO;
  var va = toView(a); var vb = toView(b);
  let eps = 1e-4 * max(length(va), length(vb));
  if (va.z < eps && vb.z < eps) { o.pos = vec4f(0.0, 0.0, 2.0, 1.0); return o; }
  if (va.z < eps) { va = mix(va, vb, (eps - va.z) / (vb.z - va.z)); }
  if (vb.z < eps) { vb = mix(vb, va, (eps - vb.z) / (va.z - vb.z)); }
  let k = vec2f(G.focal / G.aspect, G.focal);
  let na = va.xy * k / va.z; let nb = vb.xy * k / vb.z;
  var dir = (nb - na) * G.viewport;
  let len = length(dir);
  if (len < 1e-5) { dir = vec2f(1.0, 0.0); } else { dir = dir / len; }
  let side = f32(vi & 1u) * 2.0 - 1.0;
  let w = col.a * G.pxScale + 1.0;                    // half width in device pixels, +1 for the soft edge
  let p = select(na, nb, vi >= 2u) + vec2f(-dir.y, dir.x) * side * w * 2.0 / G.viewport;
  o.pos = vec4f(p, 0.5, 1.0);
  o.col = col; o.side = side * w;
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let a = clamp(i.col.a * G.pxScale + 0.5 - abs(i.side), 0.0, 1.0);
  return vec4f(i.col.rgb * a, 1.0);
}`;

export function initLines(gpu, globalsBuf, maxSegs) {
  const { device, queue } = gpu;
  const module = device.createShaderModule({ code: SHADER });
  const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }] });
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: 40, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32x4' }] }] },
    fragment: { module, entryPoint: 'fs', targets: [{ format: HDR, blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } } }] },
    primitive: { topology: 'triangle-strip' },
  });
  const bind = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: globalsBuf } }] });
  const src = new Float64Array(maxSegs * 6), rgbw = new Float32Array(maxSegs * 4), group = new Uint8Array(maxSegs);
  const out = new Float32Array(maxSegs * 10), buf = device.createBuffer({ size: out.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  const gain = new Float32Array(16).fill(1);      // per-group brightness, set each frame by the owner
  let n = 0, live = 0;
  // add one segment; width is the half width in CSS pixels
  function add(ax, ay, az, bx, by, bz, r, g, b, width, grp) {
    if (n >= maxSegs) return;
    src.set([ax, ay, az, bx, by, bz], n * 6); rgbw.set([r, g, b, width], n * 4); group[n] = grp; n++;
  }
  function update() {
    live = 0;
    const px = cam.p[0], py = cam.p[1], pz = cam.p[2];
    for (let i = 0; i < n; i++) {
      const k = gain[group[i]];
      if (k <= 0.002) continue;
      const o = live * 10, s = i * 6, c = i * 4;
      out[o] = src[s] - px; out[o + 1] = src[s + 1] - py; out[o + 2] = src[s + 2] - pz;
      out[o + 3] = src[s + 3] - px; out[o + 4] = src[s + 4] - py; out[o + 5] = src[s + 5] - pz;
      out[o + 6] = rgbw[c] * k; out[o + 7] = rgbw[c + 1] * k; out[o + 8] = rgbw[c + 2] * k; out[o + 9] = rgbw[c + 3];
      live++;
    }
    if (live) queue.writeBuffer(buf, 0, out, 0, live * 10);
  }
  function draw(pass) { if (!live) return; pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.setVertexBuffer(0, buf); pass.draw(4, live); }
  return { add, update, draw, gain };
}
