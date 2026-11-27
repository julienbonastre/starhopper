// Detailed galaxies: every catalogued galaxy with a known size, tilt and Hubble type (and the Milky Way itself).
// Far away each is a point; closer, a cheap analytic disc-and-bulge impostor; the few that fill the view are
// ray-marched as volumes with spiral arms, star-forming knots and dust lanes (at reduced resolution).
// The same light model, normalised to the catalogued luminosity, is used at every tier so they cross-fade cleanly.
import { GLOBALS, HDR } from './gpu.js';
import { cam } from './camera.js';

const MODEL = /*wgsl*/`
struct GalP { fb: f32, rb: f32, h: f32, hz: f32, pitch: f32, arms: f32, armC: f32, clump: f32, bar: f32, qz: f32, wind: f32, phase: f32 }
// Hubble sequence: 0 E, 1 S0, 2 Sa, 3 Sab, 4 Sb, 5 Sbc, 6 Sc, 7 Scd, 8 Sd/Sm, 9 Irr
const FB = array<f32, 10>(1.0, 0.55, 0.42, 0.34, 0.26, 0.18, 0.12, 0.08, 0.04, 0.0);
const PITCH = array<f32, 10>(9.0, 9.0, 9.0, 11.0, 14.0, 17.0, 20.0, 24.0, 28.0, 30.0);
const ARMC = array<f32, 10>(0.0, 0.0, 0.5, 0.6, 0.72, 0.8, 0.85, 0.7, 0.12, 0.0);
const CLUMP = array<f32, 10>(0.0, 0.0, 0.15, 0.2, 0.3, 0.4, 0.5, 0.65, 0.9, 1.0);
fn galParams(t: u32, flat: f32, seed: u32) -> GalP {
  let b = min(t & 15u, 9u);
  var p: GalP;
  p.fb = FB[b]; p.armC = ARMC[b]; p.clump = CLUMP[b];
  p.rb = select(0.045 + 0.12 * p.fb, 0.17, b == 0u);
  p.h = 0.27; p.hz = select(0.022, 0.1, b == 9u); if (b == 1u) { p.hz = 0.035; }
  p.pitch = 1.0 / tan(radians(PITCH[b]));
  p.arms = select(2.0, 4.0, ((seed >> 3u) & 3u) == 0u && b >= 5u);
  p.bar = f32((t >> 4u) & 3u) * select(1.0, 0.5, ((t >> 4u) & 3u) == 2u);
  p.qz = flat;
  p.wind = select(-1.0, 1.0, (seed & 2u) != 0u);
  p.phase = f32((seed >> 8u) & 255u) * 0.0246;
  return p;
}
fn h3(p: vec3f) -> f32 { var q = fract(p * vec3f(0.1031, 0.1030, 0.0973)); q += dot(q, q.yxz + 33.33); return fract((q.x + q.y) * q.z); }
fn vnoise(p: vec3f) -> f32 {
  let i = floor(p); var f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h3(i), h3(i + vec3f(1, 0, 0)), f.x), mix(h3(i + vec3f(0, 1, 0)), h3(i + vec3f(1, 1, 0)), f.x), f.y),
             mix(mix(h3(i + vec3f(0, 0, 1)), h3(i + vec3f(1, 0, 1)), f.x), mix(h3(i + vec3f(0, 1, 1)), h3(i + vec3f(1, 1, 1)), f.x), f.y), f.z);
}
// Surface brightness is shown as the flux falling on one pixel of a reference view (1000 px tall, 60 degrees), so the
// balance between stars and extended light does not depend on the window size.
const OMEGA = 1.3333e-6;
const OLD = vec3f(1.0, 0.80, 0.56);
const YOUNG = vec3f(0.60, 0.76, 1.0);
const HII = vec3f(1.0, 0.28, 0.42);
// emission (rgb, luminosity per unit volume for a galaxy of unit radius and unit luminosity) and dust (a) at q.
// detail 0 skips the noise (used by the impostor's bulge-only path and by low settings).
fn galEmit(q: vec3f, p: GalP, sd: f32, detail: f32) -> vec4f {
  let r2 = dot(q.xy, q.xy); let r = sqrt(r2);
  let s2 = r2 + q.z * q.z / (p.qz * p.qz);
  let bul = p.fb / (9.8696 * p.qz * p.rb * p.rb * p.rb) * pow(1.0 + s2 / (p.rb * p.rb), -2.0) * (1.0 - smoothstep(1.0, 1.7, sqrt(s2)));
  if (p.fb >= 0.999) { return vec4f(OLD * bul, 0.0); }
  let az = abs(q.z);
  let disc = (1.0 - p.fb) / (12.566 * p.h * p.h * p.hz) * exp(-r / p.h - az / p.hz) * (1.0 - smoothstep(0.85, 1.65, r));
  if (disc < 1e-4 && bul < 1e-4) { return vec4f(0.0); }
  let th = atan2(q.y, q.x) * p.wind;
  let ph = p.arms * (th - log(max(r, 0.02)) * p.pitch) + p.phase;
  let c = 0.5 + 0.5 * cos(ph);
  let inner = smoothstep(0.04, 0.22, r);
  let arm = c * c * c * 3.2;                                   // mean 1 around the circle
  var n1 = 0.5; var n2 = 0.0;
  if (detail > 0.0) {
    // each octave is rotated against the last, so the noise lattice never lines up into a visible weave
    let w = vec3f(q.x * 0.8 - q.y * 0.6, q.x * 0.6 + q.y * 0.8, q.z) * vec3f(13.0, 13.0, 36.0) + sd;
    let w2 = vec3f(w.x * 0.54 + w.y * 0.84, -w.x * 0.84 + w.y * 0.54, w.z) * 2.3 + 9.1;
    n1 = vnoise(w) * 0.6 + vnoise(w2) * 0.4;
    n2 = vnoise(vec3f(w2.x * 0.7 - w2.y * 0.71, w2.x * 0.71 + w2.y * 0.7, w2.z) * 1.9 + 31.7);
  }
  let clumps = mix(1.0, 0.25 + 1.5 * n1, p.clump * (0.5 + 0.5 * detail));
  let discE = disc * mix(1.0, arm, p.armC * inner) * clumps;
  let fy = clamp(c * c * p.armC * inner * 0.75 + p.clump * 0.45 - 0.1, 0.0, 1.0);
  var col = OLD * bul + discE * mix(OLD * 0.95, YOUNG, fy);
  col += HII * disc * smoothstep(0.66, 0.92, n2) * arm * inner * (p.armC + p.clump * 0.6) * 1.1 * detail;
  if (p.bar > 0.0) {
    let a = p.phase * 0.5; let xb = vec2f(q.x * cos(a) + q.y * sin(a), -q.x * sin(a) + q.y * cos(a));
    col += OLD * p.bar * (1.0 - p.fb) * 2.6 * exp(-(xb.x * xb.x) / 0.045 - (xb.y * xb.y) / 0.0035 - q.z * q.z / 0.003);
  }
  let cd = 0.5 + 0.5 * cos(ph + 0.85);
  let dust = (1.0 - p.fb) * exp(-r / (p.h * 1.5) - az / (p.hz * 0.4)) * (0.2 + 1.6 * cd * cd * inner * p.armC + p.clump) * (0.35 + 1.3 * n1) * (1.0 - smoothstep(1.0, 1.5, r));
  return vec4f(col, dust);
}
`;


