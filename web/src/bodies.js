// The Solar System up close: the Sun and planets as lit spheres at their positions for the date, and the Earth with
// its Blue Marble face and a thin rim of atmosphere. Far away each body is a point of reflected sunlight with the
// right brightness; as it grows past a pixel it becomes a ray-traced sphere.
// Positions are float64 parsecs; each frame they are made camera-relative and scaled to the body's own radius on
// the CPU, so the shader's arithmetic stays exact from low orbit out to the edge of the system.
import { GLOBALS, HDR } from './gpu.js';
import { cam, PC_AU } from './camera.js';
import { SUN, PLANETS, MOON, planetPos, moonPos, bodyFrame } from './solar.js';

const KM_PC = 1 / 3.0856775814913673e13;
// geometric albedos (visual): how much sunlight each planet sends back at full phase
const ALBEDO = [0.142, 0.689, 0.434, 0.170, 0.538, 0.499, 0.488, 0.442, 0.12];   // the planets, then the Moon
const L_SUN = Math.pow(10, -0.4 * 4.83) * 100;     // the Sun in the star shader's units (absolute magnitude 4.83)

const SHADER = /*wgsl*/`
${GLOBALS}
@group(0) @binding(1) var earthTex: texture_2d<f32>;
@group(0) @binding(2) var earthSmp: sampler;
@group(0) @binding(3) var noiseTex: texture_3d<f32>;
@group(0) @binding(4) var noiseSmp: sampler;
fn vnoise(p: vec3f) -> f32 {
  let i = floor(p); var f = p - i; f = f * f * (3.0 - 2.0 * f);
  return textureSampleLevel(noiseTex, noiseSmp, (i + f + 0.5) / 64.0, 0.0).r;
}
struct VO {
  @builtin(position) pos: vec4f, @location(0) uv: vec2f,
  @location(1) @interpolate(flat) c: vec4f,        // centre in body radii (camera at the origin), kind
  @location(2) @interpolate(flat) col: vec4f,      // colour, radius in device pixels
  @location(3) @interpolate(flat) sun: vec4f,      // unit vector to the Sun, prime meridian angle
  @location(4) @interpolate(flat) ring: vec4f,     // north pole, ring inner radius (body radii); outer in psf.z
  @location(5) @interpolate(flat) psf: vec4f,      // point tier: peak, sigma; ring outer radius; sphere weight
  @location(6) @interpolate(flat) mapped: f32,     // 1 once the body's map has arrived
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) c: vec4f, @location(1) col: vec4f, @location(2) sun: vec4f, @location(3) ring: vec4f, @location(4) ex: vec4f) -> VO {
  var o: VO;
  let corner = vec2f(f32(vi & 1u) * 2.0 - 1.0, f32(vi >> 1u) * 2.0 - 1.0);
  let d = length(c.xyz);                             // distance in body radii
  let sinA = min(1.0 / d, 0.999);
  let rpx = sinA / sqrt(1.0 - sinA * sinA) * G.focal * G.viewport.y * 0.5;
  // reflected (or, for the Sun, no) point light; ex.x is the luminosity over distance squared
  let e = G.exposure * ex.x * G.pxScale * G.pxScale;
  let s0 = 0.62 * G.pxScale;
  // A planet close by would outshine everything at the exposure the stars are drawn at, and then turn into a far
  // dimmer disc: the point is held to the glare of a very bright star, and hands over to the disc as that appears.
  let sigma = min(max(s0, sqrt(e / (6.2831853 * 2.6))), 3.0 * G.pxScale);
  let w = smoothstep(0.7, 2.0, rpx);
  let peak = min(e / (6.2831853 * sigma * sigma), 2.6) * (1.0 - smoothstep(0.8, 3.0, rpx));
  let p = project(c.xyz);
  o.c = c; o.col = vec4f(col.rgb, rpx); o.sun = sun; o.ring = ring; o.psf = vec4f(peak, sigma, ex.y, w); o.mapped = ex.z;
  if ((peak < 0.0035 && w <= 0.0) || (p.z > 1.0 && sinA < 0.2)) { o.pos = vec4f(0.0, 0.0, 2.0, 1.0); return o; }
  if (sinA > 0.2) { o.pos = vec4f(corner, 0.5, 1.0); o.uv = corner * G.viewport; return o; }   // looming: cover the view
  // room for the limb glow or rings, and for the stretch of a sphere's outline toward the edge of a wide view
  let half = max(sigma * 3.6 + 1.0, select(0.0, rpx * max(1.7, ex.y * 1.25) + 2.0, w > 0.0));
  o.pos = vec4f(p.xy + corner * half * 2.0 / G.viewport, 0.5, 1.0);
  o.uv = corner * half;
  return o;
}
fn hash1(x: f32) -> f32 { return fract(sin(x * 127.1) * 43758.5453); }
@fragment fn fs(i: VO) -> @location(0) vec4f {
  var out = vec3f(0.0);
  var alpha = 0.0;
  let kind = i.c.w;
  if (i.psf.x > 0.0) {
    let r2 = dot(i.uv, i.uv) / (i.psf.y * i.psf.y);
    out += i.col.rgb / max(max(i.col.r, i.col.g), i.col.b) * i.psf.x * exp(-0.5 * r2);
  }
  if (i.psf.w > 0.0) {
    let ndc = (i.pos.xy / G.viewport * 2.0 - 1.0) * vec2f(1.0, -1.0);
    let d = normalize(G.right * ndc.x * G.aspect / G.focal + G.up * ndc.y / G.focal + G.fwd);
    let c = i.c.xyz;
    let b = dot(c, d);
    let p = c - d * b;                               // from the ray's closest point to the centre
    let p2 = dot(p, p);
    let l = i.sun.xyz;
    var body = vec3f(0.0); var cover = 0.0;
    if (p2 < 1.0 && b > 0.0) {
      let h = sqrt(1.0 - p2);
      let n = -p - d * h;                            // surface normal at the near hit
      let mu = max(dot(n, -d), 0.0);
      let lit = dot(n, l);
      // into the body's own turning frame (north pole, prime meridian), then longitude and latitude on its map
      let pole = i.ring.xyz;
      let ex = normalize(select(vec3f(-pole.y, pole.x, 0.0), vec3f(0.0, 1.0, 0.0), abs(pole.z) > 0.99999));
      let ey = cross(pole, ex);
      let cs = cos(i.sun.w); let sn = sin(i.sun.w);
      let nx = dot(n, ex); let ny = dot(n, ey);
      let e = vec3f(nx * cs + ny * sn, ny * cs - nx * sn, dot(n, pole));
      let uv = vec2f(fract(atan2(e.y, e.x) / 6.2831853 + 0.5), 0.5 - asin(clamp(e.z, -1.0, 1.0)) / 3.1415927);
      // the wrap in longitude would make the derivative jump: give the gradients explicitly from the pixel size
      let px = 1.0 / max(i.col.a * 3.14159, 1.0);
      let t = textureSampleGrad(earthTex, earthSmp, uv, vec2f(px * 0.5, 0.0), vec2f(0.0, px)).rgb;
      // the maps run out of detail up close: a little grain keeps them from looking smeared
      let near = smoothstep(120.0, 900.0, i.col.a);
      if (kind == 2.0) {
        // the Sun: limb-darkened and far above white, so the bloom gives it its glare
        body = i.col.rgb * (0.4 + 0.6 * mu) * mix(vec3f(1.0, 0.55, 0.25), vec3f(1.0), mu) * 14.0;
      } else if (kind == 1.0) {
        // Weather: the Blue Marble is a cloud-free mosaic, so the clouds are a model. Fractal noise on the sphere,
        // swirled, and thickest along the equator and the two storm belts.
        var cp = e * 2.6; cp += (vec3f(vnoise(cp * 0.9 + 4.0), vnoise(cp.yzx * 0.9 + 9.0), vnoise(cp.zxy * 0.9)) - 0.5) * 1.6;
        let cf = vnoise(cp) * 0.36 + vnoise(cp * 2.3 + 7.1) * 0.28 + vnoise(cp * 5.3 + 2.9) * 0.21 + (vnoise(cp * 12.1 + 5.5) * 0.15 - 0.075) * smoothstep(8.0, 60.0, i.col.a) + 0.075;
        let belt = 0.05 * cos(e.z * 10.5) - 0.07 * smoothstep(0.1, 0.45, abs(abs(e.z) - 0.42)) + 0.05;
        // fine structure once the clouds are close enough to show it
        let fine = (vnoise(cp * 27.0 + 1.7) - 0.5) * 0.10 + (vnoise(cp * 61.0 + 8.3) - 0.5) * 0.07;
        let cover = smoothstep(0.55, 0.66, cf + belt + fine * near) * 0.92;
        // the same field a little way toward the Sun: where it is cloudy there, this ground is in shadow
        let cps = cp + l * 0.035;
        let shade = smoothstep(0.55, 0.66, vnoise(cps) * 0.36 + vnoise(cps * 2.3 + 7.1) * 0.28 + vnoise(cps * 5.3 + 2.9) * 0.21 + 0.075 + belt) * near;
        let day = smoothstep(-0.08, 0.22, lit);
        let water = smoothstep(0.03, 0.12, t.b - max(t.r, t.g)) * (1.0 - cover);
        let hv = normalize(l - d);
        let glint = (pow(max(dot(n, hv), 0.0), 220.0) * 2.2 + pow(max(dot(n, hv), 0.0), 24.0) * 0.22) * water;
        // air: bluish scattering over everything, thickening toward the limb and warming at the terminator
        let air = pow(1.0 - mu, 4.0);
        let sky = mix(vec3f(0.25, 0.48, 1.0), vec3f(1.0, 0.45, 0.2), smoothstep(0.25, -0.05, lit) * smoothstep(-0.2, 0.0, lit));
        // the map runs out of detail up close: a little grain in the land keeps it from looking smeared
        let eg = 1.0 + (vnoise(e * 310.0) - 0.5) * 0.22 * near * (1.0 - water);
        let ground = mix(t * 1.12 * eg * (1.0 - 0.45 * shade), vec3f(0.93, 0.95, 1.0) * (0.86 + 0.28 * vnoise(cp * 14.0 + 3.0)), cover);
        body = (ground * max(lit, 0.0) + vec3f(1.0, 0.95, 0.85) * glint) * day;
        body = mix(body, sky * max(lit, 0.0) * 0.9, 0.09) + sky * air * 0.55 * smoothstep(-0.12, 0.15, lit);
      } else if (i.mapped > 0.5) {
        // a mapped body. The maps are pictures exposed for the page, so each is scaled to its body's brightness.
        let grain = 1.0 + ((vnoise(e * 310.0) - 0.5) * 0.2 + (vnoise(e * 1270.0) - 0.5) * 0.12) * near;
        if (kind == 3.0) {
          // cloud tops: darkening toward the limb, and a soft terminator
          body = t * 1.9 * smoothstep(-0.06, 0.5, lit) * max(lit, 0.0) * (0.3 + 0.7 * mu);
        } else if (kind == 4.0) {
          // airless dust throws light back the way it came: lit almost flat to the limb, as the full Moon is
          body = t * grain * 0.95 * smoothstep(0.0, 0.07, lit) * (0.35 + 0.65 * max(lit, 0.0) / (max(lit, 0.0) + mu + 0.02) * 2.0) * (0.85 + 0.15 * mu);
        } else {
          body = t * grain * 1.7 * max(lit, 0.0) * (0.45 + 0.55 * mu);
        }
      } else {
        var alb = i.col.rgb;
        if (kind == 3.0) {
          // gas giants: latitude bands about the spin axis (a stand-in until the map arrives)
          let lat = dot(n, i.ring.xyz);
          alb *= 1.0 + 0.16 * sin(lat * 23.0 + 2.0 * sin(lat * 7.0)) + 0.08 * sin(lat * 61.0);
        }
        body = alb * 2.4 * max(lit, 0.0) * (0.35 + 0.65 * mu);      // a little limb darkening
        if (kind == 4.0) {
          // the Moon: dark seas and a rough, cratered look (a stand-in until the map arrives), lit flat to the limb as
          // the full Moon is
          let sea = smoothstep(0.43, 0.57, vnoise(n * 2.3 + 11.0) * 0.6 + vnoise(n * 5.1 + 3.0) * 0.4);
          let rough = (0.86 + 0.28 * vnoise(n * 23.0)) * (0.92 + 0.16 * vnoise(n * 71.0));
          body = i.col.rgb * mix(0.5, 1.0, sea) * rough * 1.5 * max(lit, 0.0) * (0.8 + 0.2 * mu);
        }
      }
      cover = 1.0;
      // shadow of the rings is left out; the planet's shadow on the rings is not
    } else if (kind == 1.0 && b > 0.0) {
      // glow of the atmosphere just outside the limb (scale height stretched so it is a visible thread)
      let hgt = sqrt(p2) - 1.0;
      let nl = dot(normalize(-p), l);
      body = (vec3f(0.35, 0.6, 1.0) * exp(-hgt / 0.0045) * 0.9 + vec3f(0.2, 0.4, 1.0) * exp(-hgt / 0.016) * 0.3) * smoothstep(-0.25, 0.25, nl);
    } else if (kind == 2.0 && b > 0.0) {
      let hgt = sqrt(p2) - 1.0;
      body = i.col.rgb * (0.9 * exp(-hgt / 0.06) + 0.12 / (1.0 + hgt * hgt * 6.0)) * 1.5;   // inner corona
    }
    if (i.psf.z > 0.0) {
      // rings: where the ray meets the ring plane, in front of the planet or beside it
      let pole = i.ring.xyz;
      let dn = dot(d, pole);
      if (abs(dn) > 1e-5) {
        let t = dot(c, pole) / dn;
        let hit = d * t - c; let rr = length(hit);
        let front = t > 0.0 && (cover == 0.0 || t < b - sqrt(max(1.0 - p2, 0.0)));
        if (front && rr > i.ring.w && rr < i.psf.z) {
          let u = (rr - i.ring.w) / (i.psf.z - i.ring.w);
          // density: C ring faint, B bright, Cassini division, A, with fine ringlets from a hash
          var dens = smoothstep(0.0, 0.05, u) * (0.25 + 0.75 * smoothstep(0.28, 0.33, u)) * (1.0 - 0.9 * smoothstep(0.715, 0.73, u) * (1.0 - smoothstep(0.76, 0.775, u))) * (1.0 - smoothstep(0.97, 1.0, u));
          dens *= 0.75 + 0.25 * hash1(floor(u * 160.0));
          // in the planet's shadow?
          let sb = dot(-hit, l); let sp = -hit - l * sb;
          let shade = select(1.0, 0.0, sb > 0.0 && dot(sp, sp) < 1.0);
          let rc = vec3f(0.80, 0.72, 0.58) * 2.0 * (0.25 + 0.75 * abs(dot(pole, l))) * shade;
          body = mix(body, rc, dens); cover = max(cover, dens);
        }
      }
    }
    // premultiplied: solid parts replace what is behind them, glows add
    out += body * i.psf.w;
    alpha = cover * i.psf.w;
  }
  return vec4f(out, alpha);
}`;
const MIP = /*wgsl*/`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO { var o: VO; let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)); o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0); o.uv = vec2f(p.x, 1.0 - p.y); return o; }
@fragment fn fs(i: VO) -> @location(0) vec4f { return textureSampleLevel(src, smp, i.uv, 0.0); }`;

