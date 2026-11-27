// Exoplanet host stars (NASA Exoplanet Archive) as a layer of small rings around the stars that have known planets.
// The rings are a marking, not light: constant in size, fading with distance. Positions are made camera-relative on
// the CPU, and only while the layer is showing.
import { GLOBALS, HDR } from './gpu.js';
import { cam } from './camera.js';

const SHADER = /*wgsl*/`
${GLOBALS}
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) a: f32 }
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) p: vec4f) -> VO {
  var o: VO;
  let corner = vec2f(f32(vi & 1u) * 2.0 - 1.0, f32(vi >> 1u) * 2.0 - 1.0);
  let c = project(p.xyz);
  if (c.z > 1.0 || p.w <= 0.003) { o.pos = vec4f(0.0, 0.0, 2.0, 1.0); return o; }
  let half = 8.0 * G.pxScale;
  o.pos = vec4f(c.xy + corner * half * 2.0 / G.viewport, 0.5, 1.0);
  o.uv = corner * 8.0; o.a = p.w;
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let r = length(i.uv);
  let ring = clamp(1.0 - abs(r - 4.5) / 0.75, 0.0, 1.0);
  return vec4f(vec3f(0.25, 0.95, 0.75) * ring * i.a * 0.3, 1.0);
}`;

export function initMarkers(gpu, globalsBuf, hosts) {
  const { device, queue } = gpu;
  const N = hosts.length, pos = new Float64Array(N * 3), planets = new Uint8Array(N);
  hosts.forEach((h, i) => { pos[i * 3] = h[1]; pos[i * 3 + 1] = h[2]; pos[i * 3 + 2] = h[3]; planets[i] = h[4]; });
  const module = device.createShaderModule({ code: SHADER });
  const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }] });
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: 16, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] }] },
    fragment: { module, entryPoint: 'fs', targets: [{ format: HDR, blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } } }] },
    primitive: { topology: 'triangle-strip' },
  });
  const bind = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: globalsBuf } }] });
  const out = new Float32Array(Math.max(1, N) * 4), buf = device.createBuffer({ size: out.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  let on = false;
  // gain 0..1 fades the whole layer in and out
  function update(gain) {
    on = gain > 0.01 && N > 0; if (!on) return;
    const px = cam.p[0], py = cam.p[1], pz = cam.p[2];
    for (let i = 0; i < N; i++) {
      const x = pos[i * 3] - px, y = pos[i * 3 + 1] - py, z = pos[i * 3 + 2] - pz, d = Math.sqrt(x * x + y * y + z * z), o = i * 4;
      out[o] = x; out[o + 1] = y; out[o + 2] = z;
      // nearer hosts and richer systems stand out; past a few kiloparsecs the ring is gone
      out[o + 3] = gain * Math.max(0, Math.min(1, 1.25 - Math.log10(Math.max(d, 1)) / 3.4)) * (0.45 + 0.12 * Math.min(planets[i], 5));
    }
    queue.writeBuffer(buf, 0, out);
  }
  function draw(pass) { if (!on) return; pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.setVertexBuffer(0, buf); pass.draw(4, N); }
  return { update, draw, count: N };
}
