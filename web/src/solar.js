// The Sun's planets at a given date, from JPL's "Approximate Positions of the Planets" (E. M. Standish, table 1:
// Keplerian elements and their rates, fitted to the DE ephemerides over 1800 AD - 2050 AD).
//   https://ssd.jpl.nasa.gov/planets/approx_pos.html
// Good to a few arcminutes inside that span (worst case Saturn, about 0.2 degrees); outside it the linear rates
// drift, so this is a picture of where the planets are, not an ephemeris.
//
// Everything is returned in the app's frame: J2000 equatorial cartesian parsecs, Sun at the origin, x toward
// RA 0 Dec 0, z toward the north celestial pole. No function here allocates.

const DEG = Math.PI / 180, AU_PC = 1 / 206264.806247;   // parsecs per AU (same constant as PC_AU in camera.js)
const J2000 = 2451545.0;
// The table is in the J2000 ecliptic; one rotation about x by the J2000 obliquity takes it to the equator.
const OBLIQUITY = 23.43928 * DEG, CE = Math.cos(OBLIQUITY), SE = Math.sin(OBLIQUITY);

// Mean radii in km (IAU volumetric means, https://ssd.jpl.nasa.gov/planets/phys_par.html). The colours are a display
// choice, not data: rough linear-RGB disc colours for telling the planets apart when they are a few pixels across.
export const SUN = { name: 'Sun', radius: 695700, color: [1, 0.96, 0.9] };
export const PLANETS = [
  { name: 'Mercury', radius: 2439.4, color: [0.30, 0.27, 0.24] },
  { name: 'Venus', radius: 6051.8, color: [0.80, 0.70, 0.48] },
  { name: 'Earth', radius: 6371.0084, color: [0.10, 0.21, 0.45] },
  { name: 'Mars', radius: 3389.5, color: [0.50, 0.20, 0.09] },
  { name: 'Jupiter', radius: 69911, color: [0.60, 0.47, 0.33] },
  // rings: C ring inner edge to A ring outer edge (km), in the planet's equator; pole is the IAU north pole
  // (RA 40.589, Dec 83.537) as a unit vector in this frame
  { name: 'Saturn', radius: 58232, color: [0.72, 0.60, 0.38], ring: { inner: 74500, outer: 136780, pole: [0.08548, 0.07324, 0.99364] } },
  { name: 'Uranus', radius: 25362, color: [0.40, 0.68, 0.72] },
  { name: 'Neptune', radius: 24622, color: [0.15, 0.28, 0.70] },
];

// Table 1, verbatim. Per planet: a (au), e, I (deg), L (deg), long.peri (deg), long.node (deg) at J2000, then the
// same six per Julian century. The third row is the Earth-Moon barycentre, not the Earth: the Earth circles it at
// about 4700 km (0.00003 AU), which is far below the accuracy of the elements, so it stands in for the Earth here.
const EL = new Float64Array([
  0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593,
  0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081,
  0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255,
  0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418,
  1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0,
  0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0,
  1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891,
  0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343,
  5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909,
  -0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106,
  9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448,
  -0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794,
  19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503,
  -0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589,
  30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574,
  0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664,
]);

// Osculating orbit of planet i at jd, left in module scalars: semi-major and semi-minor axes (pc), eccentricity,
// eccentric anomaly, and the two in-plane axes P (toward perihelion) and Q (90 degrees on, prograde), equatorial.
let _a = 0, _b = 0, _e = 0, _E = 0, _px = 0, _py = 0, _pz = 0, _qx = 0, _qy = 0, _qz = 0;
function orbit(i, jd) {
  const o = i * 12, T = (jd - J2000) / 36525;
  const a = EL[o] + EL[o + 6] * T, e = EL[o + 1] + EL[o + 7] * T, inc = (EL[o + 2] + EL[o + 8] * T) * DEG;
  const L = EL[o + 3] + EL[o + 9] * T, peri = EL[o + 4] + EL[o + 10] * T, node = (EL[o + 5] + EL[o + 11] * T) * DEG;
  const w = peri * DEG - node;
  let M = (L - peri) % 360; if (M > 180) M -= 360; else if (M < -180) M += 360;
  M *= DEG;
  // Kepler's equation by Newton's method; e < 0.21, so this settles in three or four steps
  let E = M + e * Math.sin(M);
  for (let k = 0; k < 8; k++) { const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E)); E -= d; if (Math.abs(d) < 1e-13) break; }
  const cw = Math.cos(w), sw = Math.sin(w), cn = Math.cos(node), sn = Math.sin(node), ci = Math.cos(inc), si = Math.sin(inc);
  // ecliptic P and Q, then the tilt to the equator
  const pxe = cw * cn - sw * sn * ci, pye = cw * sn + sw * cn * ci, pze = sw * si;
  const qxe = -sw * cn - cw * sn * ci, qye = -sw * sn + cw * cn * ci, qze = cw * si;
  _px = pxe; _py = CE * pye - SE * pze; _pz = SE * pye + CE * pze;
  _qx = qxe; _qy = CE * qye - SE * qze; _qz = SE * qye + CE * qze;
  _a = a * AU_PC; _b = _a * Math.sqrt(1 - e * e); _e = e; _E = E;
}

// Heliocentric position of planet i (0 Mercury .. 7 Neptune; 2 is the Earth-Moon barycentre) at Julian date jd,
// written into out[0..2] in parsecs. jd is strictly TDB/TT; UTC is a minute off, which moves nothing visibly.
export function planetPos(i, jd, out) {
  orbit(i, jd);
  const u = _a * (Math.cos(_E) - _e), v = _b * Math.sin(_E);
  out[0] = u * _px + v * _qx; out[1] = u * _py + v * _qy; out[2] = u * _pz + v * _qz;
  return out;
}

// n points (xyz triples, parsecs) around the ellipse planet i is on at jd, into out[0..3n-1]. Point 0 is exactly
// planetPos(i, jd) so a polyline passes through the planet rather than cutting the corner beside it; the rest
// follow in the direction of motion at equal steps of eccentric anomaly. The loop is open: join n-1 back to 0.
export function orbitPoints(i, n, out, jd = J2000) {
  orbit(i, jd);
  for (let k = 0, j = 0; k < n; k++) {
    const E = _E + (2 * Math.PI * k) / n, u = _a * (Math.cos(E) - _e), v = _b * Math.sin(E);
    out[j++] = u * _px + v * _qx; out[j++] = u * _py + v * _qy; out[j++] = u * _pz + v * _qz;
  }
  return out;
}

// Julian date of the system clock (UTC).
export const jdNow = () => Date.now() / 86400000 + 2440587.5;

// Greenwich mean sidereal angle in radians, 0..2pi (Meeus, Astronomical Algorithms, eq. 12.4; jd in UT).
// Convention: the Earth's spin axis is taken as +z of this frame and the prime meridian points along
// (cos t, sin t, 0), i.e. t is measured from the J2000 x axis, positive eastward about +z. A surface point at
// east longitude lon and latitude lat is at (cos lat cos(t + lon), cos lat sin(t + lon), sin lat) from the centre.
// Precession and nutation are ignored (the pole is off by 0.15 degrees in 2026), as is polar motion.
export function earthRotation(jd) {
  const d = jd - J2000, T = d / 36525;
  // the whole turns are taken out of the big term first so the fraction keeps its precision
  let t = (280.46061837 + 360 * (d % 1) + 0.98564736629 * d + (0.000387933 - T / 38710000) * T * T) % 360;
  if (t < 0) t += 360;
  return t * DEG;
}
