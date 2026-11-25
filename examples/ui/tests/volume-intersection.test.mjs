import assert from 'node:assert/strict';
import test from 'node:test';
import { Matrix4 } from '@math.gl/core';
import {
  classifyViewFace,
  getVisibleVolumeFaces,
  intersectVolumeRay,
} from '../dist/volume-intersection.js';

test('clips a partially visible volume and closes the cut with a face on the view boundary', () => {
  const clip = new Matrix4().scale([4, 2, 2]).translate([-0.25, -0.5, -0.5]);
  const faces = getVisibleVolumeFaces(clip);
  assert.equal(faces.length, 6);
  assert.ok(faces.some((face) => face.every((point) => Math.abs(point[0] - 0.5) < 1e-9)));
  for (const point of faces.flat()) {
    assert.ok(point[0] >= 0 && point[0] <= 0.5);
    assert.ok(point[1] >= 0 && point[1] <= 1);
    assert.ok(point[2] >= 0 && point[2] <= 1);
  }
});

test('handles a volume entirely in view, entirely outside and surrounding the whole frustum', () => {
  assert.equal(getVisibleVolumeFaces(new Matrix4()).length, 6);
  assert.deepEqual(getVisibleVolumeFaces(new Matrix4().translate([4, 0, 0])), []);
  const clip = new Matrix4().scale([4, 4, 4]).translate([-0.5, -0.5, -0.5]);
  const faces = getVisibleVolumeFaces(clip);
  assert.equal(faces.length, 6);
  assert.deepEqual([...new Set(faces.flat(2))].sort(), [0.25, 0.75]);
});

test('entry and exit follow finite rays, including near clipping and rays starting inside the volume', () => {
  assert.deepEqual(intersectVolumeRay([-1, 0.5, 0.5], [2, 0.5, 0.5]), [
    [0, 0.5, 0.5],
    [1, 0.5, 0.5],
  ]);
  assert.deepEqual(intersectVolumeRay([0.5, 0.5, 0.5], [0.5, 0.5, 2]), [
    [0.5, 0.5, 0.5],
    [0.5, 0.5, 1],
  ]);
  assert.equal(intersectVolumeRay([-1, 2, 0.5], [2, 2, 0.5]), undefined);
  assert.equal(intersectVolumeRay([-1, 0.5, 0.5], [-0.1, 0.5, 0.5]), undefined);
  assert.equal(intersectVolumeRay([NaN, 0, 0], [1, 1, 1]), undefined);
});

test('distinguishes entry, exit and parallel faces for perspective and orthographic views', () => {
  const faces = getVisibleVolumeFaces(new Matrix4());
  const top = faces.find((face) => face.every((point) => point[2] === 1));
  const bottom = faces.find((face) => face.every((point) => point[2] === 0));
  assert.ok(top && bottom);
  assert.equal(classifyViewFace(top, [0.5, 0.5, 2], [0, 0, 1]), 'entry');
  assert.equal(classifyViewFace(bottom, [0.5, 0.5, 2], [0, 0, 1]), 'exit');
  assert.equal(classifyViewFace(top, [0.5, 0.5, -1], [0, 0, -1]), 'exit');
  assert.equal(classifyViewFace(top, undefined, [0, 0, 1]), 'entry');
  assert.equal(classifyViewFace(bottom, undefined, [0, 0, 1]), 'exit');
  assert.equal(classifyViewFace(top, undefined, [1, 0, 0]), 'side');
  const clipped = getVisibleVolumeFaces(
    new Matrix4().scale([4, 4, 4]).translate([-0.5, -0.5, -0.5]),
  );
  assert.equal(
    clipped.filter((face) => classifyViewFace(face, [0.5, 0.5, 2], [0, 0, 1]) === 'entry').length,
    1,
  );
});

test('entry and exit remain classified when zoom makes the visible faces very small', () => {
  const clip = new Matrix4().scale([200000, 200000, 2]).translate([-0.5, -0.5, -0.5]);
  const faces = getVisibleVolumeFaces(clip);
  assert.equal(faces.length, 6);
  const crossings = faces.map((face) => classifyViewFace(face, undefined, [0, 0, 1]));
  assert.equal(crossings.filter((crossing) => crossing === 'entry').length, 1);
  assert.equal(crossings.filter((crossing) => crossing === 'exit').length, 1);
  assert.equal(crossings.filter((crossing) => crossing === 'side').length, 4);
});
