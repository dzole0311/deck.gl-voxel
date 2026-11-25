import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createChunkedVolume, DEFAULT_MAX_CELLS, projectGeographicVolume } from '../dist/index.js';
import { BACKGROUND_PRIORITY } from '../dist/request-priority.js';

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
    /maxCells/,
  );
  assert.throws(() => createChunkedVolume({ ...source, frameCount: 0 }), /positive dimensions/);
});

test('frame and preload reads preserve camera diagnostics; an assembled view survives decoded-cache eviction', async () => {
  let reads = 0;
  const reader = createChunkedVolume({
    geometry: { dimensions: [8, 1, 1] },
    chunkDimensions: [2, 1, 1],
    frameCount: 2,
    maxCacheBytes: 1,
    readChunk: async (frame) => {
      reads++;
      return new Float32Array(2).fill(frame + 1);
    },
  });
  await reader.readFrame(0);
  assert.equal(reader.getDebugState(), undefined, 'Whole-frame reads have no camera selection');
  const camera = [8, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, -1, -1, -1, 1];
  const query = { volumeToClip: camera, signal: new AbortController().signal };
  await reader.readView(0, query);
  await reader.readView(1, { ...query, volumeToClip: fullView, priority: BACKGROUND_PRIORITY });
  await reader.readFrame(1);
  assert.equal(reader.getDebugState().frameIndex, 0);
  assert.deepEqual(reader.getDebugState().volumeToClip, camera);
  const volume = await reader.readView(0, query);
  const before = reads;
  assert.equal(await reader.readView(0, query), volume);
  assert.equal(reads, before);
  const debug = reader.getDebugState();
  assert.equal(debug.cacheBytes, 0);
  assert.equal(debug.reusedView, true);
  assert.ok(
    debug.chunks.filter((chunk) => chunk.selected).every((chunk) => chunk.status === 'ready'),
  );
  reader.dispose();
});

test('custom cell limits validate grids and padded chunks before reading', async () => {
  let reads = 0;
  const source = {
    geometry: { dimensions: [4, 1, 1] },
    chunkDimensions: [2, 1, 1],
    frameCount: 1,
    readChunk: async () => {
      reads++;
      return new Float32Array([1, 2]);
    },
  };
  for (const maxCells of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => createChunkedVolume({ ...source, maxCells }), /positive safe integer/);
  }
  assert.throws(() => createChunkedVolume({ ...source, maxCells: 3 }), /maxCells/);
  assert.throws(
    () => createChunkedVolume({ ...source, chunkDimensions: [5, 1, 1], maxCells: 4 }),
    /maxCells/,
  );
  assert.equal(reads, 0);
  const reader = createChunkedVolume({ ...source, maxCells: 4 });
  assert.deepEqual((await reader.readFrame(0)).values, new Float32Array([1, 2, 1, 2]));
  reader.dispose();
  const large = createChunkedVolume({
    ...source,
    geometry: { dimensions: [DEFAULT_MAX_CELLS + 1, 1, 1] },
    chunkDimensions: [DEFAULT_MAX_CELLS + 1, 1, 1],
    maxCells: DEFAULT_MAX_CELLS + 1,
  });
  large.dispose();
});
