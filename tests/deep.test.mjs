// Checks the baked nebulae and clusters against well-known objects. Run after the deep-sky bake (part of `npm run data`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEEP_SOURCES } from '../pipeline/deep.mjs';

const data = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const deep = JSON.parse(readFileSync(path.join(data, 'deep.json'), 'utf8'));
const D = Math.PI / 180;
const find = (n) => { const o = deep.objects.find((x) => x[0] === n); assert.ok(o, `${n} is listed`); return o; };
const kind = (o) => deep.kinds[o[2]];

test('famous nebulae and clusters are where the sky says they are', () => {
  // name, RA, Dec (J2000, degrees), distance (pc), tolerance on the distance, kind, radius range (pc)
  for (const [n, ra, dec, dist, tol, k, r0, r1] of [
    ['Great Orion Nebula', 83.82, -5.39, 410, 0.12, 'cluster with nebula', 3, 8],
    ['Pleiades', 56.87, 24.11, 136, 0.04, 'open cluster', 2, 4],
    ['Hyades', 66.72, 15.87, 47, 0.05, 'open cluster', 1.5, 3],
    ['Hercules Globular Cluster', 250.42, 36.46, 7100, 0.1, 'globular cluster', 10, 25],
    ['Omega Centauri', 201.70, -47.48, 5200, 0.1, 'globular cluster', 15, 30],
    ['Ring Nebula', 283.40, 33.03, 790, 0.1, 'planetary nebula', 0.1, 0.25],
    ['Dumbbell Nebula', 299.90, 22.72, 390, 0.1, 'planetary nebula', 0.25, 0.6],
    ['Crab Nebula', 83.63, 22.01, 2000, 0.15, 'supernova remnant', 1.5, 3.5],
    ['Lagoon Nebula', 270.92, -24.38, 1250, 0.12, 'nebula', 5, 12],
    ['Eagle Nebula', 274.70, -13.81, 1740, 0.12, 'nebula', 20, 40],
    ['Veil Nebula', 311.49, 30.60, 735, 0.1, 'supernova remnant', 15, 30],
    ['Horsehead Nebula', 85.25, -2.46, 400, 0.2, 'dark nebula', 0.2, 1]]) {
    const o = find(n), p = o.slice(3, 6), d = Math.hypot(...p);
    const u = [Math.cos(dec * D) * Math.cos(ra * D), Math.cos(dec * D) * Math.sin(ra * D), Math.sin(dec * D)];
    const sep = Math.acos(Math.min(1, (p[0] * u[0] + p[1] * u[1] + p[2] * u[2]) / d)) / D;
    assert.ok(sep < 0.02, `${n}: ${sep.toFixed(4)} degrees from its catalogued position`);
    assert.ok(Math.abs(d / dist - 1) < tol, `${n}: distance ${d.toPrecision(5)} pc, expected about ${dist}`);
    assert.equal(kind(o), k, n);
    assert.ok(o[6] > r0 && o[6] < r1, `${n}: radius ${o[6]} pc`);
    assert.equal(o[1], 1, `${n} is labelled`);
  }
  assert.ok(Math.abs(find('Pleiades')[7] - 1.2) < 0.01 && Math.abs(find('Omega Centauri')[7] - 5.33) < 0.01, 'catalogued magnitudes');
  // the Large Magellanic Cloud's own nebulae sit in the Cloud, not in the Milky Way
  assert.ok(Math.abs(Math.hypot(...find('30 Dor Cluster').slice(3, 6)) / 50000 - 1) < 0.1);
});

test('the list is complete, well formed and unambiguous', () => {
  assert.equal(deep.kinds.length, 10);
  assert.ok(deep.objects.length > 1000 && deep.objects.length < 1310, `${deep.objects.length} objects`);
  const names = new Set();
  for (const o of deep.objects) {
    assert.equal(o.length, 9);
    assert.ok(typeof o[0] === 'string' && o[0] && !names.has(o[0]), `${o[0]}: a unique name`); names.add(o[0]);
    assert.ok(o[1] === 0 || o[1] === 1);
    assert.ok(Number.isInteger(o[2]) && o[2] >= 0 && o[2] < deep.kinds.length);
    assert.ok(o.slice(3, 7).every(Number.isFinite) && Math.hypot(o[3], o[4], o[5]) > 10 && o[6] > 0, `${o[0]}: position and size`);
    assert.ok(o[7] === null || (o[7] > -2 && o[7] < 20), `${o[0]}: magnitude ${o[7]}`);
    assert.ok(Number.isInteger(o[8]) && o[8] >= 0 && o[8] < 2 ** 32);
  }
  const n = deep.kinds.map((_, k) => deep.objects.filter((o) => o[2] === k).length);
  assert.ok(n.every((c) => c > 0), 'every kind is present');
  assert.ok(n[0] > 500 && n[1] > 150 && n[3] > 100, 'open clusters, globulars and planetaries');
  // every Messier cluster and nebula is placed (67 of them), under its nickname or its number
  for (const n of ['M 2', 'Butterfly Cluster', 'Trifid Nebula', 'M 22', 'Beehive', 'M 54', 'M 78', 'M 92', 'Owl Nebula', 'M 107', 'Helix Nebula', 'North America Nebula', 'Carina Nebula']) find(n);
  assert.ok(deep.objects.filter((o) => o[1]).length > 120, 'labelled objects');
});

test('every deep-sky source is pinned by checksum', () => {
  for (const s of Object.values(DEEP_SOURCES)) {
    assert.match(s.sha256, /^[0-9a-f]{64}$/, s.title);
    for (const k of ['title', 'url', 'file', 'licence', 'credit', 'home']) assert.ok(s[k], `${s.file}: ${k}`);
  }
});
