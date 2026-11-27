// Camera: float64 position in parsecs (J2000 equatorial axes, Sun at the origin) and a unit quaternion.
export const PC_LY = 3.2615637769, PC_AU = 206264.806247, C_PC_S = 9.7156e-9; // light-years, AU per parsec; c in pc/s

export const cam = {
  p: new Float64Array(3),
  q: new Float64Array([0, 0, 0, 1]),     // camera -> world
  right: new Float64Array(3), up: new Float64Array(3), fwd: new Float64Array(3),
  fov: 60 * Math.PI / 180,
};

export function basis() {
  const [x, y, z, w] = cam.q;
  cam.right[0] = 1 - 2 * (y * y + z * z); cam.right[1] = 2 * (x * y + z * w); cam.right[2] = 2 * (x * z - y * w);
  cam.up[0] = 2 * (x * y - z * w); cam.up[1] = 1 - 2 * (x * x + z * z); cam.up[2] = 2 * (y * z + x * w);
  // camera looks down its local -Z
  cam.fwd[0] = -2 * (x * z + y * w); cam.fwd[1] = -2 * (y * z - x * w); cam.fwd[2] = -(1 - 2 * (x * x + y * y));
}

// rotate the camera about one of its own axes (0 right / pitch, 1 up / yaw, 2 back / roll)
export function rotateLocal(axis, angle) {
  const s = Math.sin(angle / 2), c = Math.cos(angle / 2), q = cam.q;
  const ax = axis === 0 ? s : 0, ay = axis === 1 ? s : 0, az = axis === 2 ? s : 0;
  const x = q[3] * ax + q[0] * c + q[1] * az - q[2] * ay;
  const y = q[3] * ay - q[0] * az + q[1] * c + q[2] * ax;
  const z = q[3] * az + q[0] * ay - q[1] * ax + q[2] * c;
  const w = q[3] * c - q[0] * ax - q[1] * ay - q[2] * az;
  const n = 1 / Math.hypot(x, y, z, w);
  q[0] = x * n; q[1] = y * n; q[2] = z * n; q[3] = w * n;
}

// quaternion that looks along dir (world) with the given up hint; written into out
const _m = new Float64Array(9);
export function lookQuat(out, dx, dy, dz, ux, uy, uz) {
  let n = 1 / Math.hypot(dx, dy, dz); dx *= n; dy *= n; dz *= n;
  let rx = dy * uz - dz * uy, ry = dz * ux - dx * uz, rz = dx * uy - dy * ux;
  n = Math.hypot(rx, ry, rz);
  if (n < 1e-6) { rx = dy; ry = -dx; rz = 0; n = Math.hypot(rx, ry, rz) || 1; if (n === 1 && !rx && !ry) rx = 1; }
  rx /= n; ry /= n; rz /= n;
  const vx = ry * dz - rz * dy, vy = rz * dx - rx * dz, vz = rx * dy - ry * dx; // true up
  // rotation matrix columns: right, up, back(-dir)
  _m[0] = rx; _m[1] = ry; _m[2] = rz; _m[3] = vx; _m[4] = vy; _m[5] = vz; _m[6] = -dx; _m[7] = -dy; _m[8] = -dz;
  const tr = _m[0] + _m[4] + _m[8];
  let x, y, z, w;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = s / 4; x = (_m[5] - _m[7]) / s; y = (_m[6] - _m[2]) / s; z = (_m[1] - _m[3]) / s; }
  else if (_m[0] > _m[4] && _m[0] > _m[8]) { const s = Math.sqrt(1 + _m[0] - _m[4] - _m[8]) * 2; w = (_m[5] - _m[7]) / s; x = s / 4; y = (_m[3] + _m[1]) / s; z = (_m[6] + _m[2]) / s; }
  else if (_m[4] > _m[8]) { const s = Math.sqrt(1 + _m[4] - _m[0] - _m[8]) * 2; w = (_m[6] - _m[2]) / s; x = (_m[3] + _m[1]) / s; y = s / 4; z = (_m[7] + _m[5]) / s; }
  else { const s = Math.sqrt(1 + _m[8] - _m[0] - _m[4]) * 2; w = (_m[1] - _m[3]) / s; x = (_m[6] + _m[2]) / s; y = (_m[7] + _m[5]) / s; z = s / 4; }
  out[0] = x; out[1] = y; out[2] = z; out[3] = w;
}

export function slerp(out, a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3], s = 1;
  if (d < 0) { d = -d; s = -1; }
  let ka, kb;
  if (d > 0.9995) { ka = 1 - t; kb = t; } else { const th = Math.acos(d), sn = Math.sin(th); ka = Math.sin((1 - t) * th) / sn; kb = Math.sin(t * th) / sn; }
  kb *= s;
  const x = a[0] * ka + b[0] * kb, y = a[1] * ka + b[1] * kb, z = a[2] * ka + b[2] * kb, w = a[3] * ka + b[3] * kb, n = 1 / Math.hypot(x, y, z, w);
  out[0] = x * n; out[1] = y * n; out[2] = z * n; out[3] = w * n;
}