// Procedural fill stars: where no catalogue reaches, individual stars are drawn from the host galaxy's own light
// model. They live on world-anchored lattices (one per luminosity class), so the same stars are always in the same
// place; each lattice is only as wide as its class can be seen. Inside the Milky Way a star is dropped wherever the
// real catalogue is complete (it would be brighter than magnitude 10.5 from the Sun).
const FILL = /*wgsl*/`
${GLOBALS}
${MODEL}
struct Vol { c: vec3f, R: f32, ax: vec3f, lum: f32, ay: vec3f, flat: f32, n: vec3f, weight: f32, id: vec4u }
struct Vols { v: array<Vol, 4>, steps: f32, count: f32, kappa: f32, pad: f32 }
@group(0) @binding(1) var<uniform> V: Vols;
struct Fill { cell: vec3i, n: i32, frac: vec3f, size: f32, sun: vec3f, mag: f32, per: u32, level: u32, expect: f32, gain: f32, host: u32, isMW: u32, p0: u32, p1: u32 }
@group(1) @binding(0) var<uniform> F: Fill;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) col: vec3f, @location(2) prm: vec2f }
fn pcg3(v: vec3u) -> vec3u {
  var x = v * 1664525u + 1013904223u;
  x.x += x.y * x.z; x.y += x.z * x.x; x.z += x.x * x.y; x ^= x >> vec3u(16u);
  x.x += x.y * x.z; x.y += x.z * x.x; x.z += x.x * x.y; return x;
}
fn bvColour(bv: f32) -> vec3f {
  let t = 4600.0 * (1.0 / (0.92 * bv + 1.7) + 1.0 / (0.92 * bv + 0.62)); let x = t / 100.0;
  var c: vec3f;
  if (x <= 66.0) { c.r = 1.0; c.g = clamp(0.390082 * log(x) - 0.631841, 0.0, 1.0); }
  else { c.r = clamp(1.292936 * pow(x - 60.0, -0.1332047), 0.0, 1.0); c.g = clamp(1.129891 * pow(x - 60.0, -0.0755148), 0.0, 1.0); }
  if (x >= 66.0) { c.b = 1.0; } else if (x <= 19.0) { c.b = 0.0; } else { c.b = clamp(0.543207 * log(x - 10.0) - 1.196254, 0.0, 1.0); }
  c = pow(c, vec3f(2.2));
  return mix(vec3f(1.0), c / dot(c, vec3f(0.2126, 0.7152, 0.0722)), 1.25);
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  var o: VO; o.pos = vec4f(0.0, 0.0, 2.0, 1.0);
  let corner = vec2f(f32(vi & 1u) * 2.0 - 1.0, f32(vi >> 1u) * 2.0 - 1.0);
  let ci = ii / F.per; let n = u32(F.n);
  let g = vec3i(i32(ci % n), i32((ci / n) % n), i32(ci / (n * n))) - F.n / 2;
  let wc = F.cell + g;
  let h = pcg3(bitcast<vec3u>(wc) + vec3u(ii % F.per, F.level * 7919u, 0u));
  let h2 = pcg3(h);
  let u1 = vec3f(h) / 4294967296.0; let u2 = vec3f(h2) / 4294967296.0;
  let rel = (vec3f(g) + u1 - F.frac) * F.size;
  // local density of the host galaxy, relative to the solar neighbourhood
  let v = V.v[F.host];
  let P = galParams(v.id.x, v.flat, v.id.y);
  let w = rel - v.c;
  let e = galEmit(vec3f(dot(w, v.ax), dot(w, v.ay), dot(w, v.n)) / v.R, P, 0.0, 0.0);
  let rho = dot(e.rgb, vec3f(0.33)) * v.lum / v.R / 0.02296;
  if (u2.x >= F.expect * rho) { return o; }
  var absmag = F.mag + (u2.y - 0.5) * 3.0;
  // colour: main sequence, with red giants among the brighter classes and a blue excess in the arms
  var bv = clamp(0.15 * absmag - 0.05, -0.28, 1.5);
  if (absmag < 2.5 && u2.z < 0.4) { bv = 0.95 + 0.5 * u1.x; }
  let d2 = max(dot(rel, rel), 1e-12);
  var gain = F.gain * (1.0 - smoothstep(0.8, 1.0, max(abs(f32(g.x)), max(abs(f32(g.y)), abs(f32(g.z)))) / f32(F.n / 2)));
  if (F.isMW == 1u) {
    let ds = rel - F.sun; let m = absmag + 2.5 * log(max(dot(ds, ds), 1e-6)) / 2.302585 - 5.0;   // magnitude seen from the Sun
    gain *= smoothstep(10.0, 11.0, m);
  }
  let en = G.exposure * gain * G.proc * exp(-0.9210340 * absmag) * 100.0 / d2;
  let s0 = 0.62 * G.pxScale;
  let sigma = min(max(s0, sqrt(en * G.pxScale * G.pxScale / (6.2831853 * 2.6))), 26.0 * G.pxScale);
  let peak = min(en * G.pxScale * G.pxScale / (6.2831853 * sigma * sigma), 40.0);
  let p = project(rel);
  if (peak < 0.0035 || p.z > 1.0) { return o; }
  let half = sigma * 3.6 + 1.0;
  o.pos = vec4f(p.xy + corner * half * 2.0 / G.viewport, 0.5, 1.0);
  o.uv = corner * half; o.col = bvColour(bv); o.prm = vec2f(peak, sigma);
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let r2 = dot(i.uv, i.uv) / (i.prm.y * i.prm.y);
  let skirt = 0.035 / (1.0 + r2 * r2 * 0.08) * max(0.0, 1.0 - r2 / 12.96) * smoothstep(1.2, 3.0, i.prm.y / G.pxScale);
  return vec4f(i.col * i.prm.x * (exp(-0.5 * r2) + skirt), 1.0);
}`;
// luminosity classes: absolute magnitude, cell size (pc), stars per cell, and stars expected per slot near the Sun
// (from the solar-neighbourhood luminosity function: about 8e-3, 2.5e-3, 1.4e-4 and 4e-6 stars per cubic parsec)
const CLASSES = [{ mag: 5, size: 2.2, per: 1, dens: 8e-3 }, { mag: 2, size: 8, per: 2, dens: 2.5e-3 }, { mag: -1, size: 32, per: 4, dens: 1.4e-4 }, { mag: -4, size: 130, per: 6, dens: 4e-6 }];

