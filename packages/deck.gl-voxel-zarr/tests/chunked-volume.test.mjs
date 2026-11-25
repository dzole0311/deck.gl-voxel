import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createChunkedVolume, projectGeographicVolume } from '../dist/index.js';

const fullView = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, -1, -1, -1, 1];

test('derived geographic heights publish progressively and reuse cached chunks for full-frame reads', async () => {
  const geometry = { dimensions: [4, 3, 2], origin: [-94, 31, 250], spacing: [1, -1, 500] };
  const pending = [];
  const progress = [];
  let disposals = 0;
  const reader = createChunkedVolume({
    geometry,
    chunkDimensions: [4, 3, 1],
    frameCount: 2,
    geographic: true,
    maxRequests: 1,
    readChunk: (index, [, , z], signal) =>
      new Promise((resolve) => {
        pending.push({
          index,
          z,
          signal,
          release: () => resolve(new Float32Array(12).fill(index * 10 + z + 1)),
        });
      }),
    dispose: () => {
      disposals++;
    },
  });
  const signal = new AbortController().signal;
  const reading = reader.readView(0, {
    volumeToClip: fullView,
    signal,
    onProgress: (volume) => progress.push(volume),
  });
  await setImmediate();
  assert.equal(pending.length, 1);
  pending[0].release();
  await setImmediate();
  assert.equal(pending.length, 2);
  assert.equal(progress.length, 1);
  assert.ok(progress[0].values.some(Number.isFinite));
  assert.ok(progress[0].values.some(Number.isNaN));
  const partial = progress[0].values.slice();
  pending[1].release();
  const complete = await reading;
  const expected = new Float32Array([
    ...new Float32Array(12).fill(1),
    ...new Float32Array(12).fill(2),
  ]);
  assert.deepEqual(
    complete,
    projectGeographicVolume(expected, geometry.dimensions, geometry.origin, geometry.spacing),
  );
  assert.deepEqual(progress[0].values, partial);
  assert.deepEqual(await reader.readFrame(0), complete);
  assert.equal(pending.length, 2, 'readFrame shares the view cache');
  const abort = new AbortController();
  const cancelled = assert.rejects(
    reader.readView(1, { volumeToClip: fullView, signal: abort.signal }),
    /cancelled/,
  );
  await setImmediate();
  abort.abort(new Error('cancelled'));
  await cancelled;
  assert.equal(pending[2].signal.aborted, true);
  pending[2].release();
  reader.dispose();
  reader.dispose();
  assert.equal(disposals, 1);
  await assert.rejects(reader.readFrame(0), /disposed/);
});

test('derived chunk shape errors reject the read and invalid geometry fails before loading', async () => {
  const source = {
    geometry: { dimensions: [2, 1, 1] },
    chunkDimensions: [2, 1, 1],
    frameCount: 1,
    readChunk: async () => new Float32Array(1),
  };
  const reader = createChunkedVolume(source);
  await assert.rejects(reader.readFrame(0), /chunkDimensions/);
  reader.dispose();
  assert.throws(
    () => createChunkedVolume({ ...source, geometry: { dimensions: [2_000_001, 1, 1] } }),
    /two million/,
  );
  assert.throws(() => createChunkedVolume({ ...source, frameCount: 0 }), /positive dimensions/);
});
