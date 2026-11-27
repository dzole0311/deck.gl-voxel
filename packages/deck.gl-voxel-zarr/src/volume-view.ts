import { Matrix4 } from '@math.gl/core';
import type { Vector3, VoxelData, VoxelGeometry } from 'deck.gl-voxel';
import type { Chunk, Array as ZarrArray } from 'zarrita';
import { ChunkCache } from './cache/chunk-cache.js';
import { BACKGROUND_PRIORITY, MAX_VISIBLE_READ_PRIORITY } from './cache/request-priority.js';
import type { ZarrDebugChunk, ZarrDebugState } from './debug.js';
import { type ProjectedGrid, projectFrame } from './projected-grid.js';
import type { Axis } from './zarr-volume.js';

/**
 * Camera query where [0, 0, 0] and [1, 1, 1] are opposite corners of the volume
 * volumeToClip transforms those coordinates to the camera's [x, y, z, w] coordinates
 * A point is inside the camera bounds when x, y and z each lie between -w and w
 * Keep w until after visibility checks so boxes crossing behind the camera are handled correctly
 */
export interface ZarrViewOptions {
  readonly volumeToClip: readonly number[];
  readonly signal: AbortSignal;
  readonly clipBounds?: readonly [number, number, number, number, number, number];
  /**
   * Partial grids with NaN where data has not loaded
   * Treat the values as read-only because the renderer and reader can retain the grid
   * Loading finishes when readView resolves
   */
  readonly onProgress?: (volume: VoxelData) => void;
  /**
   * Added to each chunk's screen-center distance priority, with lower totals starting first
   * Background reads use a larger offset so queued visible reads start before them
   * This does not interrupt reads that have already started
   * @default 0
   */
  readonly priority?: number;
}

const XYZ = [0, 1, 2] as const;
const PROGRESS_INTERVAL_MS = 50;

interface Tile {
  readonly key: string;
  readonly start: Vector3;
  readonly end: Vector3;
  readonly priority: number;
}

interface DebugView {
  frameIndex: number;
  chunks: Omit<ZarrDebugChunk, 'status'>[] | undefined;
  matrix: readonly number[];
  clip: readonly number[];
  cached: Set<string>;
  loaded: Set<string>;
  reusedView: boolean;
  failure: 'cancelled' | 'error' | undefined;
}

/**
 * Skips a box only when all eight corners are outside the same camera boundary
 * A box crossing a boundary stays selected, even if some of it is off screen
 */
export function volumeBoxVisible(min: Vector3, max: Vector3, matrix: readonly number[]): boolean {
  const transform = matrix instanceof Matrix4 ? matrix : new Matrix4(matrix);
  const corners: ArrayLike<number>[] = [];
  for (const x of [min[0], max[0]]) {
    for (const y of [min[1], max[1]]) {
      for (const z of [min[2], max[2]]) {
        corners.push(transform.transform([x, y, z, 1]));
      }
    }
  }
  return !XYZ.some((axis) =>
    [-1, 1].some((sign) => corners.every((point) => sign * (point[axis] ?? 0) > (point[3] ?? 0))),
  );
}

function outputRanges(
  samples: ProjectedGrid['columns'] | undefined,
  count: number,
  chunkSize: number,
): [number, number][] {
  const ranges: [number, number][] = Array.from(
    { length: Math.ceil(count / chunkSize) },
    (_, index) =>
      samples
        ? [1, 0]
        : [(index * chunkSize) / count, Math.min(count, (index + 1) * chunkSize) / count],
  );
  if (samples) {
    for (const [index, sample] of samples.entries()) {
      for (const neighbor of [0, 1] as const) {
        if ((neighbor === 0 && sample[2] === 1) || (neighbor === 1 && sample[2] === 0)) {
          continue;
        }
        const range = ranges[Math.floor(sample[neighbor] / chunkSize)];
        if (range) {
          range[0] = Math.min(range[0], index / count);
          range[1] = Math.max(range[1], (index + 1) / count);
        }
      }
    }
  }
  return ranges;
}

