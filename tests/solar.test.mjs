// Checks the planet positions and the Earth's rotation angle against JPL Horizons and textbook values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyFrame, MOON, moonPos, PLANETS, SUN, planetPos, orbitPoints, jdNow, earthRotation } from '../web/src/solar.js';

const D = Math.PI / 180, AU = 206264.806247, EPS = 23.43928 * D;
const p = new Float64Array(3);
const au = (i, jd) => [...planetPos(i, jd, p)].map((v) => v * AU);

// Heliocentric positions in AU, ICRF/J2000 equatorial, from JPL Horizons (DE441; ssd.jpl.nasa.gov/api/horizons.api,
// EPHEM_TYPE=VECTORS, CENTER='500@10', REF_PLANE=FRAME, targets 199, 299, 3 (Earth-Moon barycentre), 499 .. 899),
// fetched 2026-11-27. Three dates across the table's span: 1900 Jan 1 0h, J2000.0, 2026 Nov 27 12h (TDB).
const HORIZONS = {
  2415020.5: [
    [-0.3873786086579065, -0.1581390182999799, -0.04415772887769986], [0.6998542285711752, -0.1605752580060074, -0.1165365881967233],
    [-0.1968855472576664, 0.8837457891609398, 0.3833844991750003], [0.4353672637661962, -1.225360138887019, -0.5738531779562993],
    [-3.016039428434643, -4.126277988552982, -1.695438766522865], [-0.3669668301916346, -9.304564897979818, -3.825207683726771],
    [-6.479284813345925, -16.38726980633983, -7.085389140133518], [1.514870538411453, 27.62263225642609, 11.26838123718069]],
  2451545.0: [
    [-0.1300936053754522, -0.4005937216423254, -0.2004893020167260], [-0.7183022963453890, -0.04627424670211335, 0.02464063845542861],
    [-0.1771587841839055, 0.8874068591468631, 0.3847367179193813], [1.390715921746351, 0.001401217628018087, -0.03696016719545011],
    [4.001177435589426, 2.736578429014779, 1.075512145491845], [6.406410428378656, 6.174656543706226, 2.274770736147758],
    [14.43185527695361, -12.50626800111609, -5.681690901963971], [16.81204760586415, -22.98010069273434, -9.824428136008825]],
  2461372.0: [
    [-0.3696592565781641, 0.03571027073326853, 0.05738702931145897], [0.05594266836556486, 0.6558614084547930, 0.2915832158221752],
    [0.4189736139427029, 0.8197244535428185, 0.3553307424125409], [-0.6288175839721413, 1.351145591486976, 0.6366983756872836],
    [-3.810851203401525, 3.384298041895402, 1.543366096313984], [9.175856947418353, 2.067957752062600, 0.4589815430111697],
    [8.727259452046384, 15.94739063558121, 6.860979525127488], [29.82718316879086, 1.718714571072722, -0.03907423182887574]],
};

test('planets are where JPL Horizons puts them', () => {
  for (const [jd, rows] of Object.entries(HORIZONS)) rows.forEach((h, i) => {
    const q = au(i, +jd), r = Math.hypot(...q), rh = Math.hypot(...h), what = `${PLANETS[i].name} at JD ${jd}`;
    const sep = Math.acos(Math.min(1, (q[0] * h[0] + q[1] * h[1] + q[2] * h[2]) / (r * rh))) / D;
    // Standish quotes up to 600 arcsec for Saturn and 400 for Jupiter over 1800-2050, a few tens for the rest
    assert.ok(sep < (i === 4 || i === 5 ? 0.25 : 0.03), `${what}: ${sep.toFixed(4)} degrees from Horizons`);
    assert.ok(Math.abs(r / rh - 1) < 0.003, `${what}: ${r.toFixed(5)} AU from the Sun, Horizons says ${rh.toFixed(5)}`);
  });
});

test('every planet stays between its perihelion and aphelion', () => {
  // perihelion and aphelion distances in AU (NASA planetary fact sheets), with 1% slack for the slow change of the orbits
  const range = [[0.3075, 0.4667], [0.7184, 0.7282], [0.9833, 1.0167], [1.3814, 1.6660], [4.9506, 5.4570], [9.0412, 10.1238], [18.2861, 20.0965], [29.8108, 30.3271]];
  assert.equal(PLANETS.length, 8);
  for (let i = 0; i < 8; i++) {
    let lo = Infinity, hi = 0;
    // 1800 to 2050 in steps that are not a multiple of any orbital period
    for (let jd = 2378496.5; jd < 2469807.5; jd += 173.31) { const r = Math.hypot(...au(i, jd)); lo = Math.min(lo, r); hi = Math.max(hi, r); }
    assert.ok(lo > range[i][0] * 0.99 && hi < range[i][1] * 1.01, `${PLANETS[i].name}: ${lo.toFixed(4)} to ${hi.toFixed(4)} AU`);
    // the four inner planets complete many orbits in that span, so they must also reach both ends
    if (i < 4) assert.ok(lo < range[i][0] * 1.01 && hi > range[i][1] * 0.99, `${PLANETS[i].name} reaches perihelion and aphelion`);
  }
});

