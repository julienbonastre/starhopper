// The cosmic web as light: the survey's galaxies, counted into a density grid by the pipeline (corrected for how the
// survey thins out with distance, then smoothed), marched through as a faint glow. Filaments and clusters brighten
// and voids stay black, which thousands of separate points cannot show on their own. Drawn into the reduced-
// resolution volume target, and only out in intergalactic space. Hidden by the "measured only" toggle: the points
// are the measurement, this is a rendering of their density.
import { GLOBALS, HDR } from './gpu.js';
import { cam } from './camera.js';

const SHADER = /*wgsl*/`
${GLOBALS}
struct Web { cam: vec3f, gain: f32 }
@group(0) @binding(1) var<uniform> W: Web;
@group(0) @binding(2) var tex: texture_3d<f32>;
@group(0) @binding(3) var smp: sampler;
struct VO { @builtin(position) pos: vec4f, @location(0) ndc: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var o: VO; let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  o.pos = vec4f(p, 0.0, 1.0); o.ndc = p; return o;
}
fn hash(p: vec2f) -> f32 { var q = fract(vec3f(p.xyx) * vec3f(0.1031, 0.1030, 0.0973)); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
const COOL = vec3f(0.30, 0.42, 1.0);      // thin filaments: young, blue galaxies
const WARM = vec3f(1.0, 0.80, 0.58);      // cluster cores: old, red ones
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let d = normalize(G.right * i.ndc.x * G.aspect / G.focal + G.up * i.ndc.y / G.focal + G.fwd);
  // the grid spans -1..1; the survey is a ball inside it
  let b = dot(W.cam, d); let c = dot(W.cam, W.cam) - 0.93; let disc = b * b - c;
  if (disc <= 0.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let sq = sqrt(disc); let t0 = max(-b - sq, 0.0); let t1 = min(-b + sq, t0 + 1.6);
  if (t1 <= t0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  const N = 28.0;
  let dt = (t1 - t0) / N; let jit = hash(i.pos.xy);
  var acc = vec3f(0.0);
  for (var s = 0.0; s < N; s += 1.0) {
    let t = t0 + (s + jit) * dt;
    let vr = textureSampleLevel(tex, smp, (W.cam + d * t) * 0.5 + 0.5, 0.0).r;
    let v = min(vr, 0.5);        // cluster cores would otherwise be fog banks      // square root of the density
    let v2 = v * v;
    // what is near counts for more, so the strands in front stand clear of the haze of everything behind them
    acc += mix(COOL, WARM, smoothstep(0.25, 0.8, v)) * (v2 * v * 1.6 + v2 * v2 * 1.2) * exp(-(t - t0) * 1.8) * smoothstep(0.03, 0.22, t);
  }
  return vec4f(acc * dt * W.gain * G.proc, 1.0);
}`;

export async function initWeb(gpu, globalsBuf, base) {
  const { device, queue } = gpu;
  const meta = await fetch(base + 'web.json').then((r) => r.json());
  const res = await fetch(base + 'web.bin.gz');
  const bytes = new Uint8Array(await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  const n = meta.n;
  const tex = device.createTexture({ size: [n, n, n], dimension: '3d', format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  queue.writeTexture({ texture: tex }, bytes, { bytesPerRow: n, rowsPerImage: n }, [n, n, n]);
  const module = device.createShaderModule({ code: SHADER });
  const add = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };
  const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: HDR, blend: add }] } });
  const data = new Float32Array(4), buf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: globalsBuf } }, { binding: 1, resource: { buffer: buf } }, { binding: 2, resource: tex.createView() },
    { binding: 3, resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) }] });
  let gain = 0;
  // g: 0 inside a galaxy .. 1 in the voids
  function update(g) {
    gain = g;
    if (g <= 0.002) return;
    data[0] = cam.p[0] / meta.half; data[1] = cam.p[1] / meta.half; data[2] = cam.p[2] / meta.half; data[3] = g * 0.75;
    queue.writeBuffer(buf, 0, data);
  }
  return { update, on: () => gain > 0.002, draw(pass) { pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.draw(3); } };
}
