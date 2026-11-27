import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getCellMeshBounds,
  pickCellCollection,
  prepareCellMesh,
  VoxelLayer,
} from '../dist/index.js';

async function mesh(valid = true) {
  return prepareCellMesh(
    {
      dimensions: [2, 2, 2],
      origin: [10, 20, 110],
      spacing: [-2, -3, -5],
      values: new Float32Array(8).fill(0.3),
      valueDimensions: [2, 2, 2],
      valueScale: 1,
      validity: new Uint8Array(8).fill(valid ? 1 : 0),
      ground: new Float32Array(4).fill(100),
      elevationScales: new Float32Array([1, 2]),
    },
    1,
    [0, 1],
  );
}

const palette = new Uint8Array([255, 0, 0, 255]);

test('VoxelLayer cell bounds use common XYZ, negative axes and ground-relative height before device initialization', async () => {
  const source = await mesh();
  const ordinary = new VoxelLayer({
    renderMode: 'cells',
    id: 'ordinary-bounds',
    mesh: source,
    palette,
  });
  assert.deepEqual(ordinary.getBounds(), [
    [6, 14, 100],
    [10, 20, 220],
  ]);
  const exaggerated = new VoxelLayer({
    renderMode: 'cells',
    id: 'exaggerated-bounds',
    mesh: source,
    palette,
    exaggeration: 20,
  });
  assert.deepEqual(exaggerated.getBounds(), [
    [6, 14, 100],
    [10, 20, 600],
  ]);
  const clipped = new VoxelLayer({
    renderMode: 'cells',
    id: 'clipped-bounds',
    mesh: source,
    palette,
    exaggeration: 20,
    physicalClipBounds: [7, 15, 102, 9, 19, 108],
  });
  assert.deepEqual(clipped.getBounds(), [
    [7, 15, 140],
    [9, 19, 520],
  ]);
});

test('VoxelLayer cell bounds are null for no runs, removed cuboids or a zero-width physical slice', async () => {
  const empty = new VoxelLayer({
    renderMode: 'cells',
    id: 'empty-bounds',
    mesh: await mesh(false),
    palette,
  });
  assert.equal(empty.getBounds(), null);
  const source = await mesh();
  for (const clipBounds of [
    [11, 14, 100, 12, 20, 110],
    [6, 14, 105, 10, 20, 105],
    [8, 14, 100, 8, 20, 110],
  ]) {
    const clipped = new VoxelLayer({
      renderMode: 'cells',
      id: 'removed-bounds',
      mesh: source,
      palette,
      physicalClipBounds: clipBounds,
    });
    assert.equal(clipped.getBounds(), null);
  }
});

test('display bounds normalize both horizontal spacing signs in ordinary Cartesian grids', async () => {
  const mesh = await prepareCellMesh(
    {
      valueScale: 1,
      dimensions: [2, 2, 1],
      origin: [10, 20, 100],
      spacing: [-2, 3, 5],
      valueDimensions: [2, 2, 1],
      values: new Float32Array(4).fill(0.5),
      validity: new Uint8Array(4).fill(1),
      ground: new Float32Array(4),
      elevationScales: new Float32Array([1, 1]),
    },
    10,
    [0, 1],
  );
  const bounds = getCellMeshBounds(mesh, 1);
  assert.deepEqual(bounds, [6, 20, 100, 10, 26, 105]);
  const picked = pickCellCollection(
    [{ mesh, bounds }],
    { origin: [7, 24, 110], direction: [0, 0, -1] },
    1,
  );
  assert.ok(picked);
  assert.deepEqual(picked.hit.index, [1, 1, 0]);
});

test('clipped displayed bounds agree with physical cuts, negative axes and native chunk Z ranges', async () => {
  const mesh = await prepareCellMesh(
    {
      valueScale: 1,
      dimensions: [2, 2, 2],
      origin: [10, 20, 110],
      spacing: [-2, 3, -5],
      values: new Float32Array(8).fill(0.3),
      valueDimensions: [2, 2, 2],
      validity: new Uint8Array(8).fill(1),
      ground: new Float32Array(4).fill(100),
      elevationScales: new Float32Array([1, 2]),
    },
    10,
    [0, 1],
  );
  const clip = [7, 21, 102, 9, 25, 108];
  assert.deepEqual(getCellMeshBounds(mesh, 20, undefined, clip), [7, 21, 140, 9, 25, 520]);
  assert.deepEqual(getCellMeshBounds(mesh, 20, [0, 1], clip), [7, 21, 200, 9, 25, 520]);
  const empty = getCellMeshBounds(mesh, 20, undefined, [11, 20, 100, 12, 26, 110]);
  assert.deepEqual(empty, [10, 20, 0, 10, 20, 0]);
  const original = getCellMeshBounds(mesh, 20);
  assert.deepEqual(original, [6, 20, 100, 10, 26, 600]);
});
