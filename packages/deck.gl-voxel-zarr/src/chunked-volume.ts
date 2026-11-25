import type { Vector3, VoxelGeometry } from 'deck.gl-voxel';
import { createProjectedGrid } from './projected-grid.js';
import { DEFAULT_MAX_CELLS } from './volume-limits.js';
import { VolumeView } from './volume-view.js';
import type { ZarrVolume } from './zarr-volume.js';

/** Custom scalar chunks with the same camera selection, cache and map projection as Zarr fields */
export interface ChunkedVolumeOptions {
  readonly geometry: VoxelGeometry;
  readonly frameCount: number;
  /**
   * Cell counts per chunk in XYZ order
   * Edge chunks must return the same number of values as interior chunks
   * Pad cells beyond the grid bounds, which the reader ignores when copying into the grid
   */
  readonly chunkDimensions: Vector3;
  /**
   * Treat XY origin and spacing as longitude and latitude degrees, with rows running north to south
   * Z uses meters and increases upward
   */
  readonly geographic?: boolean;
  /**
   * Maximum cell count for both the full grid and each padded chunk
   * Each Float32 grid uses four bytes per cell, and progress results allocate new grids
   * Geographic reads also use one readiness byte per source cell
   * Cached chunks and previous results use additional memory outside this limit
   * @default 2000000
   */
  readonly maxCells?: number;
  /**
   * Byte limit for cached decoded chunks
   * Displayed grids and pending work are outside this limit
   * @default 67108864
   */
  readonly maxCacheBytes?: number;
  /**
   * Maximum number of readChunk calls running at once
   * @default 6
   */
  readonly maxRequests?: number;
  /**
   * Returns one padded chunk with X changing fastest, followed by Y and then Z
   * Coordinates identify chunks rather than cells, so [1, 0, 0] is the second chunk along X
   * The reader may cache this array, so do not change its values after returning it
   */
  readonly readChunk: (
    index: number,
    coordinates: Vector3,
    signal: AbortSignal,
  ) => Promise<Float32Array>;
  /** Releases source resources after this reader cancels its pending reads */
  readonly dispose?: () => void;
}

/**
 * Creates a reader that loads custom chunks for the current view
 * Call dispose when the reader is no longer needed to cancel reads and run options.dispose
 * maxCells limits both the full grid and each padded chunk before any reads start
 * @throws If geometry, frame count or cache limits are invalid, or either cell count exceeds the cap
 */
export function createChunkedVolume(options: ChunkedVolumeOptions): ZarrVolume {
  const { dimensions, origin = [0, 0, 0], spacing = [1, 1, 1] } = options.geometry;
  const maxCells = options.maxCells ?? DEFAULT_MAX_CELLS;
  if (!Number.isSafeInteger(maxCells) || maxCells < 1) {
    throw new Error('maxCells must be a positive safe integer.');
  }
  const [cx, cy, cz] = options.chunkDimensions;
  const cells = dimensions.reduce((size, count) => size * count, 1);
  const chunkCells = cx * cy * cz;
  if (
    dimensions.length !== 3 ||
    options.chunkDimensions.length !== 3 ||
    ![...dimensions, cx, cy, cz, options.frameCount].every(
      (size) => Number.isSafeInteger(size) && size > 0,
    ) ||
    !Number.isSafeInteger(cells) ||
    cells > maxCells ||
    !Number.isSafeInteger(chunkCells) ||
    chunkCells > maxCells ||
    origin.length !== 3 ||
    spacing.length !== 3 ||
    !origin.every(Number.isFinite) ||
    !spacing.every((value) => Number.isFinite(value) && value !== 0)
  ) {
    throw new Error(
      `Chunked volume requires valid geometry, positive dimensions and grid and chunk cell counts no greater than maxCells (${maxCells}).`,
    );
  }
  const grid = options.geographic
    ? createProjectedGrid(
        {
          affine: [spacing[0], 0, origin[0], 0, spacing[1], origin[1]],
          arrayWidth: dimensions[0],
          arrayHeight: dimensions[1],
        },
        { count: dimensions[2], origin: origin[2], spacing: spacing[2] },
      )
    : undefined;
  const geometry = grid
    ? { dimensions: grid.dimensions, origin: grid.origin, spacing: grid.spacing }
    : options.geometry;
  const view = new VolumeView({
    array: {
      chunks: [1, cz, cy, cx],
      async getChunk(coordinates, request) {
        const [index, z, y, x] = coordinates;
        if (index === undefined || x === undefined || y === undefined || z === undefined) {
          throw new Error('Derived chunk requires frame and XYZ coordinates.');
        }
        const signal = request?.signal ?? new AbortController().signal;
        const data = await options.readChunk(index, [x, y, z], signal);
        signal.throwIfAborted();
        if (!(data instanceof Float32Array) || data.length !== chunkCells) {
          throw new Error('Derived chunk values must match chunkDimensions.');
        }
        return { data, shape: [1, cz, cy, cx], stride: [chunkCells, cx * cy, cx, 1] };
      },
    },
    axes: ['time', 'z', 'y', 'x'],
    dimensions,
    geometry,
    frameCount: options.frameCount,
    selection: {},
    grid,
    noDataValue: undefined,
    maxCacheBytes: options.maxCacheBytes ?? 64 * 1024 * 1024,
    maxRequests: options.maxRequests ?? 6,
  });
  let disposed = false;
  return {
    geometry,
    frameCount: options.frameCount,
    level: '.',
    readView: (index, query) => view.read(index, query),
    readFrame: (index, signal = new AbortController().signal) =>
      view.read(index, {
        volumeToClip: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, -1, -1, -1, 1],
        signal,
      }),
    dispose() {
      if (!disposed) {
        disposed = true;
        view.dispose();
        options.dispose?.();
      }
    },
  };
}
