// The eight fixed viewpoints (keys 1-8). The same poses are used by the visual review and the benchmark.
import { cam, lookQuat, basis, PC_AU } from './camera.js';

const D = Math.PI / 180;
export const eq = (raDeg, decDeg, d) => [d * Math.cos(decDeg * D) * Math.cos(raDeg * D), d * Math.cos(decDeg * D) * Math.sin(raDeg * D), d * Math.sin(decDeg * D)];
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const unit = (a) => { const n = Math.hypot(...a); return [a[0] / n, a[1] / n, a[2] / n]; };
export const NGP = eq(192.85948, 27.12825, 1);                // north galactic pole
export const GC = eq(266.40499, -28.93617, 8178);             // galactic centre (Sgr A*), GRAVITY 2019 distance
const pleiades = eq(56.75, 24.117, 136.2), orionNeb = eq(83.822, -5.391, 412), m31 = eq(10.6847, 41.2687, 765000), virgo = eq(187.706, 12.391, 16.5e6);
const north = [0, 0, 1];

export const POSES = [
  { name: 'Earth night sky', p: [1 / PC_AU, 0, 0], at: eq(84, 0, 100), up: north },
  { name: 'Leaving the Solar System', p: add(eq(275, 35, 70 / PC_AU), [0, 0, 0]), at: [0, 0, 0], up: north },
  { name: 'Among the Pleiades', p: add(pleiades, unit(pleiades), -7), at: pleiades, up: north },
  { name: 'Inside the Orion nebula', p: add(orionNeb, unit(orionNeb), -3.5), at: orionNeb, up: north },
  { name: 'Above the galactic disc', p: add(add(GC, NGP, 26000), unit(GC), -9000), at: GC, up: unit(GC) },
  { name: 'Approaching Andromeda', p: add(m31, unit(m31), -52000), at: m31, up: NGP },
  { name: 'The Local Group', p: add(add(m31, [0, 0, 0], 0.5), NGP, 1.1e6), at: add(m31, [0, 0, 0], -0.45), up: unit(m31) },
  { name: 'The cosmic web', p: add(virgo, NGP, 5.5e7), at: virgo, up: unit(GC) },
];

// some viewpoints depend on the date (where the Earth is): main places them once the Solar System is set up
export const place = (i, v) => { POSES[i].p = v.p; POSES[i].at = v.at; POSES[i].up = v.up; };
export function setPose(i) {
  const s = POSES[i]; if (!s) return;
  cam.p[0] = s.p[0]; cam.p[1] = s.p[1]; cam.p[2] = s.p[2];
  lookQuat(cam.q, s.at[0] - s.p[0], s.at[1] - s.p[1], s.at[2] - s.p[2], s.up[0], s.up[1], s.up[2]);
  basis();
}