/** Grid metadata used by both the plain Zarr and GeoZarr readers */
export interface VolumeViewSource {
  readonly array: Pick<ZarrArray<'float32'>, 'chunks' | 'getChunk'>;
  readonly axes: readonly Axis[];
  readonly dimensions: Vector3;
  readonly geometry: VoxelGeometry;
  readonly frameCount: number;
  readonly selection: Readonly<Record<number, number>>;
  readonly grid: ProjectedGrid | undefined;
  readonly noDataValue: number | undefined;
  readonly maxCacheBytes: number;
  readonly maxRequests: number;
}

/**
 * Selects chunks for the camera and copies them into a full-sized grid
 * Unloaded cells stay NaN so the renderer can skip them without moving the loaded cells
 * Keeping one volume lets the renderer blend along each ray across chunk boundaries
 */
export class VolumeView {
  private readonly cache: ChunkCache<string, Chunk<'float32'>>;
  private readonly spatialAxes: Vector3;
  private readonly chunkSize: Vector3;
  private disposed = false;
  private debug: DebugView | undefined;
  private lastView: { key: string; volume: VoxelData } | undefined;
  private readonly columns: readonly [number, number][];
  private readonly rows: readonly [number, number][];

  constructor(private readonly source: VolumeViewSource) {
    this.spatialAxes = [
      source.axes.indexOf('x'),
      source.axes.indexOf('y'),
      source.axes.indexOf('z'),
    ];
    const sizes = this.spatialAxes.map((axis) => source.array.chunks[axis]);
    const [x, y, z] = sizes;
    if (
      x === undefined ||
      y === undefined ||
      z === undefined ||
      !sizes.every((value) => value !== undefined && Number.isSafeInteger(value) && value > 0)
    ) {
      throw new Error('Zarr chunks require positive XYZ dimensions.');
    }
    this.chunkSize = [x, y, z];
    this.columns = outputRanges(source.grid?.columns, source.dimensions[0], x);
    this.rows = outputRanges(source.grid?.rows, source.dimensions[1], y);
    this.cache = new ChunkCache({
      maxBytes: source.maxCacheBytes,
      maxRequests: source.maxRequests,
      load: async (key, signal) => {
        const chunk = await source.array.getChunk(key.split(',').map(Number), { signal });
        signal.throwIfAborted();
        // Copy a chunk view so it does not keep a larger shared buffer in the cache
        return chunk.data.byteLength === chunk.data.buffer.byteLength
          ? chunk
          : { ...chunk, data: chunk.data.slice() };
      },
      byteLength: (chunk) => chunk.data.byteLength,
    });
  }

  /** Inspects the latest foreground query without starting reads or changing cache priority. */
  getDebugState(): ZarrDebugState | undefined {
    const debug = this.debug;
    if (!debug) {
      return undefined;
    }
    if (!debug.chunks) {
      debug.chunks = [];
      this.tiles(debug.frameIndex, debug.matrix, debug.clip, debug.chunks);
    }
    return {
      frameIndex: debug.frameIndex,
      geometry: this.source.geometry,
      volumeToClip: debug.matrix,
      cacheBytes: this.cache.byteLength,
      maxCacheBytes: this.source.maxCacheBytes,
      reusedView: debug.reusedView,
      chunks: debug.chunks.map((chunk) => {
        const status = this.cache.getStatus(chunk.id);
        return {
          ...chunk,
          status: !chunk.selected
            ? 'outside'
            : debug.cached.has(chunk.id)
              ? 'cached'
              : debug.loaded.has(chunk.id)
                ? 'ready'
                : (debug.failure ??
                  (status === 'missing' ? 'queued' : status === 'cached' ? 'ready' : status)),
        };
      }),
    };
  }

  /** Clears cached chunks and cancels this reader's pending reads */
  dispose(): void {
    this.disposed = true;
    this.lastView = undefined;
    this.debug = undefined;
    this.cache.clear();
  }

