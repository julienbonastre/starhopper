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
  tapX: 0, tapY: 0,            // where the last touch tap landed (CSS pixels)
  menu: false,                 // a touch-and-hold menu is open: the finger that opened it does not steer
  thr: 0,                      // the touch throttle strip, -1 (back) .. 1 (forward)
  sx: 0, sy: 0,                // the touch stick: sideways and up/down thrust, -1 .. 1 each
  ahead: false,                // thrust along the view is being asked for this frame
  lock: false,                 // keep facing the target, at the same range, so that sideways thrust circles it
  wheel: false,                // the throttle is being set by scrolling (a desktop): it stays where it is put
  cruise: false,               // the strip stays where it is let go (the Hold button), so the flight carries on hands-free
};
const keys = new Set(), EDGE = 1.5e9;   // parsecs
let lookX = 0, lookY = 0, touchX = 0, touchY = 0, touchFwd = 0;
const go = { on: false, slow: false, t: 0, dur: 7, from: new Float64Array(3), to: new Float64Array(3), stop: 0, q0: new Float64Array(4), q1: new Float64Array(4), d0: 1 };
const _q = new Float64Array(4);

export function initInput(canvas, onAction) {
  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
    if (!e.repeat) onAction(e.code, e.shiftKey);
    keys.add(e.code);
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());
  document.addEventListener('pointerlockchange', () => { flight.locked = document.pointerLockElement === canvas; onAction(flight.locked ? 'Locked' : 'Unlocked'); });
  addEventListener('mousemove', (e) => { if (flight.locked) { lookX += e.movementX; lookY += e.movementY; } });
  // Touch. A finger on the sky drags the view (the sky follows the finger). The strip along the right edge is the
  // throttle: a thumb there, pushed up, flies forward, faster the further it goes, and pulled down flies back; lifting
  // it stops. Two fingers on the sky: spread to fly forward, pinch to back away, twist to roll. A quick tap targets,
  // a double tap flies there, a finger held still on something offers to go there.
  const tp = new Map(); let pinch0 = 0, twist = 0, rolling = false, two = false, downT = 0, lastTap = 0, holdTimer = 0, thrId = -1;
  const HOLD_MS = 450, SLOP = 12, STRIP = 76;
  // the stick: a ring near the bottom left corner (centre STICK_X from the left, STICK_Y up from the bottom)
  const STICK_X = 68, STICK_Y = 64, STICK_R = 46; let stickId = -1;
  const stick = (t) => { let x = (t.x - STICK_X) / STICK_R, y = (innerHeight - STICK_Y - t.y) / STICK_R; const n = Math.hypot(x, y); if (n > 1) { x /= n; y /= n; } flight.sx = n < 0.14 ? 0 : x; flight.sy = n < 0.14 ? 0 : y; };
  const looks = () => { const a = []; for (const [id, t] of tp) if (id !== thrId && id !== stickId) a.push(t); return a; };
  const reset = () => { tp.clear(); thrId = -1; stickId = -1; flight.sx = flight.sy = 0; two = false; if (!flight.cruise && !flight.wheel) flight.thr = 0; touchFwd = 0; clearTimeout(holdTimer); };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    if (e.isPrimary) reset();                         // a first finger: whatever was left over from a lost touch is void
    try { canvas.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
    tp.set(e.pointerId, { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, moved: false, v0: flight.cruise ? flight.thr : 0 });
    if (flight.menu) { flight.menu = false; onAction('Touch'); }               // any new touch puts the hold menu away
    clearTimeout(holdTimer);
    if (thrId < 0 && e.clientX > innerWidth - STRIP) { thrId = e.pointerId; return; }
    if (stickId < 0 && Math.hypot(e.clientX - STICK_X, e.clientY - (innerHeight - STICK_Y)) < STICK_R * 1.5) { stickId = e.pointerId; stick(tp.get(e.pointerId)); return; }
    const l = looks();
    downT = performance.now(); two = l.length === 2; pinch0 = 0; rolling = false; touchFwd = 0;
    if (l.length === 1) holdTimer = setTimeout(() => { const t = looks()[0]; if (looks().length === 1 && t && !t.moved) { flight.tapX = t.x; flight.tapY = t.y; onAction('Hold'); } }, HOLD_MS);
  });
  canvas.addEventListener('pointermove', (e) => {
    const t = tp.get(e.pointerId); if (!t) return;
    const dx = e.clientX - t.x, dy = e.clientY - t.y;
    t.x = e.clientX; t.y = e.clientY;
    if (Math.hypot(t.x - t.x0, t.y - t.y0) > SLOP) t.moved = true;
    if (e.pointerId === stickId) { stick(t); return; }
    if (e.pointerId === thrId) { const v = Math.max(-1, Math.min(1, t.v0 + (t.y0 - t.y) / (innerHeight * 0.32))); flight.thr = Math.abs(v) < 0.08 ? 0 : v; return; }
    const l = looks();
    if (l.length === 1 && t.moved && !flight.menu) { touchX += dx; touchY += dy; }
    else if (l.length === 2) {
      const [a, b] = l, d = Math.hypot(a.x - b.x, a.y - b.y), ang = Math.atan2(b.y - a.y, b.x - a.x);
      if (pinch0) {
        let da = ang - twist; if (da > Math.PI) da -= 2 * Math.PI; else if (da < -Math.PI) da += 2 * Math.PI;
        // a twist has to be meant (ten degrees) before it rolls, so that a pinch does not also tip the horizon
        if (rolling) { rotateLocal(2, -da); twist = ang; } else if (Math.abs(da) > 0.17) { rolling = true; twist = ang; }
        const z = Math.log(d / pinch0) * 2.2;
        touchFwd = Math.abs(z) < 0.12 ? 0 : Math.max(-1, Math.min(1, z));
      } else { pinch0 = d; twist = ang; }
    }
  });
  const up = (e) => {
    const t = tp.get(e.pointerId); if (!t) return;
    tp.delete(e.pointerId); clearTimeout(holdTimer);
    if (e.pointerId === stickId) { stickId = -1; flight.sx = flight.sy = 0; return; }
    if (e.pointerId === thrId) { thrId = -1; if (!flight.cruise) flight.thr = 0; return; }
    pinch0 = 0; touchFwd = 0; rolling = false;
    if (!two && !flight.menu && performance.now() - downT < 220 && !t.moved) { const now = performance.now(), dbl = now - lastTap < 380; lastTap = dbl ? 0 : now; flight.tapX = t.x; flight.tapY = t.y; onAction(dbl ? 'DoubleTap' : 'Tap'); }
    if (!looks().length) two = false;
  };
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(ev, up);
  // a touch the browser took away without telling (a system gesture, the app going to the background) must not
  // leave a finger "down" for ever
  addEventListener('blur', reset); document.addEventListener('visibilitychange', reset);
  // Scrolling (a wheel, or two fingers on a trackpad) moves the same throttle the touch strip does, and it stays
  // where it is put: several swipes from standstill to the top, so there is room to be precise. Space stops.
  let raw = 0;
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const dy = e.deltaMode ? e.deltaY * 33 : e.deltaY;
    if (Math.abs(raw - flight.thr) > 0.09) raw = flight.thr;           // something else moved it (Space, the menu)
    raw = Math.max(-1, Math.min(1, raw - Math.max(-120, Math.min(120, dy)) / 2500));
    flight.thr = Math.abs(raw) < 0.08 ? 0 : raw; flight.wheel = true;
  }, { passive: false });
  addEventListener('keydown', (e) => { if (e.code === 'Space' && e.target.tagName !== 'INPUT' && flight.wheel) { flight.thr = 0; raw = 0; } });
}

