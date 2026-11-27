import type { Vector3 } from '../types.js';

/**
 * A grid with X changing fastest, then Y, then Z in each flat array.
 * XY uses deck.gl common coordinates. Z and ground use physical meters, before height stretching.
 * The origin is the outside corner of the first cell; spacing may be negative.
 */
export interface CellGrid {
  readonly dimensions: Vector3;
  readonly origin: Vector3;
  readonly spacing: Vector3;
  /** Values may be a stored XY overview. Z is never resampled. */
  readonly values: Float32Array;
  /** Sorted dense indices when retained values have been compacted. */
  readonly valueIndices?: Uint32Array;
  readonly valueDimensions: Vector3;
  readonly valueScale: number;
  readonly validity: Uint8Array;
  readonly validityBits?: boolean;
  readonly ground: Float32Array;
  /** Common-space units per physical meter for each native row. */
  readonly elevationScales: Float32Array;
}

/** Looks up an overview value only where the native cell is measured. */
export function cellValue(grid: CellGrid, x: number, y: number, z: number): number {
  const [w, h, d] = grid.dimensions;
  const index = x + w * (y + h * z);
  const valid = grid.validityBits
    ? (grid.validity[index >> 3] ?? 0) & (1 << (index & 7))
    : grid.validity[index];
  if (x < 0 || y < 0 || z < 0 || x >= w || y >= h || z >= d || !valid) {
    return Number.NaN;
  }
  const [vw, vh] = grid.valueDimensions;
  const valueIndex =
    Math.floor(x / grid.valueScale) + vw * (Math.floor(y / grid.valueScale) + vh * z);
  if (grid.valueIndices) {
    let low = 0,
      high = grid.valueIndices.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if ((grid.valueIndices[mid] ?? Infinity) < valueIndex) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return grid.valueIndices[low] === valueIndex ? (grid.values[low] ?? Number.NaN) : Number.NaN;
  }
  return grid.values[valueIndex] ?? Number.NaN;
}
