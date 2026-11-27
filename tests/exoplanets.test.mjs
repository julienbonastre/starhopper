// Checks the baked exoplanet hosts and the Earth map. Run after the bakes (bakeExoplanets, bakeEarth).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXO_SOURCES } from '../pipeline/exoplanets.mjs';
import { EARTH_SOURCES, jpegSize } from '../pipeline/earth.mjs';
import { MAP_SOURCES } from '../pipeline/maps.mjs';

const data = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const D = Math.PI / 180;
const hosts = JSON.parse(readFileSync(path.join(data, 'exoplanets.json'), 'utf8')).hosts;
const host = (n) => hosts.find((h) => h[0] === n || (h[5] || '').split(', ').includes(n));

test('well-known planetary systems are where they should be', () => {
  // name, RA, Dec (J2000, degrees), distance (pc), planets announced by the end of the pinned year (2025).
  // The archive files Kepler-90 under KOI-351 and dates Proxima d to its 2025 confirmation.
  for (const [n, ra, dec, dist, planets] of [
    ['51 Peg', 344.3667, 20.7689, 15.5, 1], ['TRAPPIST-1', 346.6224, -5.0414, 12.43, 7], ['Proxima Cen', 217.4289, -62.6795, 1.302, 2],
    ['Kepler-90', 284.4335, 49.3051, 850, 8], ['eps Eri', 53.2327, -9.4583, 3.22, 1], ['55 Cnc', 133.1492, 28.3308, 12.59, 5]]) {
    const h = host(n); assert.ok(h, `${n} is listed`);
    const d = Math.hypot(h[1], h[2], h[3]), u = [Math.cos(dec * D) * Math.cos(ra * D), Math.cos(dec * D) * Math.sin(ra * D), Math.sin(dec * D)];
    const sep = Math.acos(Math.min(1, (h[1] * u[0] + h[2] * u[1] + h[3] * u[2]) / d)) / D;
    // loose enough for the difference between the archive's epoch-2015.5 positions and J2000 for fast-moving nearby stars
    assert.ok(sep < 0.03, `${n}: ${sep.toFixed(4)} degrees from its catalogued position`);
    assert.ok(Math.abs(d / dist - 1) < 0.03, `${n}: distance ${d.toPrecision(5)} pc, expected about ${dist}`);
    assert.equal(h[4], planets, `${n}: planets`);
  }
  assert.equal(host('Kepler-90')[0], 'KOI-351');
});

test('the host list is complete, ordered and unique', () => {
  assert.ok(hosts.length > 4000 && hosts.length < 6000, `${hosts.length} hosts`);
  const planets = hosts.reduce((s, h) => s + h[4], 0);
  assert.ok(planets > 5500 && planets < 8000, `${planets} planets`);
  assert.equal(hosts[0][0], 'Proxima Cen', 'nearest first');
  const seen = new Set();
  let last = 0;
  for (const h of hosts) {
    assert.ok(h.length === 5 || (h.length === 6 && typeof h[5] === 'string' && h[5]));
    assert.ok(typeof h[0] === 'string' && h[0] && !seen.has(h[0])); seen.add(h[0]);
    const d = Math.hypot(h[1], h[2], h[3]);
    assert.ok(Number.isFinite(d) && d > 1 && d < 30000 && d >= last - 1e-6 * d, `${h[0]}: ${d} pc`); last = d;
    assert.ok(Number.isInteger(h[4]) && h[4] >= 1 && h[4] <= 8);
  }
});

test('the Earth map is a 2:1 JPEG copied untouched', () => {
  const { width, height } = jpegSize(readFileSync(path.join(data, 'earth.jpg')));
  assert.ok(width === 2 * height && width >= 2048 && width <= 8192, `${width} x ${height}`);
});

test('every planet and the Moon has a 2:1 map', () => {
  assert.deepEqual(Object.keys(MAP_SOURCES), ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'moon']);
  for (const body of Object.keys(MAP_SOURCES)) {
    const { width, height } = jpegSize(readFileSync(path.join(data, 'maps', body + '.jpg')));
    assert.ok(width === 2 * height && width >= 1024 && width <= 4096, `${body}: ${width} x ${height}`);
  }
});

test('sources are pinned by checksum', () => {
  for (const s of [...Object.values(EXO_SOURCES), ...Object.values(EARTH_SOURCES), ...Object.values(MAP_SOURCES)]) {
    assert.match(s.sha256, /^[0-9a-f]{64}$/, s.title);
    for (const k of ['title', 'url', 'file', 'licence', 'credit', 'home']) assert.ok(s[k], `${s.title}: ${k}`);
  }
});