const LAYER = /*wgsl*/`
struct Layer { camQ: vec3i, pad0: i32, camF: vec3f, step: f32, far: vec3f, magOff: f32, sigma0: f32, gain: f32, vol: vec4i }
@group(1) @binding(0) var<uniform> L: Layer;
`;
const IMPOSTOR = /*wgsl*/`
${GLOBALS}
${LAYER}
${MODEL}
struct VO {
  @builtin(position) pos: vec4f, @location(0) uv: vec2f,
  @location(1) @interpolate(flat) c: vec3f, @location(2) @interpolate(flat) n: vec3f,
  @location(3) @interpolate(flat) prm: vec4f,          // radius, flux at exposure, impostor weight, size in CSS px
  @location(4) @interpolate(flat) id: vec3u,            // type, seed, unused
  @location(5) @interpolate(flat) psf: vec2f,           // peak, sigma (point tier)
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32, @location(0) s: vec4u, @location(1) g: vec4f, @location(2) flat: f32, @location(3) seed: u32) -> VO {
  var o: VO;
  let corner = vec2f(f32(vi & 1u) * 2.0 - 1.0, f32(vi >> 1u) * 2.0 - 1.0);
  let rel = (vec3f(vec3i(s.xyz) - L.camQ) - L.camF) * L.step + L.far;
  let d2 = max(dot(rel, rel), 1e-6); let dist = sqrt(d2);
  let absmag = f32(s.w >> 16u) * 0.001 - 40.0;
  let lum = exp(-0.9210340 * absmag) * 100.0;
  let e = G.exposure * lum / d2;
  let hcss = G.viewport.y / G.pxScale;
  let sizePx = g.x / dist * G.focal * hcss * 0.5;
  // impostor weight: 0 while too small to resolve; 0 again when the volume pass has taken this galaxy over
  var w = smoothstep(1.3, 3.5, sizePx) * G.proc;
  let inVol = i32(ii) == L.vol.x || i32(ii) == L.vol.y || i32(ii) == L.vol.z || i32(ii) == L.vol.w;
  if (inVol) { w *= 1.0 - smoothstep(170.0, 300.0, sizePx); }
  let ptGain = (1.0 - smoothstep(1.3, 3.5, sizePx) * G.proc) * select(1.0, 0.0, ii == 0u && G.proc < 0.5);
  let s0 = L.sigma0 * G.pxScale;
  let ep = e * ptGain * L.gain * G.pxScale * G.pxScale;
  let sigma = min(max(s0, sqrt(ep / (6.2831853 * 2.6))), 26.0 * G.pxScale);
  let peak = min(ep / (6.2831853 * sigma * sigma), 40.0);
  let p = project(rel);
    // small impostors are lifted like the points they grow out of (L.gain), large ones keep their true surface brightness
  let boost = mix(L.gain, 1.0, smoothstep(3.0, 40.0, sizePx));
  let omega = OMEGA;
  if (G.exposure * G.diffuse * boost * lum / (g.x * g.x) * omega * 30.0 < 0.002) { w = 0.0; }
  if ((peak < 0.0035 && w <= 0.0) || p.z > 1.0) { o.pos = vec4f(0.0, 0.0, 2.0, 1.0); return o; }
  let half = max(sigma * 3.6 + 1.0, select(0.0, sizePx * 1.75 * G.pxScale, w > 0.0));
  o.pos = vec4f(p.xy + corner * half * 2.0 / G.viewport, 0.5, 1.0);
  o.uv = corner * half;
  o.c = rel; o.prm = vec4f(g.x, G.exposure * G.diffuse * boost * lum / (g.x * g.x), w, sizePx);
  o.id = vec3u((s.w >> 8u) & 255u, seed, 0u);
  o.psf = vec2f(peak, sigma);
  // flat is needed in the fragment stage too: carried in n's length (n is unit, so scale it)
  o.n = g.yzw * (1.0 + flat);
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  var col = vec3f(0.0);
  let flat = length(i.n) - 1.0; let n = i.n / (1.0 + flat);
  let P = galParams(i.id.x, flat, i.id.y);
  if (i.psf.x > 0.0) {
    let r2 = dot(i.uv, i.uv) / (i.psf.y * i.psf.y);
    col += mix(OLD, YOUNG, 0.25 + 0.5 * P.armC) * i.psf.x * exp(-0.5 * r2);
  }
  if (i.prm.z > 0.0) {
    // view ray through this pixel
    let ndc = (i.pos.xy / G.viewport * 2.0 - 1.0) * vec2f(1.0, -1.0);
    let d = normalize(G.right * ndc.x * G.aspect / G.focal + G.up * ndc.y / G.focal + G.fwd);
    let R = i.prm.x;
    let omega = OMEGA;
    // disc: thin-sheet column where the ray crosses the mid-plane (tilt clamped so edge-on discs keep a thickness)
    var k = dot(d, n); let ka = max(abs(k), 0.12); k = select(-ka, ka, k >= 0.0);
    let t = dot(i.c, n) / k;
    let hit = (d * t - i.c) / R;
    // spheroid: projected onto the sky plane through the centre
    let tc = dot(i.c, d); let off = (d * tc - i.c) / R;
    let sinI = sqrt(max(1.0 - dot(d, n) * dot(d, n), 0.0));
    let along = dot(off, n) / max(sinI, 1e-3);                              // along the projected minor axis
    let across2 = max(dot(off, off) - along * along, 0.0);
    let qa = sqrt(max(1.0 - sinI * sinI * (1.0 - P.qz * P.qz), 0.01));     // apparent axis ratio of the spheroid
    let rr = across2 + along * along / (qa * qa);
    var em = OLD * P.fb / (6.2831853 * qa * P.rb * P.rb) * pow(1.0 + rr / (P.rb * P.rb), -1.5) * (1.0 - smoothstep(1.0, 1.7, sqrt(rr)));
    if (P.fb < 0.999 && t > 0.0) {
      // face-on basis in the disc plane
      let ax = normalize(cross(n, select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(n.x) > 0.7)));
      let ay = cross(n, ax);
      let q = vec3f(dot(hit, ax), dot(hit, ay), 0.0);
      let v = galEmit(q, P, f32(i.id.y & 1023u), select(0.0, 1.0, i.prm.w > 40.0));
      let spher = OLD * P.fb / (9.8696 * P.qz * P.rb * P.rb * P.rb) * pow(1.0 + dot(q.xy, q.xy) / (P.rb * P.rb), -2.0);
      em += max(v.rgb - spher, vec3f(0.0)) * 2.0 * P.hz / ka * exp(-v.a * 12.0 * P.hz / ka);
    }
    col += em * i.prm.y * omega * i.prm.z;
  }
  return vec4f(col, 1.0);
}`;