// start an eased flight to a point, stopping `stop` parsecs short of it
// (q1: an orientation to arrive with, turned to steadily over the whole flight; otherwise the camera faces the target)
export function flyTo(x, y, z, stop, dur = 7, q1 = null) {
  go.on = true; go.t = 0; go.dur = dur;
  go.from.set(cam.p); go.to[0] = x; go.to[1] = y; go.to[2] = z; go.stop = stop;
  const dx = x - cam.p[0], dy = y - cam.p[1], dz = z - cam.p[2];
  go.d0 = Math.hypot(dx, dy, dz);
  go.q0.set(cam.q);
  go.slow = !!q1;
  if (q1) go.q1.set(q1); else if (go.d0 > stop * 1.0001) lookQuat(go.q1, dx, dy, dz, cam.up[0], cam.up[1], cam.up[2]); else go.q1.set(cam.q);
  flight.goto = go;
}
// the place a fly-to is heading for has moved (a planet, with the clock running)
export function retarget(x, y, z) {
  go.to[0] = x; go.to[1] = y; go.to[2] = z;
  // the whole line is re-measured from where the flight began, so it still stops the asked distance short and,
  // unless an arrival attitude was asked for, ends up facing the place as it now is
  const dx = x - go.from[0], dy = y - go.from[1], dz = z - go.from[2];
  go.d0 = Math.hypot(dx, dy, dz);
  if (!go.slow && go.d0 > go.stop * 1.0001) lookQuat(go.q1, dx, dy, dz, cam.up[0], cam.up[1], cam.up[2]);
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
  // a finger dragging the sky: the point under it stays under it
  if (touchX || touchY) { const k = 2 * Math.tan(cam.fov / 2) / innerHeight; rotateLocal(1, touchX * k); rotateLocal(0, touchY * k); touchX = touchY = 0; basis(); }
  // touch thrust: the strip is exponential (a tenth of the usual speed at its dead zone, ten times at the end)
  const th = flight.thr || touchFwd, tz = th ? Math.sign(th) * Math.pow(10, 2 * Math.abs(th) - 1) : 0;
  const kz = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  const mx = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0) + flight.sx, my = (keys.has('KeyR') ? 1 : 0) - (keys.has('KeyF') ? 1 : 0) + flight.sy, mz = kz + tz;
  // the keys take the controls back from a fly-to; the touch throttle only sets its pace
  flight.ahead = mz !== 0;
  if (go.on && (mx || my || kz)) cancelGoto();
  if (go.on) {
    // travel along the line with the remaining distance shrinking geometrically, so every scale gets equal time
    // pace: the throttle strip pushed up hurries the flight (up to ten times), pulled down slows it to a standstill
    go.t = Math.min(1, go.t + dt / go.dur * (th > 0 ? Math.pow(10, th) : 1 + th));
    const turn = go.slow ? go.t : Math.min(1, go.t * 5), s = ease(go.t);
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
  const n = Math.max(1, Math.hypot(mx, my, Math.sign(mz))), k = 1 - Math.exp(-dt * 5);
  for (let a = 0; a < 3; a++) {
    const want = ((cam.right[a] * mx + cam.up[a] * my + cam.fwd[a] * mz) / n) * target;
    flight.vel[a] += (want - flight.vel[a]) * k;
    cam.p[a] += flight.vel[a] * dt;
  }
  // the map ends: nothing is catalogued or modelled past a few gigaparsecs, so the flight stops there
  const far = Math.hypot(cam.p[0], cam.p[1], cam.p[2]);
  if (far > EDGE) for (let a = 0; a < 3; a++) { cam.p[a] *= EDGE / far; flight.vel[a] = 0; }
  flight.speed = Math.hypot(flight.vel[0], flight.vel[1], flight.vel[2]);
}