test('the Earth at J2000.0', () => {
  const [x, y, z] = au(2, 2451545.0), r = Math.hypot(x, y, z);
  assert.ok(Math.abs(r - 0.9833) < 0.001, `${r} AU: early January, so close to perihelion`);
  // back to the ecliptic: the Earth is opposite the Sun, whose longitude at J2000.0 is 280.4 degrees
  const ye = Math.cos(EPS) * y + Math.sin(EPS) * z, ze = -Math.sin(EPS) * y + Math.cos(EPS) * z;
  const lon = (Math.atan2(ye, x) / D + 360) % 360;
  assert.ok(Math.abs(lon - 100.4) < 0.2, `ecliptic longitude ${lon.toFixed(3)}`);
  assert.ok(Math.abs(ze) < 1e-4, `the Earth is in the ecliptic (z = ${ze} AU)`);
});

test('orbit lines pass through the planet and close on themselves', () => {
  const n = 64, pts = new Float64Array(3 * n), jd = 2461372.0;
  for (let i = 0; i < 8; i++) {
    orbitPoints(i, n, pts, jd); planetPos(i, jd, p);
    assert.deepEqual([pts[0], pts[1], pts[2]], [...p], `${PLANETS[i].name}: point 0 is the planet`);
    // a quarter of the way round in eccentric anomaly is later in time: the line runs the way the planet moves
    planetPos(i, jd + 1, p);
    const ahead = (pts[3] - pts[0]) * (p[0] - pts[0]) + (pts[4] - pts[1]) * (p[1] - pts[1]) + (pts[5] - pts[2]) * (p[2] - pts[2]);
    assert.ok(ahead > 0, `${PLANETS[i].name}: orbit points run prograde`);
    let lo = Infinity, hi = 0;
    for (let k = 0; k < n; k++) { const r = Math.hypot(pts[3 * k], pts[3 * k + 1], pts[3 * k + 2]) * AU; lo = Math.min(lo, r); hi = Math.max(hi, r); assert.ok(r === r); }
    assert.ok(hi / lo < 1.6 && lo > 0.3 && hi < 30.4);
  }
  const f = new Float32Array(3 * n); orbitPoints(2, n, f);
  assert.ok(Math.abs(Math.hypot(f[0], f[1], f[2]) * AU - 0.9833) < 0.001, 'Float32Array output, default epoch J2000');
});

test('Greenwich sidereal angle', () => {
  assert.ok(Math.abs(earthRotation(2451545.0) / D - 280.46062) < 1e-4, 'GMST at J2000.0 is 18h 41m 50.5s');
  // Meeus, Astronomical Algorithms, example 12.a: 1987 April 10, 0h UT -> 13h 10m 46.3668s
  const meeus = (13 + 10 / 60 + 46.3668 / 3600) * 15;
  assert.ok(Math.abs(earthRotation(2446895.5) / D - meeus) < 1e-4, `${earthRotation(2446895.5) / D} vs ${meeus}`);
  // one sidereal day later the Earth has turned exactly once
  const a = earthRotation(2461372.0), b = earthRotation(2461372.0 + 0.99726956633);
  assert.ok(Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a))) < 1e-6);
  for (const jd of [2378496.5, 2451545.0, 2469807.5]) assert.ok(earthRotation(jd) >= 0 && earthRotation(jd) < 2 * Math.PI);
});

test('constants and the clock', () => {
  assert.deepEqual(PLANETS.map((x) => x.name), ['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune']);
  for (const b of [SUN, ...PLANETS]) { assert.ok(b.radius > 2000 && b.radius < 7e5); assert.equal(b.color.length, 3); for (const c of b.color) assert.ok(c >= 0 && c <= 1); }
  const ring = PLANETS[5].ring;
  assert.ok(ring.inner > PLANETS[5].radius && ring.outer > ring.inner && Math.abs(Math.hypot(...ring.pole) - 1) < 1e-4);
  // Saturn's equator is tilted 26.7 degrees to its orbit, so the ring pole is that far from the orbit normal
  const a = new Float64Array(3), b = new Float64Array(3); planetPos(5, 2451545, a); planetPos(5, 2451545 + 2000, b);
  const nrm = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], len = Math.hypot(...nrm);
  const tilt = Math.acos((nrm[0] * ring.pole[0] + nrm[1] * ring.pole[1] + nrm[2] * ring.pole[2]) / len) / D;
  assert.ok(Math.abs(tilt - 26.73) < 0.2, `Saturn's obliquity ${tilt.toFixed(2)}`);
  const now = jdNow(); assert.ok(Math.abs(now - (Date.now() / 86400000 + 2440587.5)) < 1e-6 && now > 2461000);
  assert.ok(Math.abs((Date.UTC(2000, 0, 1, 12) / 86400000 + 2440587.5) - 2451545.0) < 1e-9, 'the Unix epoch is JD 2440587.5');
});