const VOLUME = /*wgsl*/`
${GLOBALS}
${MODEL}
struct Vol { c: vec3f, R: f32, ax: vec3f, lum: f32, ay: vec3f, flat: f32, n: vec3f, weight: f32, id: vec4u }
struct Vols { v: array<Vol, 4>, steps: f32, count: f32, kappa: f32, pad: f32 }
@group(0) @binding(1) var<uniform> V: Vols;
struct VO { @builtin(position) pos: vec4f, @location(0) ndc: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var o: VO; let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  o.pos = vec4f(p, 0.0, 1.0); o.ndc = p; return o;
}
fn ign(p: vec2f) -> f32 { return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715)))); }
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let d = normalize(G.right * i.ndc.x * G.aspect / G.focal + G.up * i.ndc.y / G.focal + G.fwd);
  let omega = OMEGA;
  let jit = ign(i.pos.xy);
  var sum = vec3f(0.0);
  let nv = u32(V.count);
  for (var g = 0u; g < nv; g++) {
    let v = V.v[g];
    if (v.weight <= 0.0) { continue; }
    // ray against the bounding sphere (radius 1.7 R), in units of R
    let oc = -v.c / v.R;
    let b = dot(oc, d); let cc = dot(oc, oc) - 2.89; let disc = b * b - cc;
    if (disc <= 0.0) { continue; }
    let sq = sqrt(disc);
    var t0 = max(-b - sq, 0.0); var t1 = -b + sq;
    if (t1 <= t0) { continue; }
    let P = galParams(v.id.x, v.flat, v.id.y);
    let ro = vec3f(dot(oc, v.ax), dot(oc, v.ay), dot(oc, v.n));
    let rd = vec3f(dot(d, v.ax), dot(d, v.ay), dot(d, v.n));
    // discs: only the slab around the mid-plane (and the central bulge) holds anything worth sampling
    if (P.fb < 0.999) {
      let zs = max(P.hz * 7.0, P.rb * 2.2 * P.qz * step(0.01, P.fb) + 0.02);
      if (abs(rd.z) > 1e-5) {
        let ta = (-zs - ro.z) / rd.z; let tb = (zs - ro.z) / rd.z;
        t0 = max(t0, min(ta, tb)); t1 = min(t1, max(ta, tb));
      } else if (abs(ro.z) > zs) { continue; }
      if (t1 <= t0) { continue; }
    }
    // inside the sphere the samples crowd toward the camera, where the structure is resolved best
    let pw = select(1.0, 2.0, t0 <= 0.0);
    let N = V.steps;
    var acc = vec3f(0.0); var tr = 1.0; var prev = t0;
    let sd = f32(v.id.y & 1023u);
    for (var s = 0.0; s < N; s += 1.0) {
      let u1 = pow((s + 1.0) / N, pw);
      let um = pow((s + jit) / N, pw);
      let tn = t0 + (t1 - t0) * u1; let t = t0 + (t1 - t0) * um; let dt = tn - prev; prev = tn;
      // no fine structure right around the camera: there it would be a few huge blotches across the whole sky
      let e = galEmit(ro + rd * t, P, sd, smoothstep(0.02, 0.12, t));
      let a = exp(-e.a * V.kappa * dt);
      acc += tr * e.rgb * dt * (1.0 + a) * 0.5;
      tr *= a;
      if (tr < 0.01) { break; }
    }
    sum += acc * v.lum * omega * v.weight;
  }
  return vec4f(sum * G.exposure * G.diffuse * G.proc, 1.0);
}`;
const BLIT = /*wgsl*/`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO { var o: VO; let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)); o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0); o.uv = vec2f(p.x, 1.0 - p.y); return o; }
@fragment fn fs(i: VO) -> @location(0) vec4f { return vec4f(textureSampleLevel(src, smp, i.uv, 0.0).rgb, 1.0); }`;

