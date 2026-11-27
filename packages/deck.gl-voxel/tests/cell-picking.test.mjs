import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebMercatorViewport } from '@deck.gl/core';
import {
  displayElevation,
  getCellMeshBounds,
  getCellPickingRay,
  physicalElevation,
  pickCellCollection,
  pickCellMesh,
  prepareCellMesh,
} from '../dist/index.js';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

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

test('pointer rays use CSS pixels, flip Y and retain the near-to-far ray parameter', async () => {
  const viewport = { width: 200, height: 100, viewProjectionMatrix: identity };
  const ray = getCellPickingRay(viewport, [100, 50]);
  assert.deepEqual(ray, { origin: [0, 0, -1], direction: [0, 0, 2] });
  assert.deepEqual(getCellPickingRay(viewport, [0, 0]), {
    origin: [-1, 1, -1],
    direction: [0, 0, 2],
  });
  const mesh = await prepareCellMesh(
    {
      dimensions: [1, 1, 1],
      origin: [-0.5, -0.5, 0],
      spacing: [1, 1, 1],
      values: new Float32Array([0.5]),
      valueDimensions: [1, 1, 1],
      valueScale: 1,
      validity: new Uint8Array([1]),
      ground: new Float32Array([0]),
      elevationScales: new Float32Array([1]),
    },
    2,
    [0, 1],
  );
  const hit = pickCellMesh(mesh, ray, 1);
  assert.ok(hit);
  assert.equal(hit.distance, 0.5);
  assert.equal(hit.value, 0.5);
  assert.equal(hit.physicalZ, 0);
});

test('geographic camera rays intersect the datum at the map center', () => {
  const longitude = -119.55;
  const latitude = 36.5;
  const viewport = new WebMercatorViewport({
    width: 1400,
    height: 1000,
    longitude,
    latitude,
    zoom: 10.8,
    pitch: 62,
    bearing: -25,
  });
  const ray = getCellPickingRay(viewport, [700, 500]);
  assert.ok(ray);
  const t = -ray.origin[2] / ray.direction[2];
  const x = ray.origin[0] + t * ray.direction[0];
  const y = ray.origin[1] + t * ray.direction[1];
  const latitudeRadians = (latitude * Math.PI) / 180;
  assert.ok(Math.abs(x - ((longitude + 180) / 360) * 512) < 1e-8);
  assert.ok(
    Math.abs(
      y - ((Math.PI + Math.log(Math.tan(Math.PI / 4 + latitudeRadians / 2))) / (2 * Math.PI)) * 512,
    ) < 1e-8,
  );
});

test('empty viewports and nonfinite pointer coordinates have no picking ray', () => {
  const viewport = { width: 200, height: 100, viewProjectionMatrix: identity };
  assert.equal(getCellPickingRay({ ...viewport, width: 0 }, [0, 0]), undefined);
  assert.equal(getCellPickingRay({ ...viewport, height: 0 }, [0, 0]), undefined);
  assert.equal(getCellPickingRay(viewport, [NaN, 0]), undefined);
  assert.equal(getCellPickingRay(viewport, [0, Infinity]), undefined);
});

