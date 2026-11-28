import test from 'node:test';
import assert from 'node:assert/strict';
import { facts } from '../web/src/info.js';

const values = (row, here, earth) => Object.fromEntries(facts(row, here, earth).facts);

test('Sun facts use the actual Earth distance and apparent magnitude', () => {
  const sol = ['sol', 'Sol', 0, 0, 0, 0, 4.83, 0, 0];
  const f = values(sol, 2 / 206264.806, 1 / 206264.806);
  assert.equal(f['From here'], '2 AU');
  assert.equal(f['From the Earth'], '1 AU');
  assert.match(f['From the Earth’s sky'], /^magnitude -26\.7 /);
});

test('Earth distance changes with the observer for stars and planets', () => {
  const star = ['star', 'Star', 10, 0, 0, 0, 4.83, 0, 0];
  const mars = ['mars', 'Mars', 2 / 206264.806, 0, 0, 0, 0, 2, 1e-10];
  assert.notEqual(values(star, 1, 10)['From the Earth'], values(star, 1, 11)['From the Earth']);
  assert.notEqual(values(star, 1, 10)['From the Earth’s sky'], values(star, 1, 11)['From the Earth’s sky']);
  assert.equal(values(mars, 3 / 206264.806, 1 / 206264.806)['From the Earth'], '1 AU');
  assert.equal(values(mars, 2 / 206264.806, 3 / 206264.806)['From here'], '2 AU');
  assert.equal(values(mars, 2 / 206264.806, 3 / 206264.806)['From the Earth'], '3 AU');
});
