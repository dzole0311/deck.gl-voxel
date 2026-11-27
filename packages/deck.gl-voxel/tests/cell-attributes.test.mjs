import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellValue, prepareCellMesh } from '../dist/index.js';
import { prepareCellAttributes } from '../dist/rendering/cell-attributes.js';

function grid(overrides = {}) {
  return {
    dimensions: [1, 1, 4],
    origin: [85, 312, 980],
    spacing: [0.003, -0.004, 5],
    values: new Float32Array([0.11, 0.12, 0.8, 0.8]),
    valueDimensions: [1, 1, 4],
    valueScale: 1,
    validity: new Uint8Array([1, 1, 1, 1]),
    ground: new Float32Array([1000]),
    elevationScales: new Float32Array([0.0015]),
    ...overrides,
  };
}

function near(actual, expected, tolerance = 1e-7) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index++) {
    assert.ok(
      Math.abs(actual[index] - expected[index]) < tolerance,
      `${actual[index]} != ${expected[index]} at ${index}`,
    );
  }
}

function centers(geometry) {
  const result = [];
  for (let index = 0; index < geometry.count; index++) {
    const offset = index * 3;
    result.push(
      geometry.positions[offset + 2],
      geometry.positions[offset + 1],
      geometry.positions[offset],
    );
  }
  return result;
}

function sizes(geometry) {
  const result = [];
  for (let index = 0; index < geometry.count; index++) {
    const offset = index * geometry.scaleSize;
    result.push(
      geometry.scaleSize === 1 ? geometry.footprint[0] : geometry.scales[offset + 5],
      geometry.scaleSize === 1 ? geometry.footprint[1] : geometry.scales[offset + 2],
      geometry.scales[offset],
    );
  }
  return result;
}

test('stock cuboids preserve merged runs, native values and ground-relative common coordinates', async () => {
  const mesh = await prepareCellMesh(grid(), 10, [0, 1]);
  const instances = mesh.instances.slice(),
    values = mesh.grid.values.slice();
  const geometry = prepareCellAttributes(mesh, 20);
  assert.equal(geometry.count, mesh.count);
  near(centers(geometry), [85.0015, 311.998, 1.05, 85.0015, 311.998, 1.35]);
  near(sizes(geometry), [0.003, 0.004, 0.3, 0.003, 0.004, 0.3]);
  assert.equal(geometry.scaleSize, 1);
  assert.equal(geometry.scales.length, geometry.count);
  assert.deepEqual([...geometry.runIndices], [0, 1]);
  near([centers(geometry)[5] + sizes(geometry)[5] / 2], [1000 * mesh.grid.elevationScales[0]]);
  assert.equal(
    geometry.bytes,
    geometry.positions.byteLength + geometry.scales.byteLength + geometry.runIndices.byteLength,
  );
  assert.equal(geometry.bytes, geometry.count * 32);
  assert.deepEqual(mesh.instances, instances);
  assert.deepEqual(mesh.grid.values, values);
  assert.equal(cellValue(mesh.grid, 0, 0, 1), Math.fround(0.12));
});

test('partial XYZ cuts normalize negative spacing before applying per-row elevation scales', async () => {
  const mesh = await prepareCellMesh(
    grid({
      dimensions: [2, 2, 2],
      origin: [10, 20, 110],
      spacing: [-2, 3, -5],
      values: new Float32Array(8).fill(0.3),
      valueDimensions: [2, 2, 2],
      validity: new Uint8Array(8).fill(1),
      ground: new Float32Array(4).fill(100),
      elevationScales: new Float32Array([0.01, 0.02]),
    }),
    10,
    [0, 1],
  );
  const geometry = prepareCellAttributes(mesh, 20, 1023, [7, 21, 102, 9, 25, 108]);
  assert.equal(geometry.count, 4);
  assert.equal(geometry.scaleSize, 6);
  assert.equal(geometry.bytes, geometry.count * 52);
  near(centers(geometry), [8.5, 22, 2, 7.5, 22, 2, 8.5, 24, 4, 7.5, 24, 4], 2e-7);
  near(sizes(geometry), [1, 2, 1.2, 1, 2, 1.2, 1, 2, 2.4, 1, 2, 2.4], 2e-7);
  assert.deepEqual([...geometry.runIndices], [0, 1, 2, 3]);
  assert.equal(prepareCellAttributes(mesh, 20, 1023, [10, 20, 100, 11, 26, 110]).count, 0);
});