test('ground stays fixed at 20x and physical tooltips invert the display transform', () => {
  assert.equal(displayElevation(1000, 1000, 20), 1000);
  assert.equal(displayElevation(980, 1000, 20), 600);
  assert.equal(physicalElevation(600, 1000, 20), 980);
  assert.equal(displayElevation(-50, -10, 20), -810);
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

test('collection picking ignores off-ray chunk bounds', async () => {
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
});

test('collection clipping picks the kept native cell at an exact slice boundary and preserves ties', async () => {
  const mesh = await prepareCellMesh(grid(), 10, [0, 1]);
  const other = await prepareCellMesh(
    grid({ values: new Float32Array([0.17, 0.18, 0.8, 0.8]) }),
    10,
    [0, 1],
  );
  const first = { id: 'first', mesh, bounds: getCellMeshBounds(mesh, 20) };
  const second = { id: 'second', mesh: other, bounds: getCellMeshBounds(other, 20) };
  const ray = { origin: [0.5, -0.5, 1100], direction: [0, 0, -1] };
  const clip = [-1, -2, 980, 2, 1, 985];
  const hit = pickCellCollection([first, second], ray, 20, 1023, clip);
  assert.ok(hit);
  assert.equal(hit.item.id, 'first');
  assert.equal(hit.hit.physicalZ, 985);
  assert.deepEqual(hit.hit.index, [0, 0, 0]);
  assert.equal(hit.hit.value, Math.fround(0.11));
  const reversed = pickCellCollection([second, first], ray, 20, 1023, clip);
  assert.equal(reversed.item.id, 'second');
  assert.equal(reversed.hit.value, Math.fround(0.17));
  assert.equal(pickCellCollection([first], ray, 20, 1023, [2, -2, 980, 3, 1, 985]), undefined);
  const lower = pickCellMesh(
    mesh,
    { origin: [0.5, -0.5, 550], direction: [0, 0, 1] },
    20,
    1023,
    [-1, -2, 985, 2, 1, 990],
  );
  assert.ok(lower);
  assert.equal(lower.physicalZ, 985);
  assert.deepEqual(lower.index, [0, 0, 1]);
  assert.equal(lower.value, Math.fround(0.12));
});

test('a reversed vertical axis still resolves the retained side of a native slice boundary', async () => {
  const mesh = await prepareCellMesh(
    grid({ origin: [0, 0, 1000], spacing: [1, -1, -5] }),
    10,
    [0, 1],
  );
  const hit = pickCellMesh(
    mesh,
    { origin: [0.5, -0.5, 600], direction: [0, 0, 1] },
    20,
    1023,
    [-1, -2, 995, 2, 1, 1000],
  );
  assert.ok(hit);
  assert.equal(hit.physicalZ, 995);
  assert.deepEqual(hit.index, [0, 0, 0]);
  assert.equal(hit.value, Math.fround(0.11));
  const exit = pickCellMesh(
    mesh,
    { origin: [0.5, -0.5, 950], direction: [0, 0, -1] },
    20,
    1023,
    [-1, -2, 995, 2, 1, 1000],
  );
  assert.equal(exit.physicalZ, 995);
  assert.deepEqual(exit.index, [0, 0, 0]);
  assert.equal(exit.value, Math.fround(0.11));
});

test('picking reports the visible exit when the ray origin is inside a box', async () => {
  const mesh = await prepareCellMesh(grid(), 10, [0, 1]);
  const ray = { origin: [0.5, -0.5, 950], direction: [0, 0, -1] };
  const exit = pickCellMesh(mesh, ray, 20, 1 << 8);
  assert.equal(exit.distance, 150);
  assert.equal(exit.physicalZ, 990);
  assert.deepEqual(exit.index, [0, 0, 2]);
  assert.equal(exit.value, Math.fround(0.8));
  const tied = pickCellMesh(mesh, ray, 20, 1023);
  assert.equal(tied.value, Math.fround(0.12), 'the first run wins coplanar entry/exit faces');
  const forward = pickCellMesh(mesh, { ...ray, direction: [0, 0, 1] }, 20, 1023);
  assert.equal(forward.physicalZ, 1000);
  assert.equal(forward.value, Math.fround(0.8));
  const clippedExit = pickCellMesh(
    mesh,
    { origin: [0.5, -0.5, 750], direction: [0, 0, 1] },
    20,
    1023,
    [-1, -2, 985, 2, 1, 990],
  );
  assert.equal(clippedExit.physicalZ, 990);
  assert.deepEqual(clippedExit.index, [0, 0, 1]);
  assert.equal(clippedExit.value, Math.fround(0.12));
  const exterior = { origin: [0.5, -0.5, 1100], direction: [0, 0, -1] };
  assert.equal(pickCellMesh(mesh, exterior, 20, 1023).physicalZ, 1000);
  const other = await prepareCellMesh(
    grid({ origin: [0, 0, 995], values: new Float32Array([0.4, 0.4, 0.4, 0.4]) }),
    10,
    [0, 1],
  );
  const first = { id: 'deeper-exit', mesh, bounds: getCellMeshBounds(mesh, 20) };
  const second = { id: 'nearer-exit', mesh: other, bounds: getCellMeshBounds(other, 20) };
  const hit = pickCellCollection([first, second], ray, 20, 1023);
  assert.equal(hit.item.id, 'nearer-exit');
  assert.equal(hit.hit.physicalZ, 995);
  assert.equal(hit.hit.value, Math.fround(0.4));
});
