import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellValue, prepareCellMesh } from '../dist/index.js';

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

test('preparing an already sparse grid preserves its native index mapping and input arrays', async () => {
  const g = grid({
    dimensions: [4, 1, 1],
    origin: [0, 0, 0],
    spacing: [1, -1, 5],
    values: new Float32Array([0, 0.75]),
    valueIndices: new Uint32Array([1, 3]),
    valueDimensions: [4, 1, 1],
    validity: new Uint8Array([0, 1, 0, 1]),
    ground: new Float32Array(4),
  });
  const mesh = await prepareCellMesh(g, 10, [0, 1]);
  assert.equal(mesh.grid, g);
  assert.equal(mesh.grid.values, g.values);
  assert.equal(mesh.grid.valueIndices, g.valueIndices);
  assert.equal(cellValue(mesh.grid, 1, 0, 0), 0);
  assert.equal(cellValue(mesh.grid, 3, 0, 0), 0.75);
  assert.ok(Number.isNaN(cellValue(mesh.grid, 2, 0, 0)));
  assert.equal(mesh.count, 2);
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
