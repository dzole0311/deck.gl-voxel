import type { Viewport } from '@deck.gl/core';
import { type GeoZarrMetadata, parseGeoZarrMetadata } from '@developmentseed/geozarr';
import { Matrix4 } from '@math.gl/core';
import { lngLatToWorld, unitsPerMeter, worldToLngLat } from '@math.gl/web-mercator';
import {
  type CellClipBounds,
  type CellGrid,
  type CellMesh,
  displayElevation,
  getCellMeshBounds,
  prepareCellMesh,
  type Vector3,
  type VoxelGeometry,
} from 'deck.gl-voxel';
import {
  type AsyncReadable,
  type Chunk,
  type DataType,
  defineArrayExtension,
  get,
  open,
  root,
  slice,
  type Array as ZarrArray,
} from 'zarrita';
import { ChunkCache } from '../cache/chunk-cache.js';
import {
  createZarrStore,
  readConsolidatedCatalog,
  record,
  type ZarrStoreInput,
} from '../storage/zarr-store.js';
import type { ZarrDebugChunk, ZarrDebugState } from './diagnostics.js';

const MERCATOR_TO_COMMON = 512 / (2 * Math.PI * 6378137);
const TILE_SIZE = 128;

/** Field group path and its relative paths for physical Z, ground elevations and native validity. */
export interface GeoZarrFieldOptions {
  readonly path: string;
  readonly verticalCoordinates: string;
  readonly groundElevation: string;
  readonly validity: string;
}

/** One field's grid metadata, with common X/Y coordinates and physical-meter Z coordinates. */
export interface GeoZarrCollectionField {
  readonly path: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly metadata: GeoZarrMetadata;
  readonly dimensions: Vector3;
  readonly origin: Vector3;
  readonly spacing: Vector3;
  readonly groundRange: readonly [number, number];
  readonly options: GeoZarrFieldOptions;
}

/**
 * A displayed native XY tile, replaced as its stored values refine.
 * Bounds use displayed common XYZ at the current exaggeration. Treat mesh arrays as immutable.
 */
export interface GeoZarrCollectionTile {
  readonly id: string;
  readonly field: GeoZarrCollectionField;
  readonly x: number;
  readonly y: number;
  readonly level: number;
  readonly mesh: CellMesh;
  readonly bounds: readonly [number, number, number, number, number, number];
}

interface Selection {
  id: string;
  field: GeoZarrCollectionField;
  x: number;
  y: number;
  level: number;
  priority: number;
}
interface Pending {
  controller: AbortController;
  key: string;
}

/** Concurrency and retained CPU budgets; displayed GPU buffers are reported separately by the application. */
interface CollectionSettings {
  readonly bins: number;
  readonly valueRange: readonly [number, number];
  /**
   * Retained decoded chunk bytes, excluding in-flight reads.
   * @default 201326592
   */
  readonly maxCacheBytes?: number;
  /**
   * Retained prepared mesh bytes; displayed tiles remain pinned.
   * @default 268435456
   */
  readonly maxMeshBytes?: number;
  /**
   * Concurrent logical chunk reads, including shared scalar and coverage requests.
   * @default 6
   */
  readonly maxRequests?: number;
  readonly fetch?: (request: Request) => Promise<Response>;
  /** Cancels opening and subsequent reads; disposal removes this subscription. */
  readonly signal?: AbortSignal;
}

/** Field selection, display bins and bounded reads for a GeoZarr collection. */
export type GeoZarrCollectionOptions = CollectionSettings &
  (
    | { readonly fields: readonly GeoZarrFieldOptions[] }
    | {
        readonly field: string;
        readonly verticalCoordinates: string;
        readonly groundElevation: string;
        readonly validity: string;
      }
  );

/**
 * Retained CPU memory and tile-loading totals, excluding decoding in progress and GPU copies.
 * Active counts tile loads. Queued counts visible tiles awaiting their desired level, including active loads.
 */
export interface GeoZarrCollectionStats {
  readonly active: number;
  readonly queued: number;
  readonly cacheBytes: number;
  readonly meshBytes: number;
  readonly prepared: number;
  readonly preparationMs: number;
  readonly cacheHits: number;
  readonly errors: readonly string[];
  readonly budgetLimited: boolean;
}

/**
 * Reads only the consolidated catalog so apps can present field labels before opening a source.
 * Supply the same fetch implementation as GeoZarrCollection.open for authentication or custom transport.
 */
