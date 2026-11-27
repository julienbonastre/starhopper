// Checks the baked data against well-known objects. Run after `npm run data`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const data = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const json = (f) => JSON.parse(readFileSync(path.join(data, f), 'utf8'));
const D = Math.PI / 180;
// angle (degrees) between a position and J2000 RA/Dec, and its distance
const check = (p, ra, dec, dist, tolDeg, tolFrac, what) => {
  const d = Math.hypot(...p), u = [Math.cos(dec * D) * Math.cos(ra * D), Math.cos(dec * D) * Math.sin(ra * D), Math.sin(dec * D)];
  const sep = Math.acos(Math.min(1, (p[0] * u[0] + p[1] * u[1] + p[2] * u[2]) / d)) / D;
  assert.ok(sep < tolDeg, `${what}: ${sep.toFixed(4)} degrees from its catalogued position`);
  assert.ok(Math.abs(d / dist - 1) < tolFrac, `${what}: distance ${d.toPrecision(5)} pc, expected about ${dist}`);
};

const names = json('names.json').stars, star = (n) => names.find((s) => s[0] === n);
test('bright stars are where the sky says they are', () => {
  // name, RA, Dec (J2000, degrees), distance (pc), absolute magnitude
  for (const [n, ra, dec, dist, absmag] of [
    ['Sirius', 101.2872, -16.7161, 2.64, 1.42], ['Betelgeuse', 88.7929, 7.4071, 152.7, -5.15], ['Rigil Kentaurus', 219.9021, -60.8340, 1.3475, 4.38],
    ['Polaris', 37.9546, 89.2641, 132.6, -3.6], ['Vega', 279.2347, 38.7837, 7.68, 0.58], ['Canopus', 95.9880, -52.6957, 94.8, -5.6]]) {
    const s = star(n); assert.ok(s, `${n} is in the catalogue`);
    check(s.slice(2, 5), ra, dec, dist, 0.02, 0.08, n);
    assert.ok(Math.abs(s[5] - absmag) < 0.5, `${n}: absolute magnitude ${s[5]}, expected about ${absmag}`);
  }
  const sol = star('Sol'); assert.deepEqual(sol.slice(2, 5), [0, 0, 0]);
});

test('star tiles hold every star exactly once', () => {
  const idx = json('stars/index.json');
  let total = 0;
  idx.nodes.forEach((n, i) => { total += n[4]; assert.equal(statSync(path.join(data, 'stars', i + '.bin')).size, n[4] * 16); assert.ok(n[6][0] <= n[6][8], 'brightest first'); });
  assert.equal(total, idx.count);
  assert.ok(idx.count > 2_500_000);
  // each node's brightest star is no brighter than its parent's faintest
  idx.nodes.forEach((n) => n[5].forEach((k) => { if (k >= 0) assert.ok(idx.nodes[k][6][0] >= n[6][8] - 0.01); }));
});

test('Sirius sits on the grid within a few AU of its catalogue position', () => {
  const idx = json('stars/index.json'), s = star('Sirius');
  let best = Infinity;
  idx.nodes.forEach((n, i) => {
    const size = (2 * idx.half) / 2 ** n[0], o = [n[1], n[2], n[3]].map((v) => v * size - idx.half);
    if (o.some((v, a) => s[2 + a] < v - 1e-6 || s[2 + a] > v + size + 1e-6)) return;
    const u = new Uint32Array(readFileSync(path.join(data, 'stars', i + '.bin')).buffer);
    for (let k = 0; k < u.length; k += 4) best = Math.min(best, Math.hypot(u[k] * idx.step - idx.half - s[2], u[k + 1] * idx.step - idx.half - s[3], u[k + 2] * idx.step - idx.half - s[4]));
  });
  assert.ok(best < 1e-6, `nearest grid star is ${best} pc from Sirius`);
});

test('constellation figures use real star positions', () => {
  const cons = json('constellations.json');
  assert.equal(cons.length, 88);
  const ori = cons.find((c) => c.abbr === 'Ori'), b = star('Betelgeuse');
  let hit = false;
  for (let k = 0; k < ori.pts.length; k += 3) if (Math.hypot(ori.pts[k] - b[2], ori.pts[k + 1] - b[3], ori.pts[k + 2] - b[4]) < 1e-3) hit = true;
  assert.ok(hit, 'Orion is drawn through Betelgeuse');
});

