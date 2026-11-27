import type { CellMesh } from '../data/cell-mesh.js';
import type { CellClipBounds } from '../geometry/cell-bounds.js';
import { displayElevation } from '../geometry/coordinates.js';

type RunBounds = [number, number, number, number, number, number];

/** Compact stock-mesh attributes. Arrays remain caller-owned and preserve source run order. */
export interface CellAttributes {
  /** Displayed centers in the supplied grid frame, stored Z/Y/X. This helper does not rebase the origin. */
  readonly positions: Float32Array | Float64Array;
  /** Common-unit dimensions: height alone, or [height, 0, Y size, 0, 0, X size] for partial XY cuts. */
  readonly scales: Float32Array;
  /** Number of scale components retained per run. */
  readonly scaleSize: 1 | 6;
  /** Constant positive common-space X/Y dimensions used by the height-only layout. */
  readonly footprint: readonly [number, number];
  /** Index of each surviving run in CellMesh.instances, counted in runs rather than floats. */
  readonly runIndices: Uint32Array;
  readonly count: number;
  /** Retained adapter bytes, excluding the source mesh and palette colors. */
  readonly bytes: number;
}

/** Writes kept common-XY and physical-Z bounds; only visible runs with nonempty volume survive. */
function keptRun(
  mesh: CellMesh,
  run: number,
  visibleBins: number,
  clip: CellClipBounds | undefined,
  bounds: RunBounds,
): boolean {
  const offset = run * 8,
    instances = mesh.instances;
  if (!(visibleBins & (1 << (instances[offset + 5] ?? 0)))) {
    return false;
  }
  const x = mesh.grid.origin[0] + (instances[offset] ?? 0),
    y = mesh.grid.origin[1] + (instances[offset + 1] ?? 0),
    x1 = x + mesh.grid.spacing[0],
    y1 = y + mesh.grid.spacing[1],
    z = instances[offset + 2] ?? 0,
    z1 = instances[offset + 3] ?? 0;
  bounds[0] = Math.max(Math.min(x, x1), clip?.[0] ?? -Infinity);
  bounds[1] = Math.max(Math.min(y, y1), clip?.[1] ?? -Infinity);
  bounds[2] = Math.max(Math.min(z, z1), clip?.[2] ?? -Infinity);
  bounds[3] = Math.min(Math.max(x, x1), clip?.[3] ?? Infinity);
  bounds[4] = Math.min(Math.max(y, y1), clip?.[4] ?? Infinity);
  bounds[5] = Math.min(Math.max(z, z1), clip?.[5] ?? Infinity);
  return bounds[0] < bounds[3] && bounds[1] < bounds[4] && bounds[2] < bounds[5];
}

/**
 * Converts runs to closed-cuboid attributes without changing native coverage or source values.
 * Centers use Z/Y/X order so height can fill a stock matrix column without storing two zeroes per run.
 * Clipping occurs in common X/Y and physical Z before ground-relative exaggeration.
 * Cache returned arrays by mesh identity and options; camera movement does not affect them.
 * @param exaggeration - Positive stretch about each run's physical ground elevation.
 * @param visibleBins - Bit mask of retained display categories.
 * @param clipBounds - Kept common X/Y and physical-meter Z bounds; infinities leave axes unbounded.
 * @param positionPrecision - Float64 by default; use float32 only with suitably small local common coordinates.
 * @returns Newly owned attributes for nonempty, visible cuboids in CellLayer's fixed local basis.
 * @throws If exaggeration, the mesh run count, or the ordering of clip bounds is invalid.
 */
export function prepareCellAttributes(
  mesh: CellMesh,
  exaggeration = 1,
  visibleBins = 0xffffffff,
  clipBounds?: CellClipBounds,
  positionPrecision: 'float32' | 'float64' = 'float64',
): CellAttributes {
  if (
    !Number.isFinite(exaggeration) ||
    exaggeration <= 0 ||
    !Number.isInteger(mesh.binCount) ||
    mesh.binCount < 1 ||
    mesh.binCount > 32 ||
    !Number.isSafeInteger(mesh.count) ||
    mesh.count < 0 ||
    mesh.instances.length !== mesh.count * 8
  ) {
    throw new Error('Cell geometry requires positive exaggeration and a complete run array.');
  }
  if (
    clipBounds &&
    (clipBounds.length !== 6 ||
      clipBounds.some((value) => typeof value !== 'number' || Number.isNaN(value)) ||
      clipBounds[0] > clipBounds[3] ||
      clipBounds[1] > clipBounds[4] ||
      clipBounds[2] > clipBounds[5])
  ) {
    throw new Error('Cell clip bounds must be ordered common X/Y and physical-meter Z bounds.');
  }
  const bounds: RunBounds = [0, 0, 0, 0, 0, 0],
    footprint: readonly [number, number] = [
      Math.fround(Math.abs(mesh.grid.spacing[0])),
      Math.fround(Math.abs(mesh.grid.spacing[1])),
    ],
    allBins = mesh.binCount === 32 ? -1 : (1 << mesh.binCount) - 1;
  let count = mesh.count,
    scaleSize: 1 | 6 = 1;
  if (clipBounds || (visibleBins & allBins) !== allBins) {
    count = 0;
    for (let run = 0; run < mesh.count; run++) {
      if (!keptRun(mesh, run, visibleBins, clipBounds, bounds)) {
        continue;
      }
      count++;
      if (
        Math.fround(bounds[3] - bounds[0]) !== footprint[0] ||
        Math.fround(bounds[4] - bounds[1]) !== footprint[1]
      ) {
        scaleSize = 6;
      }
    }
  }
  const PositionArray = positionPrecision === 'float32' ? Float32Array : Float64Array;
  const positions = new PositionArray(count * 3),
    scales = new Float32Array(count * scaleSize),
    runIndices = new Uint32Array(count);
  let index = 0;
  for (let run = 0; run < mesh.count; run++) {
    if (!keptRun(mesh, run, visibleBins, clipBounds, bounds)) {
      continue;
    }
    const offset = run * 8,
      ground = mesh.instances[offset + 4] ?? 0,
      scale = mesh.instances[offset + 6] ?? 1,
      lowZ = displayElevation(bounds[2], ground, exaggeration) * scale,
      highZ = displayElevation(bounds[5], ground, exaggeration) * scale,
      position = index * 3,
      target = index * scaleSize;
    positions[position] = (lowZ + highZ) / 2;
    positions[position + 1] = (bounds[1] + bounds[4]) / 2;
    positions[position + 2] = (bounds[0] + bounds[3]) / 2;
    scales[target] = highZ - lowZ;
    if (scaleSize === 6) {
      scales[target + 2] = bounds[4] - bounds[1];
      scales[target + 5] = bounds[3] - bounds[0];
    }
    runIndices[index] = run;
    index++;
  }
  return {
    positions,
    scales,
    scaleSize,
    footprint,
    runIndices,
    count,
    bytes: positions.byteLength + scales.byteLength + runIndices.byteLength,
  };
}