export async function discoverGeoZarrFields(
  input: ZarrStoreInput,
  options: Pick<GeoZarrCollectionOptions, 'signal' | 'fetch'> = {},
): Promise<readonly { path: string; attributes: Record<string, unknown> }[]> {
  const signal = options.signal ?? new AbortController().signal;
  const { nodes } = await readConsolidatedCatalog(
    createZarrStore(input, {
      signal,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      retry: true,
    }),
    signal,
  );
  if (!nodes) {
    throw new Error(
      'Field discovery requires consolidated Zarr v3 metadata. Supply field paths when opening the collection.',
    );
  }
  return Object.entries(nodes).flatMap(([path, node]) =>
    record(node) && record(node.attributes) && record(node.attributes.multiscales)
      ? [{ path, attributes: node.attributes }]
      : [],
  );
}

/** Picks a stored XY level from the local projected native-cell size, with a stable transition band. */
export function selectOverviewLevel(pixelSize: number, levels: number, previous?: number): number {
  const target = Math.max(
    0,
    Math.min(levels - 1, Math.floor(Math.log2(2 / Math.max(pixelSize, 1e-8)))),
  );
  if (previous !== undefined && previous >= 0 && previous < levels) {
    const size = pixelSize * 2 ** previous;
    if (size >= 1.25 && size <= 3) {
      return previous;
    }
  }
  return target;
}

/**
 * Owns GeoZarr metadata, native masks, overview selection, bounded reads, retained meshes and refinement.
 * Lexicographically first selected field with a valid physical cell owns overlaps, before filtering.
 * Call dispose to cancel reads and release retained CPU data. Layers own their GPU resources.
 */
export class GeoZarrCollection {
  private readonly lifetime = new AbortController();
  private readonly arrayReads = new Map<string, Promise<ZarrArray<DataType>>>();
  private readonly arrays = new Map<string, ZarrArray<DataType>>();
  private readonly chunkKeys = new Map<string, { array: ZarrArray<DataType>; coords: number[] }>();
  private readonly chunks: ChunkCache<string, Chunk<DataType>>;
  private readonly meshCache = new Map<string, GeoZarrCollectionTile>();
  private readonly displayed = new Map<string, GeoZarrCollectionTile>();
  private readonly pending = new Map<string, Pending>();
  private selections = new Map<string, Selection>();
  private readonly levelHistory = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private readonly failures = new Map<
    string,
    { count: number; retryAt: number; message: string }
  >();
  private meshBytes = 0;
  private prepared = 0;
  private preparationMs = 0;
  private cacheHits = 0;
  private viewport: Viewport | undefined;
  private exaggeration = 1;
  private selectedFields = new Set<string>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private frameRequest: number | undefined;
  private pumpQueued = false;
  private paused = false;
  private readonly cacheArray;

  private constructor(
    private readonly store: AsyncReadable,
    readonly fields: readonly GeoZarrCollectionField[],
    private readonly options: GeoZarrCollectionOptions,
    private readonly metadataLifetime: AbortController,
    private readonly transport: { controller: AbortController },
  ) {
    this.chunks = new ChunkCache({
      maxBytes: options.maxCacheBytes ?? 192 * 1048576,
      maxRequests: options.maxRequests ?? 6,
      load: async (key, signal) => {
        const query = this.chunkKeys.get(key);
        if (!query) {
          throw new Error('Unknown GeoZarr chunk key.');
        }
        return query.array.getChunk(query.coords, { signal });
      },
      byteLength: (chunk) => (ArrayBuffer.isView(chunk.data) ? chunk.data.byteLength : 0),
    });
    this.cacheArray = defineArrayExtension((array) => ({
      getChunk: (coords: number[], request?: { signal?: AbortSignal }) => {
        const signal = request?.signal ?? this.lifetime.signal;
        signal.throwIfAborted();
        const key = `${array.path}:${coords.join(',')}`;
        this.chunkKeys.set(key, { array, coords });
        return this.chunks.read(key, signal);
      },
    }));
    this.selectedFields = new Set(fields.map((f) => f.path));
    options.signal?.addEventListener('abort', () => this.dispose(), {
      once: true,
      signal: this.lifetime.signal,
    });
  }