test('galaxies: the Milky Way, Andromeda and Virgo', () => {
  const meta = json('galaxies.json'), bin = readFileSync(path.join(data, 'galaxies.bin'));
  const u = new Uint32Array(bin.buffer, bin.byteOffset, bin.length / 4), f = new Float32Array(bin.buffer, bin.byteOffset, bin.length / 4);
  const at = (n) => { const i = meta.names.findIndex((x) => x[0] === n); assert.ok(i >= 0, `${n} is listed`); return { p: [0, 1, 2].map((a) => u[i * 10 + a] * meta.step - meta.half), absmag: (u[i * 10 + 3] >>> 16) / 1000 - 40, radius: f[i * 10 + 4], type: (u[i * 10 + 3] >>> 8) & 15 }; };
  assert.equal(meta.names[0][0], 'Milky Way');
  check(at('Milky Way').p, 266.405, -28.936, 8178, 0.01, 0.001, 'Galactic centre (Sgr A*)');
  const m31 = at('Andromeda Galaxy'); check(m31.p, 10.6847, 41.2687, 765000, 0.05, 0.08, 'M31');
  assert.ok(m31.radius > 15000 && m31.radius < 30000 && m31.type === 4);
  const m87 = at('Virgo Galaxy'); check(m87.p, 187.7059, 12.3911, 16.5e6, 0.05, 0.1, 'M87'); assert.equal(m87.type, 0);
  check(at('Large Magellanic Cloud').p, 80.894, -69.756, 50000, 0.5, 0.1, 'LMC');
  check(at('Whirlpool Galaxy').p, 202.4696, 47.1952, 8.4e6, 0.05, 0.15, 'M51');
  const idx = json('galaxies/index.json'); assert.ok(idx.count > 300_000);
  assert.equal(idx.nodes.reduce((s, n) => s + n[4], 0), idx.count);
});

test('every source is pinned by checksum', () => {
  for (const s of json('manifest.json').sources) assert.match(s.sha256, /^[0-9a-f]{64}$/, s.title);
});

test('the sky from Earth matches the real constellations', () => {
  // each figure passes through its best-known stars, and those stars are where the sky has them (seen from the Sun,
  // which is the Earth's sky to within the stars' parallaxes)
  const cons = json('constellations.json'), by = (abbr) => cons.find((c) => c.abbr === abbr);
  const through = (abbr, name) => { const c = by(abbr), s = star(name); assert.ok(c && s, `${abbr} and ${name} exist`); let hit = false; for (let k = 0; k < c.pts.length; k += 3) if (Math.hypot(c.pts[k] - s[2], c.pts[k + 1] - s[3], c.pts[k + 2] - s[4]) < 1e-3) hit = true; assert.ok(hit, `${abbr} is drawn through ${name}`); };
  for (const [abbr, name] of [['Ori', 'Rigel'], ['Ori', 'Bellatrix'], ['UMa', 'Dubhe'], ['UMa', 'Alkaid'], ['Cru', 'Acrux'], ['Sco', 'Antares'], ['Cyg', 'Deneb'], ['Lyr', 'Vega'], ['CMa', 'Sirius'], ['Leo', 'Regulus'], ['Tau', 'Aldebaran'], ['Cas', 'Schedar']]) through(abbr, name);
  // angles between stars, as seen from the origin, against their true separations on the sky (degrees)
  const sep = (a, b) => { const p = star(a).slice(2, 5), q = star(b).slice(2, 5); return Math.acos((p[0] * q[0] + p[1] * q[1] + p[2] * q[2]) / (Math.hypot(...p) * Math.hypot(...q))) / D; };
  for (const [a, b, deg] of [['Betelgeuse', 'Rigel', 18.6], ['Dubhe', 'Merak', 5.37], ['Sirius', 'Procyon', 25.7], ['Vega', 'Altair', 34.2], ['Castor', 'Pollux', 4.5]]) assert.ok(Math.abs(sep(a, b) - deg) < 0.15, `${a} to ${b}: ${sep(a, b).toFixed(2)} degrees, expected ${deg}`);
  // the constellation labels sit at the mean direction of the figure: Orion's is near RA 5.5 h on the equator
  const o = by('Ori'); let m = [0, 0, 0];
  for (let k = 0; k < o.pts.length; k += 3) { const n = Math.hypot(o.pts[k], o.pts[k + 1], o.pts[k + 2]); m = m.map((v, a) => v + o.pts[k + a] / n); }
  check(m.map((v) => v * 100), 83, 3, Math.hypot(...m) * 100, 8, 1e-9, 'centre of Orion');
});
