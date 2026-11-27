import { type CellGrid, cellValue } from './cell-grid.js';

/**
 * Merged vertical runs with immutable input arrays that remain owned by the caller.
 * Each run stores [xOffset, yOffset, zStart, zEnd, ground, bin, elevationScale, reserved].
 * XY offsets are relative to the grid origin. Z ends and ground are physical meters.
 * The renderer converts each run to a cuboid; count is the number of runs, not native samples.
 */
export interface CellMesh {
  readonly grid: CellGrid;
  readonly instances: Float32Array;
  readonly count: number;
  readonly bytes: number;
  readonly binCount: number;
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
 * Preparation yields between rows; camera movement does not affect the result.
 * Sparse grids keep only finite values with their sorted indices, preserving exact samples and zero values.
 * Keep the returned mesh and its arrays unchanged so layers can reuse their cached attributes.
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
  const retained = await compactCellValues(grid, signal);
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
 * Keeps dense inputs unchanged unless two sparse typed arrays would use less memory.
 * Count first so dense grids do not allocate temporary JavaScript arrays for every sample.
 * Already compacted grids keep their original arrays and index mapping.
 */
async function compactCellValues(grid: CellGrid, signal?: AbortSignal): Promise<CellGrid> {
  if (grid.valueIndices) {
    return grid;
  }
  let finiteCount = 0;
  let deadline = performance.now() + 8;
  for (let i = 0; i < grid.values.length; i++) {
    if (Number.isFinite(grid.values[i])) {
      finiteCount++;
    }
    if ((i & 65535) === 0 && performance.now() > deadline) {
      signal?.throwIfAborted();
      await yieldTask();
      deadline = performance.now() + 8;
    }
  }
  if (finiteCount * 2 >= grid.values.length) {
    return grid;
  }
  const values = new Float32Array(finiteCount);
  const valueIndices = new Uint32Array(finiteCount);
  let target = 0;
  for (let i = 0; i < grid.values.length; i++) {
    const value = grid.values[i] ?? Number.NaN;
    if (Number.isFinite(value)) {
      values[target] = value;
      valueIndices[target] = i;
      target++;
    }
    if ((i & 65535) === 0 && performance.now() > deadline) {
      signal?.throwIfAborted();
      await yieldTask();
      deadline = performance.now() + 8;
    }
  }
  return { ...grid, values, valueIndices };
}