  /**
   * Loads chunks overlapping the camera and clip bounds, reusing cached chunks first
   * Each progress callback receives its own values array, which later reads do not change
   * Progress snapshots are spaced by at least PROGRESS_INTERVAL_MS to limit full-grid copies
   * The returned promise resolves with the completed selection, including NaN outside it
   * @param kind - Whole-frame reads keep foreground priority without replacing camera diagnostics
   */
  async read(
    index: number,
    options: ZarrViewOptions,
    kind: 'view' | 'frame' = 'view',
  ): Promise<VoxelData> {
    const { signal, volumeToClip } = options;
    signal.throwIfAborted();
    if (this.disposed) {
      throw new Error('The Zarr reader has been disposed.');
    }
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.source.frameCount) {
      throw new Error('Time index is outside the Zarr field.');
    }
    if (volumeToClip.length !== 16 || !Array.from(volumeToClip).every(Number.isFinite)) {
      throw new Error('volumeToClip must contain sixteen finite values.');
    }
    const clip = options.clipBounds ?? [0, 0, 0, 1, 1, 1];
    if (
      clip.length !== 6 ||
      !Array.from(clip).every((value) => Number.isFinite(value) && value >= 0 && value <= 1) ||
      XYZ.some((axis) => clip[axis] > (clip[axis + 3] ?? 1))
    ) {
      throw new Error('View clipBounds must be ordered normalized bounds.');
    }
    const debug: DebugView | undefined =
      kind === 'view' && (options.priority ?? 0) < BACKGROUND_PRIORITY
        ? {
            frameIndex: index,
            chunks: undefined,
            matrix: Array.from(volumeToClip),
            clip: Array.from(clip),
            cached: new Set<string>(),
            loaded: new Set<string>(),
            reusedView: false,
            failure: undefined,
          }
        : undefined;
    const tiles = this.tiles(index, volumeToClip, clip);
    if (debug) {
      for (const tile of tiles) {
        if (this.cache.has(tile.key)) {
          debug.cached.add(tile.key);
        }
      }
      this.debug = debug;
    }
    const key = `${index}:${tiles
      .map((tile) => tile.key)
      .sort()
      .join(';')}`;
    if (this.lastView?.key === key) {
      if (debug) {
        debug.reusedView = true;
        for (const tile of tiles) {
          debug.loaded.add(tile.key);
        }
      }
      return this.lastView.volume;
    }
    const [width, height, depth] = this.source.dimensions;
    const values = new Float32Array(width * height * depth).fill(Number.NaN);
    const available = this.source.grid ? new Uint8Array(values.length) : undefined;
    const snapshot = (): VoxelData =>
      this.source.grid
        ? projectFrame(
            { data: values, shape: [depth, height, width], stride: [width * height, width, 1] },
            this.source.grid,
            this.source.noDataValue,
            available,
          )
        : {
            ...this.source.geometry,
            values: values.slice(),
            ...(this.source.noDataValue !== undefined && { noDataValue: this.source.noDataValue }),
          };
    const work = new AbortController();
    const readSignal = AbortSignal.any([signal, work.signal]);
    let lastPublish = Number.NEGATIVE_INFINITY;
    const load = async (tile: Tile): Promise<void> => {
      const chunk = await this.cache.read(
        tile.key,
        readSignal,
        (options.priority ?? 0) + tile.priority,
      );
      readSignal.throwIfAborted();
      this.copy(chunk, tile, index, values, available);
      debug?.loaded.add(tile.key);
    };
    const publish = (): void => {
      if (options.onProgress) {
        options.onProgress(snapshot());
        lastPublish = performance.now();
      }
    };
    try {
      const cached = tiles.filter((tile) => this.cache.has(tile.key));
      const missing = tiles.filter((tile) => !this.cache.has(tile.key));
      await Promise.all(cached.map(load));
      readSignal.throwIfAborted();
      if (cached.length > 0 && missing.length > 0) {
        publish();
      }
      await Promise.all(
        missing.map(async (tile) => {
          await load(tile);
          if (performance.now() - lastPublish >= PROGRESS_INTERVAL_MS) {
            publish();
          }
        }),
      );
      readSignal.throwIfAborted();
      const volume = snapshot();
      if ((options.priority ?? 0) < BACKGROUND_PRIORITY) {
        this.lastView = { key, volume };
      }
      return volume;
    } catch (error) {
      if (debug) {
        debug.failure = signal.aborted ? 'cancelled' : 'error';
      }
      work.abort();
      throw error;
    }
  }

  private tiles(
    index: number,
    matrix: readonly number[],
    clip: readonly number[],
    debug?: Omit<ZarrDebugChunk, 'status'>[],
  ): Tile[] {
    const transform = new Matrix4(matrix);
    const { dimensions, axes, array, selection } = this.source;
    const [width, height, depth] = dimensions;
    const fixed = axes.map((axis, dimension) =>
      axis === 'time' ? index : axis === null ? (selection[dimension] ?? 0) : 0,
    );
    const result: Tile[] = [];
    if (XYZ.some((axis) => clip[axis] === clip[axis + 3])) {
      return result;
    }
    for (let z = 0; z < depth; z += this.chunkSize[2]) {
      for (let y = 0; y < height; y += this.chunkSize[1]) {
        for (let x = 0; x < width; x += this.chunkSize[0]) {
          const start: Vector3 = [x, y, z];
          const end: Vector3 = [
            Math.min(width, x + this.chunkSize[0]),
            Math.min(height, y + this.chunkSize[1]),
            Math.min(depth, z + this.chunkSize[2]),
          ];
          const xr = this.columns[Math.floor(x / this.chunkSize[0])];
          const yr = this.rows[Math.floor(y / this.chunkSize[1])];
          if (!xr || !yr) {
            throw new Error('Chunk geometry does not match the volume.');
          }
          if (xr[0] >= xr[1] || yr[0] >= yr[1]) {
            continue;
          }
          // Include one source cell beyond each chunk so interpolation near its edges stays selected
          const min: Vector3 = [xr[0] - 1 / width, yr[0] - 1 / height, (z - 1) / depth];
          const max: Vector3 = [xr[1] + 1 / width, yr[1] + 1 / height, (end[2] + 1) / depth];
          const selected =
            !XYZ.some(
              (axis) => max[axis] < (clip[axis] ?? 0) || min[axis] > (clip[axis + 3] ?? 1),
            ) && volumeBoxVisible(min, max, transform);
          if (!selected && !debug) {
            continue;
          }
          const coords = fixed.map((value, dimension) =>
            Math.floor(value / (array.chunks[dimension] ?? 1)),
          );
          for (const position of XYZ) {
            coords[this.spatialAxes[position]] = Math.floor(
              start[position] / this.chunkSize[position],
            );
          }
          const center: Vector3 = [
            (min[0] + max[0]) / 2,
            (min[1] + max[1]) / 2,
            (min[2] + max[2]) / 2,
          ];
          const projected = transform.transform([...center, 1]);
          const distance =
            Math.hypot(projected[0] ?? 0, projected[1] ?? 0) / (Math.abs(projected[3] ?? 0) || 1);
          const key = coords.join(',');
          const priority = Math.min(MAX_VISIBLE_READ_PRIORITY, distance);
          debug?.push({
            id: key,
            min: [xr[0], yr[0], z / depth],
            max: [xr[1], yr[1], end[2] / depth],
            selected,
            priority,
          });
          if (selected) {
            result.push({ key, start, end, priority });
          }
        }
      }
    }
    return result.sort((left, right) => left.priority - right.priority);
  }

  private copy(
    chunk: Chunk<'float32'>,
    tile: Tile,
    index: number,
    values: Float32Array,
    available: Uint8Array | undefined,
  ): void {
    const { axes, array, selection, dimensions } = this.source;
    if (chunk.stride.length !== axes.length) {
      throw new Error('Decoded Zarr chunk has an unexpected rank.');
    }
    const fixed = axes.reduce((offset, axis, dimension) => {
      const size = array.chunks[dimension];
      const stride = chunk.stride[dimension];
      if (size === undefined || stride === undefined) {
        throw new Error('Decoded Zarr chunk is missing a dimension.');
      }
      const value = axis === 'time' ? index : axis === null ? (selection[dimension] ?? 0) : 0;
      return offset + (value % size) * stride;
    }, 0);
    const strides = this.spatialAxes.map((axis) => chunk.stride[axis]);
    const [sx, sy, sz] = strides;
    if (sx === undefined || sy === undefined || sz === undefined) {
      throw new Error('Decoded Zarr chunk is missing spatial strides.');
    }
    for (let z = tile.start[2]; z < tile.end[2]; z++) {
      for (let y = tile.start[1]; y < tile.end[1]; y++) {
        for (let x = tile.start[0]; x < tile.end[0]; x++) {
          const offset =
            fixed + (x - tile.start[0]) * sx + (y - tile.start[1]) * sy + (z - tile.start[2]) * sz;
          const target = x + dimensions[0] * (y + dimensions[1] * z);
          values[target] = chunk.data[offset] ?? Number.NaN;
          if (available) {
            available[target] = 1;
          }
        }
      }
    }
  }
}