export async function initGalaxies(gpu, globalsBuf, base, quality) {
  const { device, queue } = gpu;
  const [meta, bin] = await Promise.all([fetch(base + 'galaxies.json').then((r) => r.json()), fetch(base + 'galaxies.bin').then((r) => r.arrayBuffer())]);
  const N = meta.count, HALF = meta.half, STEP = meta.step, u = new Uint32Array(bin), f = new Float32Array(bin);
  const inst = device.createBuffer({ size: bin.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  queue.writeBuffer(inst, 0, bin);
  const add = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };
  const gl = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }] });
  const ll = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: {} }] });
  const im = device.createShaderModule({ code: IMPOSTOR });
  const impostor = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [gl, ll] }),
    vertex: { module: im, entryPoint: 'vs', buffers: [{ arrayStride: 40, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'uint32x4' }, { shaderLocation: 1, offset: 16, format: 'float32x4' }, { shaderLocation: 2, offset: 32, format: 'float32' }, { shaderLocation: 3, offset: 36, format: 'uint32' }] }] },
    fragment: { module: im, entryPoint: 'fs', targets: [{ format: HDR, blend: add }] }, primitive: { topology: 'triangle-strip' },
  });
  const gBind = device.createBindGroup({ layout: gl, entries: [{ binding: 0, resource: { buffer: globalsBuf } }] });
  const layerData = new ArrayBuffer(80), lf = new Float32Array(layerData), li = new Int32Array(layerData);
  const layerBuf = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const lBind = device.createBindGroup({ layout: ll, entries: [{ binding: 0, resource: { buffer: layerBuf } }] });

  const vl = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }, { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }] });
  const vm = device.createShaderModule({ code: VOLUME });
  const volume = device.createRenderPipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [vl] }), vertex: { module: vm, entryPoint: 'vs' }, fragment: { module: vm, entryPoint: 'fs', targets: [{ format: HDR }] } });
  const volData = new ArrayBuffer(4 * 80 + 16), vf = new Float32Array(volData), vu = new Uint32Array(volData);
  const volBuf = device.createBuffer({ size: volData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const vBind = device.createBindGroup({ layout: vl, entries: [{ binding: 0, resource: { buffer: globalsBuf } }, { binding: 1, resource: { buffer: volBuf } }] });
  const bm = device.createShaderModule({ code: BLIT });
  const blit = device.createRenderPipeline({ layout: 'auto', vertex: { module: bm, entryPoint: 'vs' }, fragment: { module: bm, entryPoint: 'fs', targets: [{ format: HDR, blend: add }] } });
  const fl2 = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: {} }] });
  const fm = device.createShaderModule({ code: FILL });
  const fillPipe = device.createRenderPipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [vl, fl2] }), vertex: { module: fm, entryPoint: 'vs' }, fragment: { module: fm, entryPoint: 'fs', targets: [{ format: HDR, blend: add }] }, primitive: { topology: 'triangle-strip' } });
  const fills = CLASSES.map((c, level) => {
    const data = new ArrayBuffer(80), buf = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    return { c, level, data, f: new Float32Array(data), i: new Int32Array(data), buf, bind: device.createBindGroup({ layout: fl2, entries: [{ binding: 0, resource: { buffer: buf } }] }) };
  });
  const FN = quality.fillGrid;
  let fillOn = false;
  const smp = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  let volTex, volAttach, blitBind;
  function resize(w, h) {
    volTex?.destroy();
    const s = quality.volScale;
    volTex = device.createTexture({ size: [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))], format: HDR, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    const view = volTex.createView();
    volAttach = { colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] };
    blitBind = device.createBindGroup({ layout: blit.getBindGroupLayout(0), entries: [{ binding: 0, resource: view }, { binding: 1, resource: smp }] });
  }

  // the (up to) four galaxies that loom largest: these are ray-marched
  const volId = new Int32Array(4).fill(-1), volSize = new Float64Array(4);
  const near = { id: -1, dist: Infinity, edge: Infinity, spacing: Infinity };       // nearest galaxy: for flight speed and the HUD
  let nVol = 0;
  const pos = (i, a) => u[i * 10 + a] * STEP - HALF;
  let fillGain = 1;
  function update(W, H, pxScale, pointGain, starGain) {
    fillGain = starGain;
    const px = cam.p[0], py = cam.p[1], pz = cam.p[2], k = (1 / Math.tan(cam.fov / 2)) * (H / pxScale) * 0.5;
    let best = Infinity;
    volId.fill(-1); volSize.fill(0); near.dist = Infinity; near.edge = Infinity; near.id = -1;
    for (let i = 0; i < N; i++) {
      const o = i * 10, dx = u[o] * STEP - HALF - px, dy = u[o + 1] * STEP - HALF - py, dz = u[o + 2] * STEP - HALF - pz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz), R = f[o + 4], size = (R / Math.max(d, 1e-9)) * k;
      // the dominant galaxy is the one that looms largest (smallest distance in its own radii); edge is how far the
      // nearest galaxy's body is, whichever galaxy that is
      if (d - R * 0.6 < near.edge) near.edge = d - R * 0.6;
      if (d / R < best) { best = d / R; near.dist = d; near.id = i; }
      if (size < 170) continue;
      let m = 0; for (let s = 1; s < 4; s++) if (volSize[s] < volSize[m]) m = s;
      if (size > volSize[m]) { volSize[m] = size; volId[m] = i; }
    }
    nVol = 0;
    for (let s = 0; s < 4; s++) {
      const i = volId[s]; if (i < 0) continue;
      const o = i * 10, b = nVol * 20, R = f[o + 4];
      let nx = f[o + 5], ny = f[o + 6], nz = f[o + 7];
      // any two axes perpendicular to the disc normal (must match the impostor's choice)
      let tx = Math.abs(nx) > 0.7 ? 0 : 1, ty = Math.abs(nx) > 0.7 ? 1 : 0, tz = 0;
      let ax = ny * tz - nz * ty, ay = nz * tx - nx * tz, az = nx * ty - ny * tx; const al = Math.hypot(ax, ay, az); ax /= al; ay /= al; az /= al;
      const bx = ny * az - nz * ay, by = nz * ax - nx * az, bz = nx * ay - ny * ax;
      const absmag = (u[o + 3] >>> 16) * 0.001 - 40;
      vf[b] = pos(i, 0) - px; vf[b + 1] = pos(i, 1) - py; vf[b + 2] = pos(i, 2) - pz; vf[b + 3] = R;
      vf[b + 4] = ax; vf[b + 5] = ay; vf[b + 6] = az; vf[b + 7] = Math.pow(10, -0.4 * absmag) * 100 / (R * R);
      vf[b + 8] = bx; vf[b + 9] = by; vf[b + 10] = bz; vf[b + 11] = f[o + 8];
      vf[b + 12] = nx; vf[b + 13] = ny; vf[b + 14] = nz; vf[b + 15] = Math.max(0, Math.min(1, (volSize[s] - 170) / 130));
      vu[b + 16] = (u[o + 3] >>> 8) & 255; vu[b + 17] = u[o + 9];
      nVol++;
    }
    vf[80] = quality.volSteps; vf[81] = nVol; vf[82] = 34;
    queue.writeBuffer(volBuf, 0, volData);
    // fill stars: hosted by the looming galaxy the camera is in or close to
    let host = -1;
    for (let s = 0, k = 0; s < 4; s++) { if (volId[s] < 0) continue; if (volId[s] === near.id && near.dist < 1.8 * f[near.id * 10 + 4]) host = k; k++; }
    fillOn = host >= 0;
    if (fillOn) for (const L of fills) {
      const c = L.c.size;
      for (let a = 0; a < 3; a++) { const g = cam.p[a] / c, q = Math.floor(g); L.i[a] = q; L.f[4 + a] = g - q; L.f[8 + a] = -cam.p[a]; }
      L.i[3] = FN; L.f[7] = c; L.f[11] = L.c.mag;
      L.i[12] = L.c.per; L.i[13] = L.level; L.f[14] = L.c.dens * c * c * c / L.c.per; L.f[15] = fillGain;
      L.i[16] = host; L.i[17] = near.id === 0 ? 1 : 0;
      queue.writeBuffer(L.buf, 0, L.data);
    }
    // typical distance between neighbouring fill stars here (for the flight model); Infinity outside galaxies
    near.spacing = Infinity;
    if (fillOn) {
      const o = near.id * 10, R = f[o + 4], dx = px - pos(near.id, 0), dy = py - pos(near.id, 1), dz = pz - pos(near.id, 2);
      const z = dx * f[o + 5] + dy * f[o + 6] + dz * f[o + 7], r = Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - z * z)) / R;
      const base = (u[o + 3] >>> 8) & 15, fb = [1, 0.55, 0.42, 0.34, 0.26, 0.18, 0.12, 0.08, 0.04, 0][Math.min(base, 9)], hz = base === 9 ? 0.1 : base === 1 ? 0.035 : 0.022;
      const disc = (1 - fb) / (12.566 * 0.0729 * hz) * Math.exp(-r / 0.27 - Math.abs(z / R) / hz);
      const rb = base === 0 ? 0.12 : 0.045 + 0.12 * fb, s2 = r * r + (z / R) * (z / R) / 0.36, bul = fb / (9.8696 * 0.6 * rb * rb * rb) / ((1 + s2 / (rb * rb)) ** 2);
      const rho = (disc + bul) * (Math.pow(10, -0.4 * ((u[o + 3] >>> 16) * 0.001 - 40)) * 100 / (R * R * R)) / 0.02296;
      if (rho > 1e-6) near.spacing = Math.pow(0.012 * rho, -1 / 3);
    }
    let inside = true;
    for (let a = 0; a < 3; a++) if (Math.abs(cam.p[a]) >= HALF) inside = false;
    for (let a = 0; a < 3; a++) {
      if (inside) { const g = (cam.p[a] + HALF) / STEP, q = Math.floor(g); li[a] = q; lf[4 + a] = g - q; lf[8 + a] = 0; }
      else { li[a] = 0; lf[4 + a] = 0; lf[8 + a] = -HALF - cam.p[a]; }
    }
    lf[7] = STEP; lf[11] = 40; lf[12] = 1.0; lf[13] = pointGain;
    li[16] = volId[0]; li[17] = volId[1]; li[18] = volId[2]; li[19] = volId[3];
    queue.writeBuffer(layerBuf, 0, layerData);
  }
  // the reduced-resolution volume pass (its own render pass), then blit + impostors inside the scene pass
  function drawVolumes(enc) {
    if (!nVol) return false;
    const p = enc.beginRenderPass(volAttach); p.setPipeline(volume); p.setBindGroup(0, vBind); p.draw(3); p.end();
    return true;
  }
  function draw(pass, hadVol) {
    if (hadVol) { pass.setPipeline(blit); pass.setBindGroup(0, blitBind); pass.draw(3); }
    if (fillOn) { pass.setPipeline(fillPipe); pass.setBindGroup(0, vBind); for (const L of fills) { pass.setBindGroup(1, L.bind); pass.draw(4, FN * FN * FN * L.c.per); } }
    pass.setPipeline(impostor); pass.setBindGroup(0, gBind); pass.setBindGroup(1, lBind); pass.setVertexBuffer(0, inst); pass.draw(4, N);
  }
  return { update, drawVolumes, draw, resize, near, normal: (i, a) => f[i * 10 + 5 + a], names: meta.names, count: N, pos, radius: (i) => f[i * 10 + 4], absmag: (i) => (u[i * 10 + 3] >>> 16) * 0.001 - 40 };
}
