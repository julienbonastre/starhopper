import test from 'node:test';
import assert from 'node:assert/strict';
import { cam, basis } from '../web/src/camera.js';
import { flight, flyTo, cancelGoto, updateFlight, initInput } from '../web/src/flight.js';

test('fly-to reports completion, but not a manual cancellation', () => {
  cam.p.fill(0); cam.q.set([0, 0, 0, 1]); basis();
  flight.thr = 0; flight.cruise = true; flight.vel.set([1, 2, 3]);
  flyTo(10, 0, 0, 1, 1);
  assert.equal(updateFlight(0.5), undefined);
  assert.equal(updateFlight(0.5), true);
  assert.equal(flight.goto, null);

  flyTo(20, 0, 0, 1, 1);
  cancelGoto();
  assert.equal(updateFlight(0), undefined);
  assert.equal(flight.cruise, true);
  assert.deepEqual([...flight.vel], [1, 2, 3]);
});

test('manual thrust cancels a fly-to without reporting completion', () => {
  const handlers = {};
  globalThis.addEventListener = (name, fn) => { (handlers[name] ||= []).push(fn); };
  globalThis.document = { addEventListener() {} };
  initInput({ addEventListener() {} }, () => {});
  cam.p.fill(0); cam.q.set([0, 0, 0, 1]); basis();
  flight.thr = 0; flight.cruise = true; flight.vel.set([1, 2, 3]);
  flyTo(10, 0, 0, 1, 1);
  for (const fn of handlers.keydown) fn({ code: 'KeyW', target: { tagName: 'BODY' } });
  assert.equal(updateFlight(0), undefined);
  assert.equal(flight.goto, null);
  assert.equal(flight.cruise, true);
  assert.deepEqual([...flight.vel], [1, 2, 3]);
  for (const fn of handlers.keyup) fn({ code: 'KeyW' });
  delete globalThis.addEventListener;
  delete globalThis.document;
});
