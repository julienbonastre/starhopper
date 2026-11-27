// Nebulae and star clusters from OpenNGC, at their catalogued position, size and brightness. Their shapes are a
// model (procedural fill): a short ray-march through a ball of noise whose recipe depends on the catalogued type.
// Open clusters near the Sun are left alone, since their stars are in the star catalogue already.
import { GLOBALS, HDR } from './gpu.js';
import { cam } from './camera.js';

const SHADER = /*wgsl*/`
${GLOBALS}
@group(0) @binding(1) var noiseTex: texture_3d<f32>;
@group(0) @binding(2) var noiseSmp: sampler;
const OMEGA = 1.3333e-6;     // solid angle of one reference pixel (see galaxies.js)
struct VO {
  @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(4) ndc: vec2f,
  @location(1) @interpolate(flat) c: vec4f,        // centre (camera-relative, pc), radius
  @location(2) @interpolate(flat) prm: vec4f,      // luminosity / R^2, kind, seed, weight of the resolved tier
  @location(3) @interpolate(flat) psf: vec2f,      // point tier: peak, sigma
}
fn vnoise(p: vec3f) -> f32 {
  let i = floor(p); var f = p - i; f = f * f * (3.0 - 2.0 * f);
  return textureSampleLevel(noiseTex, noiseSmp, (i + f + 0.5) / 64.0, 0.0).r;
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) c: vec4f, @location(1) prm: vec4f) -> VO {
  var o: VO;
  let corner = vec2f(f32(vi & 1u) * 2.0 - 1.0, f32(vi >> 1u) * 2.0 - 1.0);
  let d2 = max(dot(c.xyz, c.xyz), 1e-12); let dist = sqrt(d2);
  let sizePx = c.w / dist * G.focal * G.viewport.y * 0.5;            // radius in device pixels
  let w = smoothstep(1.2, 3.0, sizePx / G.pxScale) * G.proc;
  let e = G.exposure * prm.x * c.w * c.w / d2 * (1.0 - w) * G.pxScale * G.pxScale;
  let s0 = 1.0 * G.pxScale;
  let sigma = min(max(s0, sqrt(e / (6.2831853 * 2.6))), 8.0 * G.pxScale);
  let peak = min(e / (6.2831853 * sigma * sigma), 12.0);
  o.c = c; o.prm = vec4f(prm.xyz, w); o.psf = vec2f(peak, sigma);
  let p = project(c.xyz);
  let inside = dist < c.w * 1.3;
  if ((peak < 0.0035 && w <= 0.0) || (p.z > 1.0 && !inside)) { o.pos = vec4f(0.0, 0.0, 2.0, 1.0); return o; }
  if (inside) { o.pos = vec4f(corner, 0.5, 1.0); o.uv = corner * G.viewport; o.ndc = corner; return o; }
  let half = max(sigma * 3.6 + 1.0, select(0.0, sizePx * 1.35 + 2.0, w > 0.0));
  o.pos = vec4f(p.xy + corner * half * 2.0 / G.viewport, 0.5, 1.0);
  o.uv = corner * half; o.ndc = o.pos.xy;
  return o;
}
fn ign(p: vec2f) -> f32 { return 0.25 + 0.5 * fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715)))); }
const HA = vec3f(1.0, 0.16, 0.26);        // hydrogen alpha with a little H beta: the pink of emission nebulae
const O3 = vec3f(0.25, 0.95, 0.80);       // doubly ionised oxygen: teal
const DUSTBLUE = vec3f(0.36, 0.56, 1.0);  // starlight scattered by dust
const OLDSTAR = vec3f(1.0, 0.84, 0.62);
const YOUNGSTAR = vec3f(0.72, 0.82, 1.0);
@fragment fn fs(i: VO) -> @location(0) vec4f {
  var col = vec3f(0.0);
  let kind = i.prm.y; let sd = i.prm.z;
  if (i.psf.x > 0.0) {
    let r2 = dot(i.uv, i.uv) / (i.psf.y * i.psf.y);
    var tint = HA;
    if (kind == 6.0 || kind == 7.0) { tint = DUSTBLUE; } else if (kind == 1.0) { tint = OLDSTAR; } else if (kind == 0.0) { tint = YOUNGSTAR; } else if (kind == 3.0) { tint = O3; }
    col += mix(vec3f(1.0), tint, 0.6) * i.psf.x * exp(-0.5 * r2);
  }
  if (i.prm.w > 0.0) {
    // the view ray comes from the interpolated clip position, so this works in a target of any resolution
    let d = normalize(G.right * i.ndc.x * G.aspect / G.focal + G.up * i.ndc.y / G.focal + G.fwd);
    let R = i.c.w; let c = i.c.xyz / R;
    let b = dot(c, d); let p = c - d * b; let p2 = dot(p, p);
    if (p2 < 1.0) {
      let h = sqrt(1.0 - p2);
      let t0 = max(b - h, 0.0); let t1 = b + h;
      if (t1 > t0) {
        const N = 14.0;
        let jit = ign(i.pos.xy);
        var acc = vec3f(0.0); var tr = 1.0;
        let dt = (t1 - t0) / N;
        let gas = kind == 2.0 || kind == 4.0 || kind == 5.0;
        for (var s = 0.0; s < N; s += 1.0) {
          let tc = t0 + (s + jit) * dt;
          let q = d * tc - c;                                         // sample point, in radii from the centre
          let r = length(q);
          let w1 = q * 2.6 + sd; let n1 = vnoise(w1);
          let w2 = vec3f(w1.y * 0.8 + w1.z * 0.6, w1.z * 0.8 - w1.x * 0.6, w1.x) * 2.7 + 11.3; let n2 = vnoise(w2);
          let edge = 1.0 - smoothstep(0.75, 1.0, r);
          var em = vec3f(0.0); var dust = 0.0;
          if (kind == 1.0) {
            // globular cluster: a King-like core, grainy with unresolved stars
            em = OLDSTAR * (1.0 / 0.04) * pow(1.0 + r * r / 0.0144, -1.5) * (0.55 + 0.9 * vnoise(q * 37.0 + sd));
          } else if (kind == 0.0) {
            // distant open cluster: a loose, grainy glow
            em = YOUNGSTAR * (1.0 / 0.26) * exp(-r * r / 0.13) * (0.4 + 1.2 * vnoise(q * 31.0 + sd));
          } else if (kind == 3.0) {
            // planetary nebula: a shell, oxygen-teal inside and hydrogen-red at the rim
            let sh = exp(-(r - 0.62) * (r - 0.62) / 0.03) + 0.25 * exp(-r * r / 0.16);
            em = mix(O3, HA, smoothstep(0.5, 0.85, r)) * (1.0 / 1.6) * sh * (0.5 + n1 * 0.6 + n2 * 0.4);
          } else if (kind == 9.0) {
            // supernova remnant: a thin shell broken into filaments
            let sh = exp(-(r - 0.8) * (r - 0.8) / 0.012);
            let fil = pow(1.0 - abs(2.0 * n2 - 1.0), 6.0);
            em = mix(HA, O3, n1) * (1.0 / 0.22) * sh * fil + vec3f(0.5, 0.6, 1.0) * 0.25 * exp(-r * r / 0.05);
          } else {
            // gas and dust clouds. A slow warp of the radius gives lobes and bays instead of a round outline; three
            // octaves of noise give billows, bright rims where they fold, and dark lanes that really absorb.
            let n3 = vnoise(vec3f(w2.z * 0.6 - w2.x * 0.8, w2.y, w2.z * 0.8 + w2.x * 0.6) * 2.9 + 3.7);
            let rr = r * (0.6 + 0.95 * vnoise(q * 1.25 + sd * 0.7));
            let f = n1 * 0.5 + n2 * 0.3 + n3 * 0.2;
            let cloud = smoothstep(0.4, 0.62, f);
            let rim = pow(1.0 - abs(2.0 * (n2 * 0.6 + n3 * 0.4) - 1.0), 5.0);
            let body = exp(-rr * rr / 0.13);
            dust = body * smoothstep(0.48, 0.68, vnoise(w1 * 1.7 + 5.0) * 0.6 + n3 * 0.4) * 22.0;
            if (gas) {
              // emission: pink hydrogen, turning teal and far brighter toward the stars that light it
              let core = exp(-rr * rr / 0.022);
              // (the gas right around the camera is left out: from inside, it is the far walls that are seen)
              em = (HA * body * cloud * (0.12 + 3.4 * rim) + vec3f(0.80, 1.0, 0.92) * 7.0 * core * (0.35 + cloud)) * (1.0 / 0.42) * smoothstep(0.0, 0.4, tc);
            } else {
              // reflection: blue starlight on dust, in fine combed wisps
              let wisp = pow(1.0 - abs(2.0 * vnoise(vec3f(w2.x * 3.5, w2.y * 0.9, w2.z * 0.9)) - 1.0), 3.0);
              em = mix(DUSTBLUE, vec3f(0.62, 0.76, 1.0), cloud) * body * (0.04 + 1.3 * cloud * (0.35 + wisp)) * select(1.0 / 0.6, 1.0 / 0.2, kind == 6.0);
              dust *= 0.4;
            }
          }
          let a = exp(-dust * dt);
          acc += tr * em * edge * (1.0 + a) * 0.5;
          tr *= a;
        }
        col += acc * dt * i.prm.x * OMEGA * G.exposure * G.diffuse * 0.5 * i.prm.w;
      }
    }
  }
  return vec4f(col, 1.0);
}`;

