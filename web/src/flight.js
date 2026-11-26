// Input and the flight model. Speed is exponential and context-aware: the base speed follows the distance to the
// nearest thing, so you ease in near a star and open up in the voids; the throttle multiplies it.
import { cam, rotateLocal, lookQuat, slerp, basis } from './camera.js';

export const flight = {
  throttle: 0,                 // log10 multiplier, mouse wheel / + -
  speed: 0,                    // current speed, pc/s
  vel: new Float64Array(3),
  context: 1,                  // distance to the nearest thing, pc (set by main each frame)
  goto: null,                  // active fly-to
  locked: false,
};
const keys = new Set();
let lookX = 0, lookY = 0;
const go = { on: false, t: 0, dur: 7, from: new Float64Array(3), to: new Float64Array(3), stop: 0, q0: new Float64Array(4), q1: new Float64Array(4), d0: 1 };
const _q = new Float64Array(4);

export function initInput(canvas, onAction) {
  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
    if (!e.repeat) onAction(e.code);
    keys.add(e.code);
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());
  document.addEventListener('pointerlockchange', () => { flight.locked = document.pointerLockElement === canvas; onAction(flight.locked ? 'Locked' : 'Unlocked'); });
  addEventListener('mousemove', (e) => { if (flight.locked) { lookX += e.movementX; lookY += e.movementY; } });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); flight.throttle = Math.max(-3, Math.min(4, flight.throttle - Math.sign(e.deltaY) * 0.1)); }, { passive: false });
}

// start an eased flight to a point, stopping `stop` parsecs short of it
export function flyTo(x, y, z, stop, dur = 7) {
  go.on = true; go.t = 0; go.dur = dur;
  go.from.set(cam.p); go.to[0] = x; go.to[1] = y; go.to[2] = z; go.stop = stop;
  const dx = x - cam.p[0], dy = y - cam.p[1], dz = z - cam.p[2];
  go.d0 = Math.hypot(dx, dy, dz);
  go.q0.set(cam.q);
  if (go.d0 > stop * 1.0001) lookQuat(go.q1, dx, dy, dz, cam.up[0], cam.up[1], cam.up[2]); else go.q1.set(cam.q);
  flight.goto = go;
}
export const cancelGoto = () => { go.on = false; flight.goto = null; };

const ease = (t) => t * t * t * (t * (6 * t - 15) + 10);
export function updateFlight(dt) {
  // look
  const sens = 0.0016;
  if (lookX || lookY) { rotateLocal(1, -lookX * sens); rotateLocal(0, -lookY * sens); lookX = lookY = 0; }
  const roll = (keys.has('KeyQ') ? 1 : 0) - (keys.has('KeyE') ? 1 : 0);
  if (roll) rotateLocal(2, roll * dt * 1.2);
  basis();
  const mx = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0), my = (keys.has('KeyR') ? 1 : 0) - (keys.has('KeyF') ? 1 : 0), mz = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  if (go.on && (mx || my || mz)) cancelGoto();
  if (go.on) {
    // travel along the line with the remaining distance shrinking geometrically, so every scale gets equal time
    go.t = Math.min(1, go.t + dt / go.dur);
    const turn = Math.min(1, go.t * 5), s = ease(go.t);
    slerp(_q, go.q0, go.q1, ease(turn)); cam.q.set(_q); basis();
    const d0 = go.d0, d1 = Math.min(go.stop, d0), rem = d0 <= d1 ? d1 : d0 * Math.pow(d1 / d0, s), f = d0 > 0 ? 1 - rem / d0 : 0;
    const ox = cam.p[0], oy = cam.p[1], oz = cam.p[2];
    for (let a = 0; a < 3; a++) cam.p[a] = go.from[a] + (go.to[a] - go.from[a]) * f;
    flight.speed = dt > 0 ? Math.hypot(cam.p[0] - ox, cam.p[1] - oy, cam.p[2] - oz) / dt : 0;
    if (go.t >= 1) cancelGoto();
    return;
  }
  const boost = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 10 : 1) * (keys.has('ControlLeft') || keys.has('ControlRight') ? 0.1 : 1);
  const target = flight.context * 0.6 * Math.pow(10, flight.throttle) * boost;
  const n = Math.hypot(mx, my, mz) || 1, k = 1 - Math.exp(-dt * 5);
  for (let a = 0; a < 3; a++) {
    const want = ((cam.right[a] * mx + cam.up[a] * my + cam.fwd[a] * mz) / n) * target;
    flight.vel[a] += (want - flight.vel[a]) * k;
    cam.p[a] += flight.vel[a] * dt;
  }
  flight.speed = Math.hypot(flight.vel[0], flight.vel[1], flight.vel[2]);
}
