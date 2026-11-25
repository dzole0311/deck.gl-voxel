import type { Vector3 } from './types.js';

/** Opaque cells in common-space XY and physical meter Z, with a native coverage mask. */
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

/** Immutable cuboids, eight floats per instance. Callers retain ownership of the arrays. */
export interface CellMesh {
  readonly grid: CellGrid;
  readonly instances: Float32Array;
  readonly count: number;
  readonly bytes: number;
  readonly binCount: number;
}

/** Physical elevation to display elevation. Local ground remains fixed. */
export function displayElevation(physical: number, ground: number, exaggeration = 1): number {
  return ground + exaggeration * (physical - ground);
}

/** Inverse of {@link displayElevation}; useful for physical-value tooltips. */
export function physicalElevation(display: number, ground: number, exaggeration = 1): number {
  return ground + (display - ground) / exaggeration;
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

/** Splits expensive preparation into short tasks, including a fallback for browsers without scheduler.yield. */
async function yieldTask(): Promise<void> {
  const host = globalThis as typeof globalThis & { scheduler?: { yield(): Promise<void> } };
  if (host.scheduler?.yield) {
    await host.scheduler.yield();
  } else {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Merges adjacent vertical cells with the same display bin. No native gap is bridged.
 * Preparation yields between rows; movement never rebuilds a retained mesh.
 * @param bins - Equally sized display bins over valueRange, independent of category visibility.
 */
export async function prepareCellMesh(
  grid: CellGrid,
  bins: number,
  valueRange: readonly [number, number],
  signal?: AbortSignal,
): Promise<CellMesh> {
  const [w, h, depth] = grid.dimensions;
  if (
    !Number.isInteger(bins) ||
    bins < 1 ||
    bins > 32 ||
    !Number.isSafeInteger(grid.valueScale) ||
    grid.valueScale < 1 ||
    !valueRange.every(Number.isFinite) ||
    valueRange[1] <= valueRange[0] ||
    !grid.dimensions.every((n) => Number.isSafeInteger(n) && n > 0) ||
    grid.validity.length !== (grid.validityBits ? Math.ceil((w * h * depth) / 8) : w * h * depth) ||
    grid.ground.length !== w * h ||
    grid.elevationScales.length !== h ||
    !grid.origin.every(Number.isFinite) ||
    !grid.spacing.every((n) => Number.isFinite(n) && n !== 0) ||
    !grid.elevationScales.every((n) => Number.isFinite(n) && n > 0) ||
    grid.values.length !==
      (grid.valueIndices?.length ?? grid.valueDimensions.reduce((a, b) => a * b, 1))
  ) {
    throw new Error('Invalid opaque cell grid or display bins.');
  }
  const blocks: Float32Array[] = [];
  const blockSize = 8192 * 8;
  let block = new Float32Array(blockSize),
    used = 0,
    count = 0;
  const push = (x: number, y: number, start: number, end: number, ground: number, bin: number) => {
    if (used === block.length) {
      blocks.push(block);
      block = new Float32Array(blockSize);
      used = 0;
    }
    block.set(
      [
        x * grid.spacing[0],
        y * grid.spacing[1],
        grid.origin[2] + start * grid.spacing[2],
        grid.origin[2] + end * grid.spacing[2],
        ground,
        bin,
        grid.elevationScales[y] ?? 0,
        0,
      ],
      used,
    );
    used += 8;
    count++;
  };
  let deadline = performance.now() + 8;
  for (let y = 0; y < h; y++) {
    signal?.throwIfAborted();
    for (let x = 0; x < w; x++) {
      const ground = grid.ground[x + w * y] ?? Number.NaN;
      if (!Number.isFinite(ground)) {
        continue;
      }
      let previous = -1,
        start = 0;
      for (let z = 0; z <= depth; z++) {
        const value = cellValue(grid, x, y, z);
        const bin = Number.isFinite(value)
          ? Math.max(
              0,
              Math.min(
                bins - 1,
                Math.floor(((value - valueRange[0]) / (valueRange[1] - valueRange[0])) * bins),
              ),
            )
          : -1;
        if (bin !== previous) {
          if (previous >= 0) {
            push(x, y, start, z, ground, previous);
          }
          previous = bin;
          start = z;
        }
      }
    }
    if (performance.now() > deadline) {
      await yieldTask();
      deadline = performance.now() + 8;
    }
  }
  const instances = new Float32Array(count * 8);
  let offset = 0;
  for (const entry of blocks) {
    instances.set(entry, offset);
    offset += entry.length;
  }
  instances.set(block.subarray(0, used), offset);
  // Dense native grids are mostly empty survey gaps. Retain exact finite values with sorted indices.
  const indices: number[] = [],
    samples: number[] = [];
  for (let i = 0; i < grid.values.length; i++) {
    const value = grid.values[i] ?? Number.NaN;
    if (Number.isFinite(value)) {
      indices.push(i);
      samples.push(value);
    }
    if ((i & 65535) === 0 && performance.now() > deadline) {
      signal?.throwIfAborted();
      await yieldTask();
      deadline = performance.now() + 8;
    }
  }
  const retained =
    !grid.valueIndices && indices.length * 2 < grid.values.length
      ? { ...grid, values: Float32Array.from(samples), valueIndices: Uint32Array.from(indices) }
      : grid;
  return {
    grid: retained,
    binCount: bins,
    instances,
    count,
    bytes:
      instances.byteLength +
      retained.values.byteLength +
      (retained.valueIndices?.byteLength ?? 0) +
      grid.validity.byteLength +
      grid.ground.byteLength +
      grid.elevationScales.byteLength,
  };
}

/**
 * Picks disjoint chunks front to back, skipping meshes whose displayed bounds cannot contain a nearer hit.
 * Bounds must use the same exaggeration and common coordinates as the supplied ray.
 */
export function pickCellCollection<
  T extends {
    readonly mesh: CellMesh;
    readonly bounds: readonly [number, number, number, number, number, number];
  },
>(
  items: readonly T[],
  ray: { origin: Vector3; direction: Vector3 },
  exaggeration: number,
  visibleBins = 0xffffffff,
): { item: T; hit: CellHit } | undefined {
  const candidates: { item: T; distance: number }[] = [];
  for (const item of items) {
    let enter = 0,
      exit = Infinity;
    for (const axis of [0, 1, 2] as const) {
      const low = item.bounds[axis],
        high = item.bounds[axis + 3] ?? low,
        direction = ray.direction[axis],
        origin = ray.origin[axis];
      if (Math.abs(direction) < 1e-15) {
        if (origin < low || origin > high) {
          exit = -1;
          break;
        }
      } else {
        const a = (low - origin) / direction,
          b = (high - origin) / direction;
        enter = Math.max(enter, Math.min(a, b));
        exit = Math.min(exit, Math.max(a, b));
      }
    }
    if (enter <= exit && exit >= 0) {
      candidates.push({ item, distance: enter });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);
  let nearest: { item: T; hit: CellHit } | undefined;
  for (const candidate of candidates) {
    if (nearest && candidate.distance >= nearest.hit.distance) {
      break;
    }
    const hit = pickCellMesh(candidate.item.mesh, ray, exaggeration, visibleBins);
    if (hit && (!nearest || hit.distance < nearest.hit.distance)) {
      nearest = { item: candidate.item, hit };
    }
  }
  return nearest;
}

/** Nearest displayed opaque hit, in the same common coordinates as the camera ray. */
export interface CellHit {
  readonly distance: number;
  readonly value: number;
  readonly physicalZ: number;
  readonly groundZ: number;
  readonly position: Vector3;
  readonly index: Vector3;
}

/** Reusable cuboid picking using the renderer's bins, ground transform and native mask. */
export function pickCellMesh(
  mesh: CellMesh,
  ray: { origin: Vector3; direction: Vector3 },
  exaggeration: number,
  visibleBins = 0xffffffff,
  clipBounds?: readonly [number, number, number, number, number, number],
): CellHit | undefined {
  const { grid, instances } = mesh;
  let best = Number.POSITIVE_INFINITY,
    hit: CellHit | undefined;
  for (let i = 0; i < instances.length; i += 8) {
    const x = instances[i] ?? 0,
      y = instances[i + 1] ?? 0,
      ground = instances[i + 4] ?? 0;
    if (!(visibleBins & (1 << (instances[i + 5] ?? 0)))) {
      continue;
    }
    const scale = instances[i + 6] ?? 1;
    const z0 = displayElevation(instances[i + 2] ?? 0, ground, exaggeration) * scale;
    const z1 = displayElevation(instances[i + 3] ?? 0, ground, exaggeration) * scale;
    const a: Vector3 = [grid.origin[0] + x, grid.origin[1] + y, z0];
    const b: Vector3 = [a[0] + grid.spacing[0], a[1] + grid.spacing[1], z1];
    let enter = 0,
      exit = best;
    for (const axis of [0, 1, 2] as const) {
      const clipLow =
        axis === 2 && clipBounds
          ? displayElevation(clipBounds[2], ground, exaggeration) * scale
          : (clipBounds?.[axis] ?? -Infinity);
      const clipHigh =
        axis === 2 && clipBounds
          ? displayElevation(clipBounds[5], ground, exaggeration) * scale
          : (clipBounds?.[axis + 3] ?? Infinity);
      const low = Math.max(Math.min(a[axis], b[axis]), clipLow),
        high = Math.min(Math.max(a[axis], b[axis]), clipHigh);
      if (low >= high) {
        exit = -1;
        break;
      }
      const origin = ray.origin[axis],
        direction = ray.direction[axis];
      if (Math.abs(direction) < 1e-15) {
        if (origin < low || origin > high) {
          exit = -1;
          break;
        }
      } else {
        const first = (low - origin) / direction,
          last = (high - origin) / direction;
        enter = Math.max(enter, Math.min(first, last));
        exit = Math.min(exit, Math.max(first, last));
      }
    }
    if (enter > exit || exit < 0 || enter >= best) {
      continue;
    }
    best = enter;
    const position: Vector3 = [
      ray.origin[0] + best * ray.direction[0],
      ray.origin[1] + best * ray.direction[1],
      ray.origin[2] + best * ray.direction[2],
    ];
    const physicalZ = physicalElevation(position[2] / scale, ground, exaggeration);
    const ix = Math.round(x / grid.spacing[0]),
      iy = Math.round(y / grid.spacing[1]);
    const insideZ = Math.max(
      Math.min(instances[i + 2] ?? 0, instances[i + 3] ?? 0) + 1e-5,
      Math.min(Math.max(instances[i + 2] ?? 0, instances[i + 3] ?? 0) - 1e-5, physicalZ),
    );
    const iz = Math.max(
      0,
      Math.min(grid.dimensions[2] - 1, Math.floor((insideZ - grid.origin[2]) / grid.spacing[2])),
    );
    hit = {
      distance: best,
      value: cellValue(grid, ix, iy, iz),
      physicalZ,
      groundZ: ground,
      position,
      index: [ix, iy, iz],
    };
  }
  return hit;
}

/** Displayed common-space bounds, optionally restricted to a half-open range of native Z indices. */
export function getCellMeshBounds(
  mesh: CellMesh,
  exaggeration: number,
  zRange?: readonly [number, number],
): [number, number, number, number, number, number] {
  const { grid, instances } = mesh;
  let low = Infinity,
    high = -Infinity;
  for (let i = 0; i < instances.length; i += 8) {
    const physicalLow = Math.min(instances[i + 2] ?? 0, instances[i + 3] ?? 0),
      physicalHigh = Math.max(instances[i + 2] ?? 0, instances[i + 3] ?? 0);
    const cut0 = zRange ? grid.origin[2] + zRange[0] * grid.spacing[2] : -Infinity,
      cut1 = zRange ? grid.origin[2] + zRange[1] * grid.spacing[2] : Infinity;
    const keptLow = Math.max(physicalLow, Math.min(cut0, cut1)),
      keptHigh = Math.min(physicalHigh, Math.max(cut0, cut1));
    if (keptLow >= keptHigh) {
      continue;
    }
    const a =
      displayElevation(keptLow, instances[i + 4] ?? 0, exaggeration) * (instances[i + 6] ?? 1);
    const b =
      displayElevation(keptHigh, instances[i + 4] ?? 0, exaggeration) * (instances[i + 6] ?? 1);
    low = Math.min(low, a, b);
    high = Math.max(high, a, b);
  }
  if (!Number.isFinite(low)) {
    low = 0;
    high = 0;
  }
  const x1 = grid.origin[0] + grid.spacing[0] * grid.dimensions[0],
    y1 = grid.origin[1] + grid.spacing[1] * grid.dimensions[1];
  return [
    Math.min(grid.origin[0], x1),
    Math.min(grid.origin[1], y1),
    low,
    Math.max(grid.origin[0], x1),
    Math.max(grid.origin[1], y1),
    high,
  ];
}