  /**
   * Opens north-up, pixel-registered Web Mercator fields with uniform positive-up meter Z coordinates.
   * Coordinate arrays are read in sequence to bound startup I/O.
   */
  static async open(
    input: ZarrStoreInput,
    options: GeoZarrCollectionOptions,
  ): Promise<GeoZarrCollection> {
    if (
      !Number.isInteger(options.bins) ||
      options.bins < 1 ||
      options.bins > 32 ||
      !options.valueRange.every(Number.isFinite) ||
      options.valueRange[0] >= options.valueRange[1] ||
      (options.maxMeshBytes !== undefined &&
        (!Number.isSafeInteger(options.maxMeshBytes) || options.maxMeshBytes <= 0))
    ) {
      throw new Error(
        'Cell sources require 1–32 bins, an increasing finite value range and a positive mesh-cache budget.',
      );
    }
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    const transport = { controller: new AbortController() };
    const { store, nodes } = await readConsolidatedCatalog(
      createZarrStore(input, {
        signal,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        readSignal: () => transport.controller.signal,
        retry: true,
      }),
      signal,
    );
    const fields: GeoZarrCollectionField[] = [];
    const selected = 'fields' in options ? options.fields : selectFields(options, nodes);
    for (const config of Array.from(selected).sort((a, b) => a.path.localeCompare(b.path))) {
      const node = await open.v3(root(store).resolve(config.path), { kind: 'group', signal });
      const metadata = parseGeoZarrMetadata(node.attrs);
      const native = metadata.levels[0];
      if (
        !native ||
        metadata.crs.code !== 'EPSG:3857' ||
        metadata.registration !== 'pixel' ||
        metadata.axes.join(',') !== 'y,x' ||
        native.affine[1] !== 0 ||
        native.affine[3] !== 0 ||
        native.affine[0] <= 0 ||
        native.affine[4] >= 0
      ) {
        throw new Error(
          'Opaque GeoZarr collections currently require north-up, pixel-registered EPSG:3857 XY grids.',
        );
      }
      for (const [i, level] of metadata.levels.entries()) {
        if (
          level.affine[0] !== native.affine[0] * 2 ** i ||
          level.affine[4] !== native.affine[4] * 2 ** i ||
          level.affine[2] !== native.affine[2] ||
          level.affine[5] !== native.affine[5]
        ) {
          throw new Error('Stored levels must share an aligned dyadic XY grid.');
        }
      }
      const coordinates = await open.v3(
        root(store).resolve(`/${config.path}/${config.verticalCoordinates}`),
        { kind: 'array' },
      );
      if (
        !(coordinates.is('float32') || coordinates.is('float64')) ||
        coordinates.attrs.units !== 'm' ||
        coordinates.attrs.positive !== 'up'
      ) {
        throw new Error('Expected physical positive-up meter coordinates.');
      }
      const z = await get(coordinates, null, { signal });
      const first = z.data[0],
        second = z.data[1];
      if (
        first === undefined ||
        second === undefined ||
        !Number.isFinite(first) ||
        !Number.isFinite(second) ||
        first === second ||
        !z.data.every((v, i) => Math.abs(v - first - i * (second - first)) < 1e-5)
      ) {
        throw new Error('Vertical cell centers must be uniform.');
      }
      const ground = await open.v3(
        root(store).resolve(`${config.path}/${config.groundElevation}`),
        {
          kind: 'array',
          signal,
        },
      );
      const range = ground.attrs.actual_range;
      if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite)) {
        throw new Error(
          'Ground elevation requires an actual_range for conservative view selection.',
        );
      }
      fields.push({
        path: config.path,
        attributes: node.attrs,
        metadata,
        options: config,
        dimensions: [native.arrayWidth, native.arrayHeight, z.data.length],
        origin: [
          (native.affine[2] + Math.PI * 6378137) * MERCATOR_TO_COMMON,
          (native.affine[5] + Math.PI * 6378137) * MERCATOR_TO_COMMON,
          first - (second - first) / 2,
        ],
        spacing: [
          native.affine[0] * MERCATOR_TO_COMMON,
          native.affine[4] * MERCATOR_TO_COMMON,
          second - first,
        ],
        groundRange: [Number(range[0]), Number(range[1])],
      });
    }
    return new GeoZarrCollection(store, fields, options, controller, transport);
  }

  /** Returns displayed tiles, including useful older values while a replacement is pending. */
  getTiles(): readonly GeoZarrCollectionTile[] {
    return [...this.displayed.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  /**
   * Captures the displayed grids for a batch of ground lookups without starting reads.
   * The returned function takes longitude and latitude in degrees and returns physical meters,
   * or undefined outside loaded grids. It uses the first finite ground value in field-path order.
   * Later refinement or field selection does not change this snapshot.
   * Release the sampler after its batch so its referenced grids can be freed.
   */
  createGroundSampler(): (longitude: number, latitude: number) => number | undefined {
    const grids = this.getTiles().map((tile) => tile.mesh.grid);
    return (longitude, latitude) => {
      const point = lngLatToWorld([longitude, latitude]);
      for (const grid of grids) {
        const x = Math.floor(((point[0] ?? 0) - grid.origin[0]) / grid.spacing[0]),
          y = Math.floor(((point[1] ?? 0) - grid.origin[1]) / grid.spacing[1]);
        if (x >= 0 && y >= 0 && x < grid.dimensions[0] && y < grid.dimensions[1]) {
          const ground = grid.ground[x + grid.dimensions[0] * y];
          if (ground !== undefined && Number.isFinite(ground)) {
            return ground;
          }
        }
      }
      return undefined;
    };
  }
  /** Subscribes to batched progress; returned function removes the listener. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Current retained CPU usage and preparation totals, excluding in-flight decoding and GPU copies. */
  getStats(): GeoZarrCollectionStats {
    return {
      active: this.pending.size,
      queued: this.paused
        ? 0
        : [...this.selections.values()].filter(
            (s) => !this.displayed.has(s.id) || this.displayed.get(s.id)?.level !== s.level,
          ).length,
      cacheBytes: this.chunks.byteLength,
      meshBytes: this.meshBytes,
      prepared: this.prepared,
      preparationMs: this.preparationMs,
      cacheHits: this.cacheHits,
      errors: [...this.failures.values()].map((e) => e.message),
      budgetLimited: this.meshBytes > (this.options.maxMeshBytes ?? 256 * 1048576),
    };
  }

  /**
   * Cancels reads and retries while retaining decoded chunks, meshes and known array metadata.
   * Resuming reopens array readers and loads the latest view.
   */
  setPaused(paused: boolean): void {
    if (this.lifetime.signal.aborted || paused === this.paused) {
      return;
    }
    this.paused = paused;
    if (paused) {
      for (const pending of this.pending.values()) {
        pending.controller.abort();
      }
      this.pending.clear();
      this.transport.controller.abort();
      this.arrayReads.clear();
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
      }
    } else {
      this.transport.controller = new AbortController();
      this.pump();
    }
    this.notify();
  }

  /**
   * Updates visible tiles using common-space bounds and the current camera.
   * Detail selection checks near and distant parts of pitched footprints, using both horizontal cell edges.
   * Useful intermediate loads may finish while the camera moves; off-screen loads are cancelled.
   */
  update(
    viewport: Viewport,
    exaggeration: number,
    fields: ReadonlySet<string> = this.selectedFields,
  ): void {
    if (this.lifetime.signal.aborted) {
      return;
    }
    if (!Number.isFinite(exaggeration) || exaggeration <= 0) {
      throw new Error('Display exaggeration must be finite and positive.');
    }
    const changedFields =
      fields.size !== this.selectedFields.size ||
      [...fields].some((f) => !this.selectedFields.has(f));
    if (changedFields) {
      for (const p of this.pending.values()) {
        p.controller.abort();
      }
      this.pending.clear();
      this.meshCache.clear();
      this.meshBytes = 0;
      this.displayed.clear();
      this.failures.clear();
    }
    this.viewport = viewport;
    if (exaggeration !== this.exaggeration) {
      for (const [key, tile] of this.meshCache) {
        this.meshCache.set(key, { ...tile, bounds: getCellMeshBounds(tile.mesh, exaggeration) });
      }
      for (const [id, tile] of this.displayed) {
        this.displayed.set(
          id,
          this.meshCache.get(`${id}@${tile.level}`) ?? {
            ...tile,
            bounds: getCellMeshBounds(tile.mesh, exaggeration),
          },
        );
      }
    }
    this.exaggeration = exaggeration;
    this.selectedFields = new Set(fields);
    const next = new Map<string, Selection>();
    for (const field of this.fields) {
      if (!fields.has(field.path)) {
        continue;
      }
      for (let y = 0; y < field.dimensions[1]; y += TILE_SIZE) {
        for (let x = 0; x < field.dimensions[0]; x += TILE_SIZE) {
          const id = `${field.path}/${x},${y}`;
          const bounds = this.tileBounds(field, x, y);
          if (!inView(bounds, viewport)) {
            continue;
          }
          const cx = (bounds[0] + bounds[3]) / 2,
            cy = (bounds[1] + bounds[4]) / 2,
            cz = (bounds[2] + bounds[5]) / 2;
          const matrix = new Matrix4(viewport.viewProjectionMatrix);
          const center: Vector3 = [cx, cy, cz];
          const p = matrix.transformAsPoint(center);
          let pixel = projectedCellSize(matrix, center, field.spacing, viewport);
          for (const fx of [0, 0.5, 1]) {
            for (const fy of [0, 0.5, 1]) {
              const point: Vector3 = [
                bounds[0] + (bounds[3] - bounds[0]) * fx,
                bounds[1] + (bounds[4] - bounds[1]) * fy,
                bounds[5],
              ];
              const clip = matrix.transform([...point, 1]);
              if ((clip[3] ?? 0) <= 0) {
                continue;
              }
              pixel = Math.max(pixel, projectedCellSize(matrix, point, field.spacing, viewport));
            }
          }
          const level = selectOverviewLevel(
            pixel,
            field.metadata.levels.length,
            this.levelHistory.get(id),
          );
          const priority = (p[0] ?? 0) ** 2 + (p[1] ?? 0) ** 2;
          next.set(id, { id, field, x, y, level, priority });
          this.levelHistory.set(id, level);
        }
      }
    }
    this.selections = next;
    for (const [id, tile] of this.displayed) {
      if (!next.has(id)) {
        this.displayed.delete(id);
      } else {
        this.touch(tile);
      }
    }
    for (const [id, p] of this.pending) {
      if (!next.has(id)) {
        p.controller.abort();
        this.pending.delete(id);
      }
    }
    this.pump();
    this.notify();
  }

  private tileBounds(
    field: GeoZarrCollectionField,
    x: number,
    y: number,
  ): [number, number, number, number, number, number] {
    const a = field.origin,
      s = field.spacing;
    const scale = unitsPerMeter(worldToLngLat([a[0], a[1] + y * s[1]])[1]);
    const z0 = Math.min(a[2], a[2] + field.dimensions[2] * s[2]),
      z1 = Math.max(a[2], a[2] + field.dimensions[2] * s[2]);
    return [
      a[0] + x * s[0],
      a[1] + Math.min(y + TILE_SIZE, field.dimensions[1]) * s[1],
      displayElevation(z0, field.groundRange[1], this.exaggeration) * scale,
      a[0] + Math.min(x + TILE_SIZE, field.dimensions[0]) * s[0],
      a[1] + y * s[1],
      displayElevation(z1, field.groundRange[0], this.exaggeration) * scale,
    ];
  }

  private pump(): void {
    if (this.lifetime.signal.aborted || this.paused) {
      return;
    }
    for (const s of [...this.selections.values()].sort((a, b) => a.priority - b.priority)) {
      const existing = this.displayed.get(s.id);
      if (this.pending.has(s.id) || existing?.level === s.level) {
        continue;
      }
      const desired = this.meshCache.get(`${s.id}@${s.level}`);
      if (desired) {
        this.cacheHits++;
        this.displayed.set(s.id, desired);
        this.touch(desired);
        this.notify();
        continue;
      }
      const level = existing ? s.level : Math.min(s.level + 2, s.field.metadata.levels.length - 1);
      const key = `${s.id}@${level}`;
      const cached = this.meshCache.get(key);
      if (cached) {
        this.cacheHits++;
        this.displayed.set(s.id, cached);
        this.touch(cached);
        this.notify();
        if (!this.pumpQueued) {
          this.pumpQueued = true;
          queueMicrotask(() => {
            this.pumpQueued = false;
            this.pump();
          });
        }
        continue;
      }
      if (this.pending.size >= 3) {
        continue;
      }
      const failure = this.failures.get(key);
      if (failure && failure.retryAt > Date.now()) {
        continue;
      }
      const controller = new AbortController();
      const p = { controller, key };
      this.pending.set(s.id, p);
      void this.load(s, level, controller.signal)
        .then((tile) => {
          if (controller.signal.aborted || !this.selections.has(s.id)) {
            return;
          }
          this.failures.delete(key);
          this.meshCache.set(key, tile);
          this.meshBytes += tile.mesh.bytes;
          this.displayed.set(s.id, tile);
          this.evict();
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            const count = (this.failures.get(key)?.count ?? 0) + 1;
            this.failures.set(key, {
              count,
              retryAt: Date.now() + Math.min(30_000, 1000 * 2 ** count),
              message: error instanceof Error ? error.message : String(error),
            });
          }
        })
        .finally(() => {
          if (this.pending.get(s.id) === p) {
            this.pending.delete(s.id);
          }
          this.pump();
          this.notify();
        });
    }
    if (!this.retryTimer) {
      const retryAt = Math.min(
        ...[...this.failures]
          .filter(
            ([key, failure]) =>
              failure.retryAt > Date.now() && this.selections.has(key.split('@')[0] ?? ''),
          )
          .map(([, failure]) => failure.retryAt),
      );
      if (Number.isFinite(retryAt)) {
        this.retryTimer = setTimeout(
          () => {
            this.retryTimer = undefined;
            this.pump();
          },
          Math.max(1, retryAt - Date.now()),
        );
      }
    }
  }

  private async array(path: string): Promise<ZarrArray<DataType>> {
    let pending = this.arrayReads.get(path);
    if (!pending) {
      pending = open.v3(root(this.store).resolve(`/${path}`), { kind: 'array' }).then((array) => {
        this.arrays.set(path, array);
        return this.cacheArray(array);
      });
      this.arrayReads.set(path, pending);
    }
    return pending;
  }

  private async region(
    path: string,
    bounds: readonly (readonly [number, number])[],
    signal: AbortSignal,
  ) {
    const array = await this.array(path);
    signal.throwIfAborted();
    if (array.dimensionNames?.join(',') !== (bounds.length === 3 ? 'z,y,x' : 'y,x')) {
      throw new Error(`Expected named ZYX scalars and YX ground coordinates: ${path}`);
    }
    if (!(array.is('float32') || array.is('uint8'))) {
      throw new Error(`Unsupported cell array ${path}`);
    }
    return get(
      array,
      bounds.map(([a, b]) => slice(a, b)),
      { signal },
    );
  }

  private async load(
    s: Selection,
    level: number,
    signal: AbortSignal,
  ): Promise<GeoZarrCollectionTile> {
    const f = s.field,
      w = Math.min(TILE_SIZE, f.dimensions[0] - s.x),
      h = Math.min(TILE_SIZE, f.dimensions[1] - s.y),
      d = f.dimensions[2],
      scale = 2 ** level;
    const [mask, values, ground] = await Promise.all([
      this.region(
        `${f.path}/${f.options.validity}`,
        [
          [0, d],
          [s.y, s.y + h],
          [s.x, s.x + w],
        ],
        signal,
      ),
      this.region(
        `${f.path}/${f.metadata.levels[level]?.path}`,
        [
          [0, d],
          [s.y / scale, Math.ceil((s.y + h) / scale)],
          [s.x / scale, Math.ceil((s.x + w) / scale)],
        ],
        signal,
      ),
      this.region(
        `${f.path}/${f.options.groundElevation}`,
        [
          [s.y, s.y + h],
          [s.x, s.x + w],
        ],
        signal,
      ),
    ]);
    if (
      !(mask.data instanceof Uint8Array) ||
      !(values.data instanceof Float32Array) ||
      !(ground.data instanceof Float32Array)
    ) {
      throw new Error('Unexpected cell scalar types.');
    }
    const validity = mask.data;
    for (const owner of this.fields) {
      if (owner.path >= f.path || !this.selectedFields.has(owner.path)) {
        continue;
      }
      const ox = Math.round(
        (f.origin[0] + s.x * f.spacing[0] - owner.origin[0]) / owner.spacing[0],
      );
      const oy = Math.round(
        (f.origin[1] + s.y * f.spacing[1] - owner.origin[1]) / owner.spacing[1],
      );
      const oz = Math.round(
        (f.origin[2] + f.spacing[2] / 2 - owner.origin[2] - owner.spacing[2] / 2) /
          owner.spacing[2],
      );
      const x0 = Math.max(0, ox),
        y0 = Math.max(0, oy),
        z0 = Math.max(0, oz),
        x1 = Math.min(owner.dimensions[0], ox + w),
        y1 = Math.min(owner.dimensions[1], oy + h),
        z1 = Math.min(owner.dimensions[2], oz + d);
      if (x0 >= x1 || y0 >= y1 || z0 >= z1) {
        continue;
      }
      if (f.spacing.some((v, i) => Math.abs(v - (owner.spacing[i] ?? 0)) > 1e-10)) {
        throw new Error('Overlapping collections must share native spacing.');
      }
      const other = await this.region(
        `${owner.path}/${owner.options.validity}`,
        [
          [z0, z1],
          [y0, y1],
          [x0, x1],
        ],
        signal,
      );
      for (let z = z0; z < z1; z++) {
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            if (other.data[x - x0 + (x1 - x0) * (y - y0 + (y1 - y0) * (z - z0))]) {
              validity[x - ox + w * (y - oy + h * (z - oz))] = 0;
            }
          }
        }
      }
    }
    const packed = new Uint8Array(Math.ceil(validity.length / 8));
    for (let i = 0; i < validity.length; i++) {
      if (validity[i]) {
        packed[i >> 3] = (packed[i >> 3] ?? 0) | (1 << (i & 7));
      }
    }
    const elevationScales = Float32Array.from({ length: h }, (_, y) =>
      unitsPerMeter(worldToLngLat([f.origin[0], f.origin[1] + (s.y + y + 0.5) * f.spacing[1]])[1]),
    );
    const grid: CellGrid = {
      dimensions: [w, h, d],
      origin: [f.origin[0] + s.x * f.spacing[0], f.origin[1] + s.y * f.spacing[1], f.origin[2]],
      spacing: f.spacing,
      values: values.data,
      valueDimensions: [Math.ceil(w / scale), Math.ceil(h / scale), d],
      valueScale: scale,
      validity: packed,
      validityBits: true,
      ground: ground.data,
      elevationScales,
    };
    const before = performance.now();
    const mesh = await prepareCellMesh(grid, this.options.bins, this.options.valueRange, signal);
    this.prepared++;
    this.preparationMs += performance.now() - before;
    return {
      id: s.id,
      field: f,
      x: s.x,
      y: s.y,
      level,
      mesh,
      bounds: getCellMeshBounds(mesh, this.exaggeration),
    };
  }

  private touch(tile: GeoZarrCollectionTile): void {
    const key = `${tile.id}@${tile.level}`;
    this.meshCache.delete(key);
    this.meshCache.set(key, tile);
  }
  private evict(): void {
    const limit = this.options.maxMeshBytes ?? 256 * 1048576;
    for (const [key, tile] of this.meshCache) {
      if (this.meshBytes <= limit) {
        break;
      }
      if (this.displayed.get(tile.id) !== tile) {
        this.meshCache.delete(key);
        this.meshBytes -= tile.mesh.bytes;
      }
    }
  }
  private notify(): void {
    if (this.frameRequest !== undefined || this.lifetime.signal.aborted) {
      return;
    }
    this.frameRequest = requestAnimationFrame(() => {
      this.frameRequest = undefined;
      for (const listener of this.listeners) {
        listener();
      }
    });
  }

  /** Normalizes real requested and displayed contributions in common space; clipped empty tiles have no outline. */
  getDebugState(clipBounds?: CellClipBounds): ZarrDebugState | undefined {
    if (!this.viewport || !this.selections.size) {
      return undefined;
    }
    const contributions = [...this.selections.values()].map((s) => {
      const tile = this.displayed.get(s.id);
      const requested = tile?.bounds ?? this.tileBounds(s.field, s.x, s.y);
      return {
        displayed:
          tile && clipBounds
            ? getCellMeshBounds(tile.mesh, this.exaggeration, undefined, clipBounds)
            : requested,
        requested,
        pending: this.pending.has(s.id),
      };
    });
    const envelope = contributions
      .flatMap((bounds) =>
        bounds.pending ? [bounds.displayed, bounds.requested] : [bounds.displayed],
      )
      .filter((box) => box[0] < box[3] && box[1] < box[4] && box[2] < box[5]);
    const min: Vector3 = envelope.length
      ? [
          Math.min(...envelope.map((box) => box[0])),
          Math.min(...envelope.map((box) => box[1])),
          Math.min(...envelope.map((box) => box[2])),
        ]
      : [0, 0, 0];
    const max: Vector3 = envelope.length
      ? [
          Math.max(...envelope.map((box) => box[3])),
          Math.max(...envelope.map((box) => box[4])),
          Math.max(...envelope.map((box) => box[5])),
        ]
      : min;
    const extent: Vector3 = [
      Math.max(1e-6, max[0] - min[0]),
      Math.max(1e-6, max[1] - min[1]),
      Math.max(1e-6, max[2] - min[2]),
    ];
    const geometry: VoxelGeometry = { dimensions: [1, 1, 1], origin: min, spacing: extent };
    const chunks: ZarrDebugChunk[] = [...this.selections.values()].flatMap((s, i) => {
      const tile = this.displayed.get(s.id),
        contribution = contributions[i],
        box = contribution?.displayed ?? this.tileBounds(s.field, s.x, s.y),
        requestedBox = contribution?.requested ?? box,
        p = this.pending.get(s.id);
      const result: ZarrDebugChunk[] = [];
      const levels = tile
        ? [tile.level, ...(p ? [Number(p.key.split('@')[1])] : [])]
        : [p ? Number(p.key.split('@')[1]) : s.level];
      for (const level of new Set(levels)) {
        const displayed = tile?.level === level;
        const levelBox = displayed ? box : requestedBox;
        const normalize = (start: number): Vector3 => [
          (Number(levelBox[start]) - min[0]) / extent[0],
          (Number(levelBox[start + 1]) - min[1]) / extent[1],
          (Number(levelBox[start + 2]) - min[2]) / extent[2],
        ];
        const path = `${s.field.path}/${s.field.metadata.levels[level]?.path}`;
        const array = this.arrays.get(path),
          [depth, rows, columns] = array?.chunks ?? [];
        if (!depth || !rows || !columns) {
          result.push({
            id: `${s.id} L${level} metadata`,
            min: normalize(0),
            max: normalize(3),
            selected: true,
            priority: s.priority,
            status: p ? 'loading' : 'queued',
          });
          continue;
        }
        const factor = 2 ** level,
          cy = Math.floor(s.y / factor / rows),
          cx = Math.floor(s.x / factor / columns);
        for (let z = 0; z < s.field.dimensions[2]; z += depth) {
          const chunkBounds = tile
            ? getCellMeshBounds(
                tile.mesh,
                this.exaggeration,
                [z, Math.min(z + depth, s.field.dimensions[2])],
                displayed ? clipBounds : undefined,
              )
            : levelBox;
          const toNormalized = (start: number): Vector3 => [
            (Number(chunkBounds[start]) - min[0]) / extent[0],
            (Number(chunkBounds[start + 1]) - min[1]) / extent[1],
            (Number(chunkBounds[start + 2]) - min[2]) / extent[2],
          ];
          const key = `/${path}:${z / depth},${cy},${cx}`;
          const state = this.chunks.getStatus(key);
          result.push({
            id: `${s.id} L${level} c/${z / depth}/${cy}/${cx}${displayed ? ' displayed' : ' pending'}`,
            min: toNormalized(0),
            max: toNormalized(3),
            selected: true,
            priority: s.priority,
            empty:
              displayed &&
              (chunkBounds[0] >= chunkBounds[3] ||
                chunkBounds[1] >= chunkBounds[4] ||
                chunkBounds[2] >= chunkBounds[5]),
            status: displayed
              ? 'ready'
              : state === 'loading'
                ? 'loading'
                : state === 'cached'
                  ? 'cached'
                  : this.failures.has(`${s.id}@${level}`)
                    ? 'error'
                    : 'queued',
            details: `${factor * (s.field.metadata.levels[0]?.affine[0] ?? 0)} source Mercator units per XY cell; ${displayed ? 'displayed' : 'requested'} scalar chunk ${path}/c/${z / depth}/${cy}/${cx}. Bounds show this tile’s native-mask contribution.`,
          });
        }
      }
      return result;
    });
    return {
      frameIndex: 0,
      geometry,
      volumeToClip: new Matrix4(this.viewport.viewProjectionMatrix).translate(min).scale(extent),
      chunks,
      cacheBytes: this.chunks.byteLength + this.meshBytes,
      maxCacheBytes:
        (this.options.maxCacheBytes ?? 192 * 1048576) +
        (this.options.maxMeshBytes ?? 256 * 1048576),
      reusedView: false,
    };
  }
  /** Cancels queued and active reads and releases all retained CPU grids. GPU resources belong to layers. */
  dispose(): void {
    this.lifetime.abort();
    this.metadataLifetime.abort();
    for (const p of this.pending.values()) {
      p.controller.abort();
    }
    this.pending.clear();
    this.chunks.clear();
    this.meshCache.clear();
    this.displayed.clear();
    this.meshBytes = 0;
    this.chunkKeys.clear();
    this.arrays.clear();
    this.arrayReads.clear();
    this.levelHistory.clear();
    this.selections.clear();
    this.failures.clear();
    this.listeners.clear();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
    if (this.frameRequest !== undefined) {
      cancelAnimationFrame(this.frameRequest);
    }
  }
}

