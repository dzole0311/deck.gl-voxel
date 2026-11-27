import type { CellMesh } from '../data/cell-mesh.js';
import type { NormalizedClipBounds, Vector3, VoxelGeometry } from '../types.js';
import { displayElevation } from './coordinates.js';

/** Kept common-space X/Y and physical-meter Z bounds, ordered min XYZ then max XYZ. Unbounded axes may use infinities. */
export type CellClipBounds = readonly [number, number, number, number, number, number];

/**
 * Converts normalized grid fractions to the physicalClipBounds used by VoxelLayer in cells mode.
 * Supply the full slicing domain: its XY coordinates are common units and its Z coordinates are physical meters.
 * Fractions follow grid-index direction from the origin, including negative spacing; outputs are ordered in common X/Y and physical Z coordinates.
 * Convert once for that domain, then share the resulting absolute bounds across its displayed tiles.
 * Inspector debug geometry already has exaggerated common-space Z and is not a physical slicing domain.
 * @throws If fractions or domain coordinates are invalid, or their resulting bounds are not finite.
 */
export function cellClipBoundsFromFractions(
  geometry: VoxelGeometry,
  fractions: NormalizedClipBounds,
): CellClipBounds {
  if (
    !Array.isArray(fractions) ||
    fractions.length !== 6 ||
    !fractions.every((value) => Number.isFinite(value) && value >= 0 && value <= 1) ||
    fractions[0] > fractions[3] ||
    fractions[1] > fractions[4] ||
    fractions[2] > fractions[5]
  ) {
    throw new Error('Normalized clip bounds must be increasing fractions between 0 and 1.');
  }
  const origin: Vector3 = geometry?.origin ?? [0, 0, 0];
  const spacing: Vector3 = geometry?.spacing ?? [1, 1, 1];
  if (
    !geometry ||
    !Array.isArray(geometry.dimensions) ||
    geometry.dimensions.length !== 3 ||
    !geometry.dimensions.every((value) => Number.isSafeInteger(value) && value > 0) ||
    !Array.isArray(origin) ||
    origin.length !== 3 ||
    !origin.every(Number.isFinite) ||
    !Array.isArray(spacing) ||
    spacing.length !== 3 ||
    !spacing.every((value) => Number.isFinite(value) && value !== 0)
  ) {
    throw new Error(
      'Cell slicing requires finite grid coordinates, nonzero spacing and positive integer dimensions.',
    );
  }
  const upper: Vector3 = [fractions[3], fractions[4], fractions[5]];
  const result: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
  for (const axis of [0, 1, 2] as const) {
    const extent = spacing[axis] * geometry.dimensions[axis];
    const a = origin[axis] + fractions[axis] * extent;
    const b = origin[axis] + upper[axis] * extent;
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      throw new Error('Cell slicing domain coordinates must remain finite.');
    }
    result[axis] = Math.min(a, b);
    result[axis + 3] = Math.max(a, b);
  }
  return result;
}

/**
 * Displayed common-space bounds, optionally restricted to native Z indices and physical clip bounds.
 * @param zRange - Half-open native Z index range used by the chunk inspector.
 * @param clipBounds - Kept common X/Y and physical-meter Z bounds, applied before exaggeration.
 */
export function getCellMeshBounds(
  mesh: CellMesh,
  exaggeration: number,
  zRange?: readonly [number, number],
  clipBounds?: CellClipBounds,
): [number, number, number, number, number, number] {
  const { grid, instances } = mesh;
  const x1 = grid.origin[0] + grid.spacing[0] * grid.dimensions[0],
    y1 = grid.origin[1] + grid.spacing[1] * grid.dimensions[1],
    gridLowX = Math.min(grid.origin[0], x1),
    gridLowY = Math.min(grid.origin[1], y1),
    gridHighX = Math.max(grid.origin[0], x1),
    gridHighY = Math.max(grid.origin[1], y1);
  let low = Infinity,
    high = -Infinity,
    lowX = clipBounds ? Infinity : gridLowX,
    lowY = clipBounds ? Infinity : gridLowY,
    highX = clipBounds ? -Infinity : gridHighX,
    highY = clipBounds ? -Infinity : gridHighY;
  for (let i = 0; i < instances.length; i += 8) {
    const physicalLow = Math.min(instances[i + 2] ?? 0, instances[i + 3] ?? 0),
      physicalHigh = Math.max(instances[i + 2] ?? 0, instances[i + 3] ?? 0);
    const cut0 = zRange ? grid.origin[2] + zRange[0] * grid.spacing[2] : -Infinity,
      cut1 = zRange ? grid.origin[2] + zRange[1] * grid.spacing[2] : Infinity;
    const keptLow = Math.max(physicalLow, Math.min(cut0, cut1), clipBounds?.[2] ?? -Infinity),
      keptHigh = Math.min(physicalHigh, Math.max(cut0, cut1), clipBounds?.[5] ?? Infinity);
    if (keptLow >= keptHigh) {
      continue;
    }
    if (clipBounds) {
      const x = grid.origin[0] + (instances[i] ?? 0),
        y = grid.origin[1] + (instances[i + 1] ?? 0),
        endX = x + grid.spacing[0],
        endY = y + grid.spacing[1],
        keptLowX = Math.max(Math.min(x, endX), clipBounds[0]),
        keptLowY = Math.max(Math.min(y, endY), clipBounds[1]),
        keptHighX = Math.min(Math.max(x, endX), clipBounds[3]),
        keptHighY = Math.min(Math.max(y, endY), clipBounds[4]);
      if (keptLowX >= keptHighX || keptLowY >= keptHighY) {
        continue;
      }
      lowX = Math.min(lowX, keptLowX);
      lowY = Math.min(lowY, keptLowY);
      highX = Math.max(highX, keptHighX);
      highY = Math.max(highY, keptHighY);
    }
    const a =
        displayElevation(keptLow, instances[i + 4] ?? 0, exaggeration) * (instances[i + 6] ?? 1),
      b = displayElevation(keptHigh, instances[i + 4] ?? 0, exaggeration) * (instances[i + 6] ?? 1);
    low = Math.min(low, a, b);
    high = Math.max(high, a, b);
  }
  if (!Number.isFinite(low)) {
    low = 0;
    high = 0;
    if (clipBounds) {
      lowX = Math.max(gridLowX, Math.min(gridHighX, clipBounds[0]));
      lowY = Math.max(gridLowY, Math.min(gridHighY, clipBounds[1]));
      highX = lowX;
      highY = lowY;
    }
  }
  return [lowX, lowY, low, highX, highY, high];
}
