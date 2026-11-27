import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellClipBoundsFromFractions } from '../dist/index.js';

test('normalized slicing fractions convert once to common XY and physical Z, including reversed axes', () => {
  const geometry = Object.freeze({
    dimensions: Object.freeze([4, 2, 10]),
    origin: Object.freeze([100, 200, -50]),
    spacing: Object.freeze([2, -3, 5]),
  });
  const fractions = Object.freeze([0.25, 0.25, 0.2, 0.75, 0.75, 0.6]);
  assert.deepEqual(
    cellClipBoundsFromFractions(geometry, fractions),
    [102, 195.5, -40, 106, 198.5, -20],
  );
  assert.deepEqual(
    cellClipBoundsFromFractions({ dimensions: [2, 4, 6] }, [0, 0, 0, 1, 1, 1]),
    [0, 0, 0, 2, 4, 6],
  );
  assert.deepEqual(
    cellClipBoundsFromFractions(geometry, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
    [104, 197, -25, 104, 197, -25],
  );
});

test('invalid normalized slicing input fails explicitly', () => {
  const geometry = { dimensions: [1, 1, 1] };
  for (const bounds of [
    [-0.1, 0, 0, 1, 1, 1],
    [0, 0, 0, 1.1, 1, 1],
    [0.7, 0, 0, 0.2, 1, 1],
    [0, 0, Number.NaN, 1, 1, 1],
  ]) {
    assert.throws(() => cellClipBoundsFromFractions(geometry, bounds), /Normalized clip bounds/);
  }
});

test('malformed fraction tuples and invalid slicing domains fail before producing NaN bounds', () => {
  for (const fractions of [[], [0, 0, 0], [0, 0, 0, 1, 1, 1, 1], null]) {
    assert.throws(
      () => cellClipBoundsFromFractions({ dimensions: [1, 1, 1] }, fractions),
      /Normalized clip bounds/,
    );
  }
  for (const geometry of [
    null,
    { dimensions: [1, 0, 1] },
    { dimensions: [1.5, 1, 1] },
    { dimensions: [1, 1] },
    { dimensions: [1, 1, 1], origin: [Number.NaN, 0, 0] },
    { dimensions: [1, 1, 1], origin: [0, 0] },
    { dimensions: [1, 1, 1], spacing: [0, 1, 1] },
    { dimensions: [1, 1, 1], spacing: [1, Number.POSITIVE_INFINITY, 1] },
  ]) {
    assert.throws(
      () => cellClipBoundsFromFractions(geometry, [0, 0, 0, 1, 1, 1]),
      /Cell slicing requires/,
    );
  }
  assert.throws(
    () =>
      cellClipBoundsFromFractions(
        { dimensions: [2, 1, 1], spacing: [Number.MAX_VALUE, 1, 1] },
        [0, 0, 0, 1, 1, 1],
      ),
    /remain finite/,
  );
});