/** Uses the larger projected horizontal cell edge so camera bearing does not hide needed detail. */
function projectedCellSize(
  matrix: Matrix4,
  point: Vector3,
  spacing: Vector3,
  viewport: Viewport,
): number {
  const screen = matrix.transformAsPoint(point);
  return Math.max(
    ...[
      [point[0] + spacing[0], point[1], point[2]],
      [point[0], point[1] + spacing[1], point[2]],
    ].map((adjacent) => {
      const projected = matrix.transformAsPoint(adjacent);
      return Math.hypot(
        (((screen[0] ?? 0) - (projected[0] ?? 0)) * viewport.width) / 2,
        (((screen[1] ?? 0) - (projected[1] ?? 0)) * viewport.height) / 2,
      );
    }),
  );
}

function inView(bounds: readonly number[], viewport: Viewport): boolean {
  const matrix = new Matrix4(viewport.viewProjectionMatrix),
    points: number[][] = [];
  for (const x of [bounds[0] ?? 0, bounds[3] ?? 0]) {
    for (const y of [bounds[1] ?? 0, bounds[4] ?? 0]) {
      for (const z of [bounds[2] ?? 0, bounds[5] ?? 0]) {
        points.push(Array.from(matrix.transform([x, y, z, 1])));
      }
    }
  }
  for (const axis of [0, 1, 2]) {
    for (const sign of [-1, 1]) {
      if (points.every((p) => (p[3] ?? 0) - sign * (p[axis] ?? 0) < 0)) {
        return false;
      }
    }
  }
  return true;
}

/** Expands a group prefix only when the catalog can enumerate its fields. */
function selectFields(
  options: Extract<GeoZarrCollectionOptions, { readonly field: string }>,
  nodes: Record<string, unknown> | undefined,
): readonly GeoZarrFieldOptions[] {
  const path = options.field.replace(/^\/+|\/+$/g, '').replace(/^\.$/, '');
  let paths = [path || '.'];
  if (nodes) {
    const fields = Object.entries(nodes).flatMap(([candidate, node]) =>
      record(node) && record(node.attributes) && record(node.attributes.multiscales)
        ? [candidate]
        : [],
    );
    paths = fields.includes(path)
      ? [path]
      : fields.filter((candidate) => !path || candidate.startsWith(`${path}/`));
    if (!paths.length) {
      throw new Error('No GeoZarr multiscale fields match the selected field or group.');
    }
  }
  return paths.map((path) => ({
    path,
    verticalCoordinates: options.verticalCoordinates,
    groundElevation: options.groundElevation,
    validity: options.validity,
  }));
}
