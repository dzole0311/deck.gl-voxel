import assert from 'node:assert/strict';
import test from 'node:test';
import { WebMercatorViewport } from '@deck.gl/core';
import { Matrix4 } from '@math.gl/core';
import { getVoxelVolumeToCommon } from 'deck.gl-voxel';
import { getCameraOverviewGeometry, projectOverviewPoint } from '../dist/camera-geometry.js';

const placement = new Matrix4().translate([120, 280, 0]).scale([20, 10, 2]);
const center = [130, 285, 1];
const camera = [130, 270, 20];

function scene(
  eye = camera,
  projection = new Matrix4().perspective({ fovy: Math.PI / 3, aspect: 1.5, near: 0.1, far: 100 }),
) {
  return getCameraOverviewGeometry(
    projection
      .multiplyRight(new Matrix4().lookAt({ eye, center, up: [0, 0, 1] }))
      .multiplyRight(placement),
    placement,
  );
}

test('reconstructs the camera and preserves displayed volume proportions', () => {
  const geometry = scene();
  assert.ok(geometry?.eye);
  const expected = [0, -0.75, 0.95];
  geometry.eye.forEach((value, index) => {
    assert.ok(Math.abs(value - expected[index]) < 1e-9);
  });
  assert.deepEqual(geometry.toOverview([1, 1, 1]), [0.5, 0.25, 0.05]);
  assert.equal(geometry.volume.length, 8);
  assert.ok(geometry.rays.length > 0);
  assert.ok(geometry.footprint.length >= 3);
  for (const point of geometry.footprint) {
    assert.ok(Math.abs(point[2] + 0.05) < 1e-9);
  }
});

test('ray intersections stay inside the volume and in front of a camera near the horizon', () => {
  const eye = [130, 250, 1.1];
  const geometry = scene(eye);
  assert.ok(geometry?.eye);
  assert.ok(geometry.footprint.length >= 3);
  const direction = center.map((value, index) => value - eye[index]);
  const forwardDepth = (point) =>
    point.reduce((sum, value, index) => sum + (value - geometry.eye[index]) * direction[index], 0) /
    Math.hypot(...direction);
  const volumeDepth = Math.max(...geometry.volume.map(forwardDepth));
  for (const point of geometry.rays.flatMap((ray) => [ray.entry, ray.exit])) {
    assert.ok(point.every(Number.isFinite));
    const depth = forwardDepth(point);
    assert.ok(
      depth >= 0 && depth <= volumeDepth + 1e-9,
      'Display rays must stop at the volume instead of the far clip plane',
    );
  }
});

test('supports orthographic cameras without inventing a perspective eye', () => {
  const projection = new Matrix4().ortho({
    left: -20,
    right: 20,
    bottom: -10,
    top: 10,
    near: 0.1,
    far: 100,
  });
  const geometry = scene(camera, projection);
  assert.ok(geometry);
  assert.equal(geometry.eye, undefined);
  assert.ok(geometry.rays.length > 0);
  for (const ray of geometry.rays) {
    const delta = ray.exit.map((value, axis) => value - ray.start[axis]);
    const length = Math.hypot(...delta);
    delta.forEach((value, axis) => {
      assert.ok(Math.abs(value / length - geometry.direction[axis]) < 1e-9);
    });
  }
});

test('rejects malformed and singular transforms without throwing or producing invalid geometry', () => {
  for (const matrix of [[], Array(16).fill(0), new Matrix4().fill(NaN)]) {
    assert.equal(getCameraOverviewGeometry(matrix, placement), undefined);
  }
  assert.equal(getCameraOverviewGeometry(new Matrix4(), Array(16).fill(0)), undefined);
});

test('the external inset looks down at a right-handed scene and keeps height pointing up', () => {
  const origin = projectOverviewPoint([0, 0, 0], '3d');
  const x = projectOverviewPoint([1, 0, 0], '3d').map((value, index) => value - origin[index]);
  const y = projectOverviewPoint([0, 1, 0], '3d').map((value, index) => value - origin[index]);
  const z = projectOverviewPoint([0, 0, 1], '3d').map((value, index) => value - origin[index]);
  assert.ok(
    x[0] * y[1] - x[1] * y[0] < 0,
    'A Z-up ground face seen from above winds clockwise in canvas coordinates',
  );
  assert.ok(z[1] < 0, 'Increasing height must move upward on the inset');
  assert.deepEqual(projectOverviewPoint([0, 1, 0], '2d'), [0, -1]);
});

test('camera position and view ray corners match deck.gl across pitch, bearing, zoom and display stretch', () => {
  const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  for (const pitch of [0, 30, 60, 85]) {
    for (const bearing of [0, 90, 180, 270]) {
      for (const zoom of [3.5, 6.2, 12]) {
        for (const stretch of [1, 50]) {
          const viewport = new WebMercatorViewport({
            width: 1440,
            height: 1000,
            longitude: -86,
            latitude: 27,
            pitch,
            bearing,
            zoom,
          });
          const placement = getVoxelVolumeToCommon(
            {
              volume: {
                dimensions: [64, 64, 16],
                origin: [120, 280, 0],
                spacing: [0.4, 0.4, 0.007],
              },
              modelMatrix: new Matrix4().scale([1, 1, stretch]),
            },
            viewport,
          );
          const clip = new Matrix4(viewport.viewProjectionMatrix).multiplyRight(placement);
          const geometry = getCameraOverviewGeometry(clip, placement);
          assert.ok(geometry?.eye);
          const center = placement.transformAsPoint([0.5, 0.5, 0.5]);
          const scale = 64 * 0.4;
          viewport.cameraPosition.forEach((value, axis) => {
            assert.ok(
              Math.abs(geometry.eye[axis] - (value - center[axis]) / scale) < 1e-8,
              `Camera differs at pitch ${pitch}, bearing ${bearing}, zoom ${zoom}`,
            );
          });
          const expectedDirection = new Matrix4(viewport.viewMatrixInverse).transformAsVector([
            0, 0, -1,
          ]);
          const directionLength = Math.hypot(...expectedDirection);
          expectedDirection.forEach((value, axis) => {
            assert.ok(Math.abs(value / directionLength - geometry.direction[axis]) < 1e-8);
          });
          for (const ray of geometry.rays) {
            const projected = [ray.start, ray.entry, ray.exit].map((point) => {
              const common = point.map((value, axis) => value * scale + center[axis]);
              return new Matrix4(viewport.viewProjectionMatrix).transformAsPoint(common);
            });
            const start = projected[0];
            assert.ok(Math.abs(start[2] + 1) < 1e-7);
            assert.ok(
              [[0, 0], ...corners].some(
                ([x, y]) => Math.abs(start[0] - x) < 1e-7 && Math.abs(start[1] - y) < 1e-7,
              ),
            );
            for (const point of projected.slice(1)) {
              assert.ok(Math.abs(point[0] - start[0]) < 1e-7);
              assert.ok(Math.abs(point[1] - start[1]) < 1e-7);
              assert.ok(point[2] >= -1 - 1e-7 && point[2] <= 1 + 1e-7);
            }
          }
          const toVolume = placement.clone().invert();
          for (const point of geometry.visibleFaces.flat()) {
            const common = point.map((value, axis) => value * scale + center[axis]);
            const volume = toVolume.transformAsPoint(common);
            const ndc = new Matrix4(viewport.viewProjectionMatrix).transformAsPoint(common);
            assert.ok(volume.every((value) => value >= -1e-8 && value <= 1 + 1e-8));
            assert.ok(ndc.every((value) => value >= -1 - 1e-7 && value <= 1 + 1e-7));
          }
        }
      }
    }
  }
});