export function initBodies(gpu, globalsBuf, base, jd, noise, texWidth = 0) {
  const { device, queue } = gpu;
  const BODY = [SUN, ...PLANETS, MOON], NB = BODY.length, F = 20, EARTH = 3, LUNA = NB - 1;
  // heliocentric positions, and which way each body faces (north pole and prime meridian angle), for a date
  const pos = new Float64Array(NB * 3), radius = new Float64Array(NB), tmp = new Float64Array(4);
  const frame = new Float64Array(NB * 4); frame[2] = 1;
  radius[0] = SUN.radius * KM_PC; PLANETS.forEach((p, i) => { radius[i + 1] = p.radius * KM_PC; }); radius[LUNA] = MOON.radius * KM_PC;
  function place(t) {
    for (let i = 0; i < PLANETS.length; i++) { planetPos(i, t, tmp); pos[(i + 1) * 3] = tmp[0]; pos[(i + 1) * 3 + 1] = tmp[1]; pos[(i + 1) * 3 + 2] = tmp[2]; }
    moonPos(t, tmp); for (let a = 0; a < 3; a++) pos[LUNA * 3 + a] = pos[EARTH * 3 + a] + tmp[a];   // the Moon, around the Earth
    for (let i = 1; i < NB; i++) { bodyFrame(BODY[i].name, t, tmp); frame[i * 4] = tmp[0]; frame[i * 4 + 1] = tmp[1]; frame[i * 4 + 2] = tmp[2]; frame[i * 4 + 3] = tmp[3]; }
  }
  place(jd);
  // Move everything to another date. A camera close to a body is carried along with it (not turned with it), so
  // that running the clock fast shows the planet spin and its moon go round instead of leaving it behind.
  function setTime(t) {
    const i = near.id, ride = i > 0 && near.alt < radius[i] * 300, ox = pos[i * 3], oy = pos[i * 3 + 1], oz = pos[i * 3 + 2];
    place(t);
    if (ride) { cam.p[0] += pos[i * 3] - ox; cam.p[1] += pos[i * 3 + 1] - oy; cam.p[2] += pos[i * 3 + 2] - oz; }
  }
  const names = BODY.map((p) => p.name);

  const module = device.createShaderModule({ code: SHADER });
  const layout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} }, { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '3d' } }, { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: {} }] });
  const attrs = [0, 1, 2, 3, 4].map((k) => ({ shaderLocation: k, offset: k * 16, format: 'float32x4' }));
  // bodies are opaque where they are solid: they hide the stars behind them
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: F * 4, stepMode: 'instance', attributes: attrs }] },
    fragment: { module, entryPoint: 'fs', targets: [{ format: HDR, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] },
    primitive: { topology: 'triangle-strip' },
  });
  const smp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'clamp-to-edge' });
  // Every body has a map. Until one arrives (or if it never does) the body is drawn from its stand-in pattern,
  // the Earth as a plain blue ball. The Earth's comes with the page; the others are fetched on the way to them.
  const blank = device.createTexture({ size: [1, 1], format: 'rgba8unorm-srgb', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  queue.writeTexture({ texture: blank }, new Uint8Array([28, 60, 120, 255]), {}, [1, 1]);
  const mkBind = (tex) => device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: globalsBuf } }, { binding: 1, resource: tex.createView() }, { binding: 2, resource: smp }, { binding: 3, resource: noise.view }, { binding: 4, resource: noise.sampler }] });
  const blankBind = mkBind(blank);
  const binds = new Array(NB).fill(blankBind), mapped = new Uint8Array(NB), asked = new Uint8Array(NB);
  const mm = device.createShaderModule({ code: MIP });
  const mp = device.createRenderPipeline({ layout: 'auto', vertex: { module: mm, entryPoint: 'vs' }, fragment: { module: mm, entryPoint: 'fs', targets: [{ format: 'rgba8unorm-srgb' }] } });
  const ms = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  function loadMap(i) {
    asked[i] = 1;
    const url = base + (i === EARTH ? 'earth.jpg' : 'maps/' + BODY[i].name.toLowerCase() + '.jpg');
    const fit = i === EARTH && texWidth ? { resizeWidth: texWidth, resizeHeight: texWidth / 2, resizeQuality: 'high' } : {};
    fetch(url).then((r) => (r.ok ? r.blob() : Promise.reject())).then((b) => createImageBitmap(b, { colorSpaceConversion: 'none', ...fit })).then((img) => {
      const w = img.width, h = img.height, levels = Math.floor(Math.log2(Math.max(w, h))) + 1;
      const t = device.createTexture({ size: [w, h], mipLevelCount: levels, format: 'rgba8unorm-srgb', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
      queue.copyExternalImageToTexture({ source: img }, { texture: t }, [w, h]);
      // mip chain, so the body does not shimmer when it is small
      const enc = device.createCommandEncoder();
      for (let l = 1; l < levels; l++) {
        const p = enc.beginRenderPass({ colorAttachments: [{ view: t.createView({ baseMipLevel: l, mipLevelCount: 1 }), loadOp: 'clear', storeOp: 'store' }] });
        p.setPipeline(mp); p.setBindGroup(0, device.createBindGroup({ layout: mp.getBindGroupLayout(0), entries: [{ binding: 0, resource: t.createView({ baseMipLevel: l - 1, mipLevelCount: 1 }) }, { binding: 1, resource: ms }] }));
        p.draw(3); p.end();
      }
      queue.submit([enc.finish()]);
      binds[i] = mkBind(t); mapped[i] = 1; img.close();
    }).catch(() => {});
  }
  loadMap(EARTH);

  const out = new Float32Array(NB * F), buf = device.createBuffer({ size: out.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  const order = new Int32Array(NB), dist = new Float64Array(NB), slot = new Int32Array(NB);
  // nearest body: altitude above its surface (pc), for the flight model and the HUD
  const near = { id: -1, alt: Infinity, dist: Infinity };
  let live = 0;

  function update() {
    near.alt = Infinity; near.id = -1;
    for (let i = 0; i < NB; i++) {
      const dx = pos[i * 3] - cam.p[0], dy = pos[i * 3 + 1] - cam.p[1], dz = pos[i * 3 + 2] - cam.p[2];
      dist[i] = Math.sqrt(dx * dx + dy * dy + dz * dz); order[i] = i;
      if (dist[i] - radius[i] < near.alt) { near.alt = dist[i] - radius[i]; near.id = i; near.dist = dist[i]; }
    }
    // never inside a body: hold the camera just above the surface
    if (near.id >= 0 && near.alt < radius[near.id] * 0.004) {
      const i = near.id, k = radius[i] * 1.004 / Math.max(dist[i], 1e-30);
      for (let a = 0; a < 3; a++) cam.p[a] = pos[i * 3 + a] + (cam.p[a] - pos[i * 3 + a]) * k;
      dist[i] = radius[i] * 1.004; near.alt = radius[i] * 0.004;
    }
    // far to near, so a nearer body covers a farther one (insertion sort: nine items, already nearly ordered)
    for (let a = 1; a < NB; a++) { const v = order[a]; let b = a - 1; while (b >= 0 && dist[order[b]] < dist[v]) { order[b + 1] = order[b]; b--; } order[b + 1] = v; }
    live = 0;
    for (let k = 0; k < NB; k++) {
      const i = order[k], R = radius[i], o = live * F, d = dist[i];
      if (d > 0.02) continue;                                            // beyond a few thousand AU the catalogue Sun is all there is
      if (i > 0 && !asked[i] && d < R * 1500) loadMap(i);                // about a pixel across: time to fetch its face
      out[o] = (pos[i * 3] - cam.p[0]) / R; out[o + 1] = (pos[i * 3 + 1] - cam.p[1]) / R; out[o + 2] = (pos[i * 3 + 2] - cam.p[2]) / R;
      const P = BODY[i];
      out[o + 3] = i === 0 ? 2 : i === EARTH ? 1 : i >= 5 && i <= 8 ? 3 : i === LUNA ? 4 : 0;
      out[o + 4] = P.color[0]; out[o + 5] = P.color[1]; out[o + 6] = P.color[2]; out[o + 7] = 0;
      const ds = Math.hypot(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]) || 1;
      const lx = -pos[i * 3] / ds, ly = -pos[i * 3 + 1] / ds, lz = -pos[i * 3 + 2] / ds;
      out[o + 8] = lx; out[o + 9] = ly; out[o + 10] = lz; out[o + 11] = frame[i * 4 + 3];
      out[o + 12] = frame[i * 4]; out[o + 13] = frame[i * 4 + 1]; out[o + 14] = frame[i * 4 + 2]; out[o + 15] = P.ring ? P.ring.inner / P.radius : 0;
      // reflected sunlight as a point: phase angle between the Sun and the camera, seen from the planet
      let lum = 0;
      if (i > 0) {
        const cosA = -((pos[i * 3] - cam.p[0]) * lx + (pos[i * 3 + 1] - cam.p[1]) * ly + (pos[i * 3 + 2] - cam.p[2]) * lz) / Math.max(d, 1e-30);
        const al = Math.acos(Math.max(-1, Math.min(1, cosA))), phase = (Math.sin(al) + (Math.PI - al) * Math.cos(al)) / Math.PI;
        lum = L_SUN * ALBEDO[i - 1] * (R / ds) * (R / ds) * phase / (d * d);
      }
      out[o + 16] = lum; out[o + 17] = P.ring ? P.ring.outer / P.radius : 0; out[o + 18] = mapped[i]; out[o + 19] = 0;
      slot[live] = i;
      live++;
    }
    if (live) queue.writeBuffer(buf, 0, out, 0, live * F);
  }
  // is a point (camera-relative, pc) hidden behind the nearest body? Used to drop labels of things below the horizon.
  function hides(dx, dy, dz) {
    const i = near.id; if (i < 0 || near.alt > radius[i] * 60) return false;
    const cx = pos[i * 3] - cam.p[0], cy = pos[i * 3 + 1] - cam.p[1], cz = pos[i * 3 + 2] - cam.p[2];
    const d2 = dx * dx + dy * dy + dz * dz, t = (cx * dx + cy * dy + cz * dz) / d2;
    if (t <= 0 || t >= 1) return false;
    const ex = cx - dx * t, ey = cy - dy * t, ez = cz - dz * t;
    return ex * ex + ey * ey + ez * ez < radius[i] * radius[i];
  }
  function draw(pass) {
    if (!live) return;
    pass.setPipeline(pipeline); pass.setVertexBuffer(0, buf);
    for (let k = 0; k < live; k++) { pass.setBindGroup(0, binds[slot[k]]); pass.draw(4, 1, 0, k); }
  }

  // Where the flight begins: a few hundred kilometres up over whichever well-known stretch of coast is in the
  // best daylight right now, looking across it to the Earth's limb with the Sun off to one side.
  // Returns position, look-at point and up vector.
  const SITES = [[12, 41], [-80, 24], [103, 8], [138, 35], [-5, 36], [33, 26], [78, 18], [-114, 29], [150, -30], [-43, -18], [-70, -42], [22, -30]];   // east longitude, latitude, in order of preference
  function launch(altKm = 2000) {
    const e = EARTH * 3, ex = pos[e], ey = pos[e + 1], ez = pos[e + 2], ds = Math.hypot(ex, ey, ez);
    const u = [-ex / ds, -ey / ds, -ez / ds];                              // to the Sun
    let S = null, best = -2;
    for (const [lon, lat] of SITES) {
      const a = frame[EARTH * 4 + 3] + Math.PI / 2 + lon * Math.PI / 180, b = lat * Math.PI / 180, v = [Math.cos(b) * Math.cos(a), Math.cos(b) * Math.sin(a), Math.sin(b)];
      const lit = v[0] * u[0] + v[1] * u[1] + v[2] * u[2];
      // the first site in good daylight wins; failing that, the best lit
      if (best < 0.6 && lit > best) { best = lit; S = v; }
    }
    const unit = (v) => { const n = Math.hypot(...v); return v.map((x) => x / n); };
    const t = unit([S[1] * u[2] - S[2] * u[1], S[2] * u[0] - S[0] * u[2], S[0] * u[1] - S[1] * u[0]]);   // along the ground, square to the Sun
    const ca = Math.cos(0.3), sa = Math.sin(0.3);
    const r = unit([S[0] * ca - t[0] * sa, S[1] * ca - t[1] * sa, S[2] * ca - t[2] * sa]);                // stand back from the site
    const R = radius[EARTH], d = R + altKm * KM_PC;
    const p = [ex + r[0] * d, ey + r[1] * d, ez + r[2] * d];
    const k = S[0] * r[0] + S[1] * r[1] + S[2] * r[2], f = unit([S[0] - r[0] * k, S[1] - r[1] * k, S[2] - r[2] * k]);
    const c = Math.cos(0.4), s = Math.sin(0.4);
    return { p, at: [p[0] + (f[0] * c - r[0] * s) * R, p[1] + (f[1] * c - r[1] * s) * R, p[2] + (f[2] * c - r[2] * s) * R], up: r };
  }
  // The night sky from above the Earth's dark side: looking at whichever showpiece of the sky is highest at local
  // midnight today (Orion, the galactic centre, the Southern Cross or Cygnus), north up
  function night() {
    const e = EARTH * 3, ds = Math.hypot(pos[e], pos[e + 1], pos[e + 2]), away = [pos[e] / ds, pos[e + 1] / ds, pos[e + 2] / ds];
    let v = away, best = -2;
    for (const [ra, dec] of [[84, -2], [266, -29], [187, -60], [305, 40]]) {
      const a = ra * Math.PI / 180, b = dec * Math.PI / 180, c = [Math.cos(b) * Math.cos(a), Math.cos(b) * Math.sin(a), Math.sin(b)], k = c[0] * away[0] + c[1] * away[1] + c[2] * away[2];
      if (k > best) { best = k; v = c; }
    }
    const R = radius[EARTH] * 1.6, p = [pos[e] + v[0] * R, pos[e + 1] + v[1] * R, pos[e + 2] + v[2] * R];
    return { p, at: [p[0] + v[0], p[1] + v[1], p[2] + v[2]], up: [0, 0, 1] };
  }
  return { update, draw, near, setTime, launch, night, hides, names, count: NB, pos: (i, a) => pos[i * 3 + a], radius: (i) => radius[i], AU: 1 / PC_AU };
}
