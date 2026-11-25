import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { ChunkCache } from '../dist/index.js';

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) {
      return;
    }
    await setImmediate();
  }
  assert.fail('Expected queued work did not run');
}

test('queued reads honor priority, promotion, concurrency and cancellation', async () => {
  const started = [],
    pending = new Map();
  const cache = new ChunkCache({
    maxBytes: 16,
    maxRequests: 1,
    load: (key) => {
      started.push(key);
      return new Promise((resolve) => pending.set(key, resolve));
    },
    byteLength: () => 4,
  });
  const signal = new AbortController().signal;
  const active = cache.read('active', signal);
  await until(() => pending.has('active'));
  const far = cache.read('far', signal, 10);
  const near = cache.read('near', signal, 0);
  const background = cache.read('background', signal, 20);
  await setImmediate();
  const promoted = cache.read('background', signal, 5);
  const cancelled = new AbortController();
  const rejected = assert.rejects(cache.read('cancelled', cancelled.signal, -1), /cancelled/);
  cancelled.abort(new Error('cancelled'));
  await rejected;
  pending.get('active')(1);
  await active;
  await until(() => pending.has('near'));
  assert.deepEqual(started, ['active', 'near']);
  pending.get('near')(2);
  await near;
  await until(() => pending.has('background'));
  assert.deepEqual(started, ['active', 'near', 'background']);
  pending.get('background')(3);
  assert.deepEqual(await Promise.all([background, promoted]), [3, 3]);
  await until(() => pending.has('far'));
  pending.get('far')(4);
  await far;
  assert.deepEqual(started, ['active', 'near', 'background', 'far']);
});

test('shared cancellation preserves other subscribers and cached results', async () => {
  let complete, transportSignal;
  let reads = 0;
  const cache = new ChunkCache({
    maxBytes: 4,
    load: (_, signal) => {
      reads++;
      transportSignal = signal;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
    byteLength: () => 4,
  });
  const first = new AbortController(),
    second = new AbortController();
  const rejected = assert.rejects(cache.read(0, first.signal), /first left/);
  const visible = cache.read(0, second.signal);
  await until(() => complete);
  first.abort(new Error('first left'));
  await rejected;
  assert.equal(transportSignal.aborted, false);
  complete(42);
  assert.equal(await visible, 42);
  assert.equal(await cache.read(0, second.signal), 42);
  assert.equal(reads, 1);
  cache.clear();
  assert.equal(cache.size, 0);
});