test('stock adaptation retains native holes and valid zero while filtering whole runs', async () => {
  const mesh = await prepareCellMesh(
    grid({
      dimensions: [1, 1, 5],
      origin: [0, 0, 0],
      spacing: [1, -1, 1],
      values: new Float32Array([0, NaN, 0.12, 0.13, 0.8]),
      valueDimensions: [1, 1, 5],
      validity: new Uint8Array([1, 0, 1, 1, 1]),
      ground: new Float32Array([0]),
      elevationScales: new Float32Array([1]),
    }),
    10,
    [0, 1],
  );
  const geometry = prepareCellAttributes(mesh, 1, 3, [
    -Infinity,
    -Infinity,
    0,
    Infinity,
    Infinity,
    3.5,
  ]);
  assert.equal(geometry.count, 2);
  near(centers(geometry), [0.5, -0.5, 0.5, 0.5, -0.5, 2.75]);
  near(sizes(geometry), [1, 1, 1, 1, 1, 1.5]);
  assert.deepEqual(
    [...geometry.runIndices].map((run) => mesh.instances[run * 8 + 5]),
    [0, 1],
  );
  assert.deepEqual([...geometry.runIndices], [0, 1]);
  assert.ok(
    centers(geometry)[2] + sizes(geometry)[2] / 2 < centers(geometry)[5] - sizes(geometry)[5] / 2,
    'no cuboid bridges the missing native interval',
  );
  assert.equal(prepareCellAttributes(mesh, 1, 1 << 8, [-1, -2, 0, 2, 1, 3.5]).count, 0);
  assert.ok(Number.isNaN(cellValue(mesh.grid, 0, 0, 1)));
  assert.equal(cellValue(mesh.grid, 0, 0, 0), 0);
});

test('empty cuts allocate no adapter payload and invalid physical bounds fail explicitly', async () => {
  const mesh = await prepareCellMesh(grid(), 10, [0, 1]);
  const empty = prepareCellAttributes(mesh, 20, 1023, [0, 0, 985, 100, 400, 985]);
  assert.equal(empty.count, 0);
  assert.equal(empty.bytes, 0);
  assert.equal(empty.positions.length, 0);
  assert.equal(prepareCellAttributes(mesh, 20, 0).count, 0);
  const unbounded = prepareCellAttributes(mesh, 20, 1023, [
    -Infinity,
    -Infinity,
    -Infinity,
    Infinity,
    Infinity,
    Infinity,
  ]);
  assert.deepEqual(unbounded.positions, prepareCellAttributes(mesh, 20).positions);
  assert.throws(() => prepareCellAttributes(mesh, 0), /positive exaggeration/);
  assert.throws(() => prepareCellAttributes(mesh, 20, 1023, [1, 0, 0, 0, 1, 1]), /ordered/);
  assert.throws(() => prepareCellAttributes(mesh, 20, 1023, [0, 0, NaN, 1, 1, 1]), /ordered/);
});

test('explicit local float32 preparation removes redundant precision storage without changing native runs', async () => {
  const source = grid({
    origin: [0.30037123, 0.30082317, 90],
    spacing: [0.003194, -0.003194, 5],
    ground: new Float32Array([100]),
    elevationScales: new Float32Array([0.000015966449]),
  });
  const mesh = await prepareCellMesh(source, 10, [0, 1]);
  const precise = prepareCellAttributes(mesh, 20);
  const compact = prepareCellAttributes(mesh, 20, 0xffffffff, undefined, 'float32');
  assert.ok(precise.positions instanceof Float64Array);
  assert.ok(compact.positions instanceof Float32Array);
  assert.deepEqual(compact.runIndices, precise.runIndices);
  assert.deepEqual(compact.scales, precise.scales);
  near(compact.positions, precise.positions, 2e-8);
  assert.equal(compact.bytes, compact.count * 20);
  assert.equal(precise.bytes - compact.bytes, compact.count * 12);
  assert.deepEqual(source.origin, [0.30037123, 0.30082317, 90]);
});
