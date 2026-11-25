import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cellValue,
  displayElevation,
  physicalElevation,
  pickCellMesh,
  prepareCellMesh,
} from '../dist/index.js';

function grid(overrides = {}) {
  return {
    dimensions: [1, 1, 4],
    origin: [0, 0, 980],
    spacing: [1, -1, 5],
    values: new Float32Array([0.11, 0.12, 0.8, 0.8]),
    valueDimensions: [1, 1, 4],
    valueScale: 1,
    validity: new Uint8Array([1, 1, 1, 1]),
    ground: new Float32Array([1000]),
    elevationScales: new Float32Array([1]),
    ...overrides,
  };
}

test('ground stays fixed at 20x and physical tooltips invert the display transform', () => {
  assert.equal(displayElevation(1000, 1000, 20), 1000);
  assert.equal(displayElevation(980, 1000, 20), 600);
  assert.equal(physicalElevation(600, 1000, 20), 980);
  assert.equal(displayElevation(-50, -10, 20), -810);
});

test('runs merge identical display bins while preserving exact samples and native gaps', async () => {
  const mesh = await prepareCellMesh(grid(), 10, [0, 1]);
  assert.equal(mesh.count, 2);
  assert.deepEqual([...mesh.instances.slice(2, 4)], [980, 990]);
  assert.equal(cellValue(mesh.grid, 0, 0, 1), Math.fround(0.12));
  const missing = await prepareCellMesh(
    grid({ validity: new Uint8Array([1, 0, 1, 1]) }),
    10,
    [0, 1],
  );
  assert.equal(missing.count, 2);
  assert.deepEqual([...missing.instances.slice(2, 4)], [980, 985]);
  assert.ok(Number.isNaN(cellValue(missing.grid, 0, 0, 1)));
});

test('stored overview means never fill native gaps, including category zero', async () => {
  const g = grid({
    dimensions: [2, 1, 1],
    origin: [0, 0, 0],
    values: new Float32Array([0]),
    valueDimensions: [1, 1, 1],
    valueScale: 2,
    validity: new Uint8Array([1, 0]),
    ground: new Float32Array([0, 0]),
  });
  const mesh = await prepareCellMesh(g, 10, [0, 1]);
  assert.equal(mesh.count, 1);
  assert.equal(cellValue(mesh.grid, 0, 0, 0), 0);
  assert.ok(Number.isNaN(cellValue(mesh.grid, 1, 0, 0)));
});

test('picking uses ground-relative placement, filtered categories, cut bounds and exact native values', async () => {
  const mesh = await prepareCellMesh(grid(), 10, [0, 1]);
  const ray = { origin: [0.5, -0.5, 1100], direction: [0, 0, -1] };
  const top = pickCellMesh(mesh, ray, 20);
  assert.ok(top);
  assert.equal(top.groundZ, 1000);
  assert.equal(top.physicalZ, 1000);
  assert.equal(top.value, Math.fround(0.8));
  const filtered = pickCellMesh(mesh, ray, 20, 1 << 1);
  assert.ok(filtered);
  assert.equal(filtered.physicalZ, 990);
  assert.equal(filtered.value, Math.fround(0.12));
  const cut = pickCellMesh(mesh, ray, 20, 1023, [-1, -2, 981, 2, 1, 987]);
  assert.ok(cut);
  assert.equal(cut.physicalZ, 987);
  assert.equal(cut.value, Math.fround(0.12));
  assert.equal(pickCellMesh(mesh, ray, 20, 0), undefined);
});

test('sparse retained values preserve lookup and account for all retained typed arrays', async () => {
  const values = new Float32Array(128).fill(NaN);
  values[90] = 0.35;
  const validity = new Uint8Array(16);
  validity[90 >> 3] = 1 << (90 & 7);
  const mesh = await prepareCellMesh(
    grid({
      dimensions: [128, 1, 1],
      values,
      valueDimensions: [128, 1, 1],
      ground: new Float32Array(128),
      validity,
      validityBits: true,
    }),
    10,
    [0, 1],
  );
  assert.equal(mesh.count, 1);
  assert.equal(mesh.grid.values.length, 1);
  assert.equal(cellValue(mesh.grid, 90, 0, 0), Math.fround(0.35));
  assert.equal(
    mesh.bytes,
    mesh.instances.byteLength +
      mesh.grid.values.byteLength +
      mesh.grid.valueIndices.byteLength +
      mesh.grid.validity.byteLength +
      mesh.grid.ground.byteLength +
      mesh.grid.elevationScales.byteLength,
  );
});

test('collection picking skips outside bounds and respects the nearest displayed chunk', async () => {
  const { pickCellCollection } = await import('../dist/index.js');
  const mesh = await prepareCellMesh(grid(), 10, [0, 1]);
  const first = { id: 'front', mesh, bounds: [0, -1, 600, 1, 0, 1000] };
  const second = { id: 'outside', mesh, bounds: [10, -1, 600, 11, 0, 1000] };
  const hit = pickCellCollection(
    [second, first],
    { origin: [0.5, -0.5, 1100], direction: [0, 0, -1] },
    20,
  );
  assert.equal(hit.item.id, 'front');
  assert.equal(hit.hit.value, Math.fround(0.8));
  const repeated = await prepareCellMesh(mesh.grid, 10, [0, 1]);
  assert.equal(repeated.count, mesh.count);
});

test('display bounds normalize both horizontal spacing signs in ordinary Cartesian grids', async () => {
  const { getCellMeshBounds, pickCellCollection } = await import('../dist/index.js');
  const mesh = await prepareCellMesh(
    grid({
      dimensions: [2, 2, 1],
      origin: [10, 20, 100],
      spacing: [-2, 3, 5],
      valueDimensions: [2, 2, 1],
      values: new Float32Array(4).fill(0.5),
      validity: new Uint8Array(4).fill(1),
      ground: new Float32Array(4),
      elevationScales: new Float32Array([1, 1]),
    }),
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
