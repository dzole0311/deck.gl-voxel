import assert from 'node:assert/strict';
import test from 'node:test';

import { createProjectedGrid, projectFrame } from '../dist/readers/projected-grid.js';

test('preserves X-fastest cells and depth order when reversing north-first rows', () => {
  const level = { path: '0', affine: [1, 0, -1, 0, -1, 1], arrayWidth: 2, arrayHeight: 2 };
  const grid = createProjectedGrid(level, { count: 2, origin: 0, spacing: -10 });
  const frame = {
    data: new Float32Array([10, 20, 30, -999, 100, 200, 300, 400]),
    shape: [2, 2, 2],
    stride: [4, 2, 1],
  };
  const volume = projectFrame(frame, grid, -999);

  assert.deepEqual(volume.dimensions, [2, 2, 2]);
  assert.ok(volume.spacing[0] > 0 && volume.spacing[1] > 0 && volume.spacing[2] < 0);
  assert.deepEqual(
    [...volume.values].map((value) => (Number.isNaN(value) ? value : Math.round(value))),
    [30, NaN, 10, 20, 300, 400, 100, 200],
  );
});
