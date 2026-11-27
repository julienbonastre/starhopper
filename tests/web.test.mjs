// The density grid behind the cosmic web's glow: real clusters are dense, real voids are empty.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { eq2xyz } from '../pipeline/lib.mjs';

test('the density grid peaks at the Coma cluster and is empty in the Bootes void', () => {
  const { n, half } = JSON.parse(readFileSync('data/web.json', 'utf8')), g = gunzipSync(readFileSync('data/web.bin.gz'));
  assert.equal(g.length, n ** 3);
  const at = (ra, dec, mpc) => { const [x, y, z] = eq2xyz(ra, dec, mpc * 1e6).map((v) => Math.floor(((v + half) / (2 * half)) * n)); return g[(z * n + y) * n + x]; };
  const mean = g.reduce((a, b) => a + b, 0) / g.length;
  assert.ok(at(194.95, 27.98, 100) > 6 * mean, 'Coma');
  assert.ok(at(187.7, 12.4, 16.5) > 3 * mean, 'Virgo');
  assert.ok(at(218, 46, 230) < at(194.95, 27.98, 100) / 4, 'Bootes void');
});
