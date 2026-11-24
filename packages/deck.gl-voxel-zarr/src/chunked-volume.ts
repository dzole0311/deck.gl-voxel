import type { Vector3, VoxelGeometry } from 'deck.gl-voxel';
import { createProjectedGrid } from './projected-grid.js';
import { VolumeView } from './volume-view.js';
import type { ZarrVolume } from './zarr-volume.js';

/** Derived scalar chunks that use the same view selection, caching and projection as Zarr fields. */
export interface ChunkedVolumeOptions {
  readonly geometry: VoxelGeometry;
  readonly frameCount: number;
  /** XYZ cell counts per chunk, including padding at grid edges. */
  readonly chunkDimensions: Vector3;
  /** Interpret XY origin/spacing as north-up longitude/latitude degrees and Z as meters. */
  readonly geographic?: boolean;
  /**
   * Decoded byte budget, excluding displayed grids and in-flight work.
   * @default 67108864
   */
  readonly maxCacheBytes?: number;
  /**
   * Maximum concurrent calls to readChunk.
   * @default 6
   */
  readonly maxRequests?: number;
  /** Returns one immutable, X-fastest float32 chunk. Coordinates are zero-based XYZ chunk indices. */
  readonly readChunk: (
    index: number,
    coordinates: Vector3,
    signal: AbortSignal,
  ) => Promise<Float32Array>;
  /** Releases resources owned by the source after this reader cancels its pending reads. */
  readonly dispose?: () => void;
}

/**
 * Wraps derived chunks in a reader with progressive views and a shared decoded cache.
 * The caller transfers disposal ownership to the reader; disposing it also calls options.dispose.
 * @throws If dimensions, geometry, frame count or cache limits are invalid. Grids are limited to two million cells.
 */
export function createChunkedVolume(options: ChunkedVolumeOptions): ZarrVolume {
  const { dimensions, origin = [0, 0, 0], spacing = [1, 1, 1] } = options.geometry;
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
    cells > 2_000_000 ||
    !Number.isSafeInteger(chunkCells) ||
    chunkCells > 2_000_000 ||
    origin.length !== 3 ||
    spacing.length !== 3 ||
    !origin.every(Number.isFinite) ||
    !spacing.every((value) => Number.isFinite(value) && value !== 0)
  ) {
    throw new Error(
      'Chunked volume requires valid geometry, positive dimensions and at most two million cells.',
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
    getDebugState: () => view.getDebugState(),
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