test('the Moon is where Meeus puts it on 1992 April 12, and always at a lunar distance', () => {
  const KM = 3.0856775814913673e13, v = moonPos(2448724.5, [0, 0, 0]), r = Math.hypot(...v);
  // Meeus, Astronomical Algorithms, example 47.a: longitude 133.162, latitude -3.229 (of date), 368,409.7 km
  const e = 23.43928 * Math.PI / 180, y = Math.cos(e) * v[1] + Math.sin(e) * v[2], z = -Math.sin(e) * v[1] + Math.cos(e) * v[2];
  const lon = Math.atan2(y, v[0]) * 180 / Math.PI, lat = Math.asin(z / r) * 180 / Math.PI;
  assert.ok(Math.abs(lon - (133.162 + 1.39697 * 0.0772)) < 0.5, 'longitude ' + lon);
  assert.ok(Math.abs(lat + 3.229) < 0.4, 'latitude ' + lat);
  assert.ok(Math.abs(r * KM - 368409.7) < 2500, 'distance ' + r * KM);
  for (let d = 0; d < 400; d += 3) { const k = Math.hypot(...moonPos(2461000 + d, [0, 0, 0])) * KM; assert.ok(k > 354000 && k < 408000, 'distance ' + k); }
  assert.equal(MOON.name, 'Moon');
});

// longitude and latitude (degrees) of the point on a body that faces along v (from its centre)
function facing(name, jd, v) {
  const f = bodyFrame(name, jd, [0, 0, 0, 0]), p = [f[0], f[1], f[2]];
  let x = Math.abs(p[2]) > 0.99999 ? [0, 1, 0] : [-p[1], p[0], 0]; const xl = Math.hypot(...x); x = x.map((c) => c / xl);
  const y = [p[1] * x[2] - p[2] * x[1], p[2] * x[0] - p[0] * x[2], p[0] * x[1] - p[1] * x[0]], n = Math.hypot(...v);
  const dot = (a) => (a[0] * v[0] + a[1] * v[1] + a[2] * v[2]) / n;
  let lon = (Math.atan2(dot(y), dot(x)) - f[3]) * 180 / Math.PI; lon = ((lon + 540) % 360) - 180;
  return [lon, Math.asin(dot(p)) * 180 / Math.PI];
}

test('the Moon keeps its near side to the Earth, and the Earth frame agrees with sidereal time', () => {
  // the middle of the map's near side stays within the librations (about 8 degrees each way) of the Earth
  for (let d = 0; d < 9000; d += 7.3) {
    const jd = 2458000 + d, m = moonPos(jd, [0, 0, 0]), [lon, lat] = facing('Moon', jd, [-m[0], -m[1], -m[2]]);
    assert.ok(Math.abs(lon) < 9.5 && Math.abs(lat) < 8, `JD ${jd}: sub-Earth point ${lon.toFixed(1)}, ${lat.toFixed(1)}`);
  }
  // Greenwich's meridian points along (cos t, sin t, 0)
  const jd = 2461372.25, t = earthRotation(jd), [lon, lat] = facing('Earth', jd, [Math.cos(t), Math.sin(t), 0]);
  assert.ok(Math.abs(lon) < 1e-6 && Math.abs(lat) < 1e-6);
  // Mars: obliquity 25.2 degrees, and one turn per 24 h 37 min 22.7 s
  const a = new Float64Array(3), b = new Float64Array(3); planetPos(3, 2451545, a); planetPos(3, 2451545 + 200, b);
  const nrm = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], len = Math.hypot(...nrm), f = bodyFrame('Mars', 2451545, [0, 0, 0, 0]);
  const tilt = Math.acos((nrm[0] * f[0] + nrm[1] * f[1] + nrm[2] * f[2]) / len) / D;
  assert.ok(Math.abs(tilt - 25.19) < 0.2, `Mars's obliquity ${tilt.toFixed(2)}`);
  const w0 = bodyFrame('Mars', 2461000, [0, 0, 0, 0])[3], w1 = bodyFrame('Mars', 2461000 + 88642.6632 / 86400, [0, 0, 0, 0])[3];
  assert.ok(Math.abs(Math.sin(w1 - w0)) < 1e-4);
});
