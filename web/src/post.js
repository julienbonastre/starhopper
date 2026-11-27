// HDR scene target, bloom (downsample / upsample chain) and the final tone-mapped, dithered composite
import { HDR } from './gpu.js';

const FS_TRI = /*wgsl*/`
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var o: VO; let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0); o.uv = vec2f(p.x, 1.0 - p.y); return o;
}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
`;
const DOWN = FS_TRI + /*wgsl*/`
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(src));
  // 13-tap downsample: wide enough that single bright pixels do not flicker between mips
  let a = textureSampleLevel(src, smp, i.uv + t * vec2f(-2.0, -2.0), 0.0).rgb; let b = textureSampleLevel(src, smp, i.uv + t * vec2f(0.0, -2.0), 0.0).rgb;
  let c = textureSampleLevel(src, smp, i.uv + t * vec2f(2.0, -2.0), 0.0).rgb;  let d = textureSampleLevel(src, smp, i.uv + t * vec2f(-2.0, 0.0), 0.0).rgb;
  let e = textureSampleLevel(src, smp, i.uv, 0.0).rgb;                         let f = textureSampleLevel(src, smp, i.uv + t * vec2f(2.0, 0.0), 0.0).rgb;
  let g = textureSampleLevel(src, smp, i.uv + t * vec2f(-2.0, 2.0), 0.0).rgb;  let h = textureSampleLevel(src, smp, i.uv + t * vec2f(0.0, 2.0), 0.0).rgb;
  let k = textureSampleLevel(src, smp, i.uv + t * vec2f(2.0, 2.0), 0.0).rgb;   let l = textureSampleLevel(src, smp, i.uv + t * vec2f(-1.0, -1.0), 0.0).rgb;
  let m = textureSampleLevel(src, smp, i.uv + t * vec2f(1.0, -1.0), 0.0).rgb;  let n = textureSampleLevel(src, smp, i.uv + t * vec2f(-1.0, 1.0), 0.0).rgb;
  let o = textureSampleLevel(src, smp, i.uv + t * vec2f(1.0, 1.0), 0.0).rgb;
  return vec4f(e * 0.125 + (a + c + g + k) * 0.03125 + (b + d + f + h) * 0.0625 + (l + m + n + o) * 0.125, 1.0);
}`;
const UP = FS_TRI + /*wgsl*/`
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(src));
  var c = textureSampleLevel(src, smp, i.uv, 0.0).rgb * 4.0;
  c += (textureSampleLevel(src, smp, i.uv + t * vec2f(-1.0, 0.0), 0.0).rgb + textureSampleLevel(src, smp, i.uv + t * vec2f(1.0, 0.0), 0.0).rgb
      + textureSampleLevel(src, smp, i.uv + t * vec2f(0.0, -1.0), 0.0).rgb + textureSampleLevel(src, smp, i.uv + t * vec2f(0.0, 1.0), 0.0).rgb) * 2.0;
  c += textureSampleLevel(src, smp, i.uv + t * vec2f(-1.0, -1.0), 0.0).rgb + textureSampleLevel(src, smp, i.uv + t * vec2f(1.0, -1.0), 0.0).rgb
     + textureSampleLevel(src, smp, i.uv + t * vec2f(-1.0, 1.0), 0.0).rgb + textureSampleLevel(src, smp, i.uv + t * vec2f(1.0, 1.0), 0.0).rgb;
  return vec4f(c / 16.0, 1.0);
}`;
const FINAL = FS_TRI + /*wgsl*/`
@group(0) @binding(2) var bloom: texture_2d<f32>;
@group(0) @binding(3) var<uniform> P: vec4f;   // bloom strength, time, unused, unused
fn hash(p: vec2f) -> f32 { var q = fract(vec3f(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
@fragment fn fs(i: VO) -> @location(0) vec4f {
  var c = textureSampleLevel(src, smp, i.uv, 0.0).rgb + textureSampleLevel(bloom, smp, i.uv, 0.0).rgb * P.x;
  c = c * c / (c + 0.020);                  // toe: keeps the sky black under the faint diffuse light
  c = 1.0 - exp(-c);                        // filmic shoulder: bright cores go to white, colours stay in the skirts
  c = pow(c, vec3f(1.0 / 2.2));
  let n = hash(i.pos.xy + fract(P.y) * 61.0) + hash(i.pos.yx + 17.0 + fract(P.y) * 37.0) - 1.0; // triangular dither against banding
  return vec4f(c + n / 255.0, 1.0);
}`;

export function initPost(gpu, quality) {
  const { device, format, queue } = gpu;
  const smp = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  const mk = (code, fmt, blend) => device.createRenderPipeline({
    layout: 'auto', vertex: { module: device.createShaderModule({ code }), entryPoint: 'vs' },
    fragment: { module: device.createShaderModule({ code }), entryPoint: 'fs', targets: [{ format: fmt, blend }] },
  });
  const add = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };
  const down = mk(DOWN, HDR), up = mk(UP, HDR, add), fin = mk(FINAL, format);
  const prm = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }), prmData = new Float32Array(4);
  let scene, sceneView, mips = [], downBind = [], upBind = [], finBind, attach;
  const MIPS = quality.bloomMips;

  function resize(w, h) {
    scene?.destroy(); mips.forEach((m) => m.tex.destroy());
    scene = device.createTexture({ size: [w, h], format: HDR, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    sceneView = scene.createView();
    mips = []; downBind = []; upBind = [];
    let mw = w, mh = h;
    for (let i = 0; i < MIPS; i++) {
      mw = Math.max(1, mw >> 1); mh = Math.max(1, mh >> 1);
      const tex = device.createTexture({ size: [mw, mh], format: HDR, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      mips.push({ tex, view: tex.createView() });
    }
    const bg = (p, view) => device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: view }, { binding: 1, resource: smp }] });
    for (let i = 0; i < MIPS; i++) downBind.push(bg(down, i ? mips[i - 1].view : sceneView));
    for (let i = MIPS - 1; i > 0; i--) upBind.push(bg(up, mips[i].view));
    finBind = device.createBindGroup({ layout: fin.getBindGroupLayout(0), entries: [{ binding: 0, resource: sceneView }, { binding: 1, resource: smp }, { binding: 2, resource: mips[0].view }, { binding: 3, resource: { buffer: prm } }] });
    // render pass descriptors are built once and reused every frame
    attach = {
      scene: { colorAttachments: [{ view: sceneView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] },
      down: mips.map((m) => ({ colorAttachments: [{ view: m.view, loadOp: 'clear', storeOp: 'store' }] })),
      up: mips.map((m) => ({ colorAttachments: [{ view: m.view, loadOp: 'load', storeOp: 'store' }] })),
      fin: { colorAttachments: [{ view: null, loadOp: 'clear', storeOp: 'store' }] },
    };
  }
  const tri = (enc, desc, pipe, bind) => { const p = enc.beginRenderPass(desc); p.setPipeline(pipe); p.setBindGroup(0, bind); p.draw(3); p.end(); };
  function run(enc, target, time, strength, timestampWrites) {
    for (let i = 0; i < MIPS; i++) tri(enc, attach.down[i], down, downBind[i]);
    for (let i = MIPS - 1, k = 0; i > 0; i--, k++) tri(enc, attach.up[i - 1], up, upBind[k]);
    prmData[0] = strength; prmData[1] = time; queue.writeBuffer(prm, 0, prmData);
    attach.fin.colorAttachments[0].view = target;
    attach.fin.timestampWrites = timestampWrites;
    tri(enc, attach.fin, fin, finBind);
  }
  return { resize, run, sceneAttach: () => attach.scene };
}
