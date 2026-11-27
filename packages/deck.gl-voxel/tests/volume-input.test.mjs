import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packVolume, validateStyle, validateVolume } from '../dist/rendering/volume-input.js';

const grid = {
  values: new Float32Array([1, Number.NaN, -9999, Infinity]),
  dimensions: [2, 1, 2],
  noDataValue: -9999,
};

test('missing samples retain zero validity rather than a scalar sentinel', () => {
  assert.deepEqual([...packVolume(grid)], [1, 1, 0, 0, 0, 0, 0, 0]);
});

test('allocation is rejected before packing an excessive or malformed volume', () => {
  assert.throws(() => validateVolume(grid, 1, 1024, 8), /dimensions/);
  assert.throws(() => validateVolume(grid, 2048, 16, 8), /require 44 bytes/);
  assert.throws(() => validateVolume({ ...grid, dimensions: [2, 2, 2] }, 2048, 1024, 8), /length/);
  assert.throws(() => validateVolume({ ...grid, spacing: [1, 0, 1] }, 2048, 1024, 8), /spacing/);
  assert.doesNotThrow(() => validateVolume({ ...grid, spacing: [-1, 2, 3] }, 2048, 1024, 8));
});

test('invalid sampling and transfer-function inputs fail explicitly', () => {
  assert.throws(() => validateStyle({ stepSize: 0 }), /stepSize/);
  assert.throws(() => validateStyle({ maxSteps: 5000 }), /maxSteps/);
  assert.throws(() => validateStyle({ colorBy: 'altitude' }), /colorBy/);
  assert.throws(() => validateStyle({ renderMode: 'raycasting' }), /renderMode/);
  assert.throws(() => validateStyle({ isovalue: Number.NaN }), /isovalue/);
  assert.throws(() => validateStyle({ valueRange: [1, 1] }), /valueRange/);
  assert.throws(() => validateStyle({ transferFunction: new Uint8Array(7) }), /RGBA8/);
  assert.throws(() => validateStyle({ clipBounds: [0.8, 0, 0, 0.2, 1, 1] }), /clipBounds/);
});