// brightness when the catalogue gives no magnitude: a typical surface brightness for the type, so luminosity scales
// with area (absolute magnitude at a reference radius in parsecs)
const DEFAULT = [[-2.5, 3], [-7, 20], [-3.5, 8], [-0.5, 0.2], [-4, 10], [-3, 5], [-2, 2], [-0.5, 5], [0, 1], [-3, 10]];

export async function initDeep(gpu, globalsBuf, base, noise) {
  const { device, queue } = gpu;
  const data = await fetch(base + 'deep.json').then((r) => (r.ok ? r.json() : { kinds: [], objects: [] })).catch(() => ({ kinds: [], objects: [] }));
  // dark nebulae are not drawn (nothing here can dim what is behind them); the rest are
  const objs = data.objects.filter((o) => o[2] !== 8), N = objs.length;
  const pos = new Float64Array(N * 3), rad = new Float32Array(N), lum = new Float32Array(N), kind = new Uint8Array(N), seed = new Float32Array(N), absmag = new Float32Array(N);
  objs.forEach((o, i) => {
    pos[i * 3] = o[3]; pos[i * 3 + 1] = o[4]; pos[i * 3 + 2] = o[5]; rad[i] = o[6]; kind[i] = o[2]; seed[i] = (o[8] % 997) * 0.731;
    const d = Math.hypot(o[3], o[4], o[5]), def = DEFAULT[o[2]];
    absmag[i] = o[7] !== null ? o[7] - 5 * Math.log10(Math.max(d, 1) / 10) : def[0] - 5 * Math.log10(o[6] / def[1]);
    lum[i] = Math.pow(10, -0.4 * absmag[i]) * 100 / (o[6] * o[6]);
  });
  const module = device.createShaderModule({ code: SHADER });
  const layout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '3d' } }, { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} }] });
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: 32, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }, { shaderLocation: 1, offset: 16, format: 'float32x4' }] }] },
    fragment: { module, entryPoint: 'fs', targets: [{ format: HDR, blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } } }] },
    primitive: { topology: 'triangle-strip' },
  });
  const bind = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: globalsBuf } }, { binding: 1, resource: noise.view }, { binding: 2, resource: noise.sampler }] });
  const out = new Float32Array(Math.max(1, N) * 8), buf = device.createBuffer({ size: out.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  // objects that loom large are drawn into the reduced-resolution volume target instead (they are soft, and a
  // full-resolution march through one that fills the view costs milliseconds): up to BIG of them
  const BIG = 24, outBig = new Float32Array(BIG * 8), bufBig = device.createBuffer({ size: outBig.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  // nearest object: how far the camera is from its edge (pc), for the flight model
  const near = { id: -1, edge: Infinity };
  let live = 0, big = 0;
  // k: pixels (CSS) that one radian spans at the centre of the view
  function update(k) {
    live = 0; big = 0; near.edge = Infinity; near.id = -1;
    const px = cam.p[0], py = cam.p[1], pz = cam.p[2];
    for (let i = 0; i < N; i++) {
      const x = pos[i * 3] - px, y = pos[i * 3 + 1] - py, z = pos[i * 3 + 2] - pz, R = rad[i];
      const d = Math.sqrt(x * x + y * y + z * z);
      if (d - R * 0.5 < near.edge) { near.edge = d - R * 0.5; near.id = i; }
      // open clusters within reach of the star catalogue are made of real stars already
      if (kind[i] === 0 && Math.hypot(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]) < 1800) continue;
      if (d > R * 6e4) continue;                                    // far too small and faint to matter
      const isBig = big < BIG && R / Math.max(d, 1e-9) * k > 70, a = isBig ? outBig : out, o = (isBig ? big++ : live++) * 8;
      a[o] = x; a[o + 1] = y; a[o + 2] = z; a[o + 3] = R;
      a[o + 4] = lum[i]; a[o + 5] = kind[i]; a[o + 6] = seed[i]; a[o + 7] = 0;
    }
    if (live) queue.writeBuffer(buf, 0, out, 0, live * 8);
    if (big) queue.writeBuffer(bufBig, 0, outBig, 0, big * 8);
  }
  function draw(pass) { if (!live) return; pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.setVertexBuffer(0, buf); pass.draw(4, live); }
  function drawBig(pass) { if (!big) return; pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.setVertexBuffer(0, bufBig); pass.draw(4, big); }
  const find = (name) => objs.findIndex((o) => o[0] === name);
  return { update, draw, drawBig, hasBig: () => big > 0, near, find, count: N, name: (i) => objs[i][0], labelled: (i) => objs[i][1] === 1, pos: (i, a) => pos[i * 3 + a], radius: (i) => rad[i], absmag: (i) => absmag[i], kind: (i) => data.kinds[kind[i]] };
}
