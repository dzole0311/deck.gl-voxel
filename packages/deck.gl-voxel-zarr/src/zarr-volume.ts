import type { Vector3, VoxelData } from 'deck.gl-voxel';
import { type Chunk, FetchStore, get, open, root, withRangeCoalescing } from 'zarrita';

import { hasGeoZarrMetadata, readGeoZarrField, readSpatialAttributes } from './geo-zarr-volume.js';
import { createProjectedGrid, projectFrame } from './projected-grid.js';

/** Labels for the stored array's dimensions. */
export type Axis = 'x' | 'y' | 'z' | 'time' | null;

/** Describes how to place a plain Zarr array in 3D. */
export interface ZarrVolumeLayout {
  /**
   * One label per dimension in the order used by the store. For example, an array shaped
   * [hours, levels, rows, columns] uses ['time', 'z', 'y', 'x']. Include X, Y and Z once each.
   * Use null for extra dimensions selected by a fixed index in {@link ZarrVolumeOptions.selection}.
   */
  readonly axes: readonly Axis[];

  /** The starting corner of the grid in XYZ order. This order stays fixed even if axes differ. */
  readonly origin: Vector3;

  /** Cell sizes in XYZ order. A negative size flips an axis. Use local units unless crs is set. */
  readonly spacing: Vector3;

  /**
   * Set to EPSG:4326 for a north-up longitude and latitude grid. X and Y then use degrees.
   * Z uses meters and increases upward. The reader puts the grid on a Web Mercator map.
   * @default Local Cartesian coordinates
   */
  readonly crs?: 'EPSG:4326';
}

/** Selects a Zarr array or a GeoZarr field. */
export interface ZarrVolumeOptions {
  /** Path to the array or GeoZarr field inside the store. Use '.' for the root. */
  readonly field: string;

  /**
   * Grid geometry for plain Zarr. Supply it when GeoZarr metadata doesn't describe the grid.
   */
  readonly layout?: ZarrVolumeLayout;

  /**
   * Path to the resolution level inside the GeoZarr field. Each level is a copy of the
   * same field with a different cell size, like the detail levels of a map tile pyramid.
   * @default The coarsest declared level
   */
  readonly level?: string;

  /** Name of the GeoZarr vertical dimension. Required for GeoZarr. */
  readonly verticalDimension?: string;

  /** Path inside the store to an array of evenly spaced cell heights or depths, in meters. */
  readonly verticalCoordinates?: string;

  /**
   * Set to 'up' for heights that grow upward or 'down' for depths that grow downward.
   * @default 'up'
   */
  readonly verticalPositive?: 'up' | 'down';

  /**
   * Maximum number of cells in one frame. Zarr stores data in blocks called chunks.
   * A chunk can include several times, so even a read for one frame can download extra data.
   * @default 2000000
   */
  readonly maxCells?: number;

  /**
   * Fixed indices keyed by zero-based stored dimension number, for example `{ 0: 2 }`
   * selects forecast run 2 on a leading null axis. Every null axis requires an index.
   * Spatial and time axes cannot be selected here.
   * @default {}
   */
  readonly selection?: Readonly<Record<number, number>>;

  /** Intercepts every metadata, coordinate, chunk and shard-range request. Preserve the request's Range header and signal. */
  readonly fetch?: (request: Request) => Promise<Response>;

  /** Cancels metadata and coordinate reads. Frame reads accept their own signal. */
  readonly signal?: AbortSignal;
}

/** An open field that can read one time step at a time. */
export interface ZarrVolume {
  /** Number of frames. An array with no time axis has one frame. */
  readonly frameCount: number;

  /** Selected level path relative to the field, or '.' when the field is an array. */
  readonly level: string;

  /**
   * Reads the whole grid for one time step. The returned array stores one X row after
   * another, then one XY plane after another along Z. Map grids use deck.gl's Web Mercator
   * coordinates.
   * @param index - Zero-based time index. Use zero for a field with no time axis.
   * @param signal - Cancels the read.
   * @returns A new array of values and the geometry needed to draw its cells.
   * @throws {Error} If the index is invalid or the read fails. Aborts reject with the signal reason.
   */
  readFrame(index: number, signal?: AbortSignal): Promise<VoxelData>;
}

const DEFAULT_MAX_CELLS = 2_000_000;

/**
 * Opens a float32 volume from a Zarr v2 or v3 store. This reads metadata and any needed
 * coordinates. Call readFrame to fetch the data values. GeoZarr metadata can tell us
 * where the grid sits on a map. With plain Zarr, put that information in layout.
 *
 * @param url - HTTP(S) store root. Cross-origin reads require CORS.
 * @param options - Field, grid geometry and frame size limit.
 * @returns A reader that fetches the stored blocks needed for each requested frame.
 * @throws {Error} If the field, geometry, or selected frame size is unsupported.
 * @see https://zarr-specs.readthedocs.io/en/latest/v3/core/index.html
 * @see https://geozarr.org/conventions.html
 */
export async function openZarrVolume(url: string, options: ZarrVolumeOptions): Promise<ZarrVolume> {
  const { field, layout, signal } = options;
  const maxCells = options.maxCells ?? DEFAULT_MAX_CELLS;

  if (!Number.isSafeInteger(maxCells) || maxCells < 1) {
    throw new Error('maxCells must be a positive safe integer.');
  }

  const location = root(
    withRangeCoalescing(
      new FetchStore(url, {
        useSuffixRequest: true,
        ...(options.fetch && { fetch: options.fetch }),
      }),
    ),
  );
  const openOptions = signal ? { signal } : {};
  const node = await open(location.resolve(field), openOptions);
  const attributes = await readSpatialAttributes(location, node, openOptions);
  const isGeoZarr = hasGeoZarrMetadata(attributes);

  if (isGeoZarr && layout) {
    throw new Error('GeoZarr supplies the grid layout. Remove the plain Zarr layout option.');
  }

  if (!isGeoZarr && (!layout || node.kind !== 'array')) {
    throw new Error(
      'Plain Zarr requires an array path and a layout with axes, origin, and spacing.',
    );
  }

  if (!isGeoZarr && options.level !== undefined) {
    throw new Error(
      'Select a plain Zarr array directly with field. The level option is for GeoZarr.',
    );
  }

  const geo = isGeoZarr ? await readGeoZarrField(node, attributes, options) : undefined;
  const array = geo?.array ?? node;
  const axes = geo?.axes ?? layout?.axes;

  if (array.kind !== 'array' || !array.is('float32') || !axes) {
    throw new Error('Expected a float32 Zarr array.');
  }

  const { dimensions, frameCount } = getFrameShape(
    array.shape,
    axes,
    maxCells,
    options.selection ?? {},
  );
  const [width, height, depth] = dimensions;

  if (geo && (width !== geo.level.arrayWidth || height !== geo.level.arrayHeight)) {
    throw new Error('GeoZarr spatial shape does not match the selected array.');
  }

  const grid = geo ? await geo.createGrid(depth) : layout && preparePlainGrid(layout, dimensions);
  const scalar = array;
  const fillValue = scalar.attrs._FillValue;
  const noDataValue = typeof fillValue === 'number' ? Math.fround(fillValue) : undefined;
  const spatialAxes = axes.filter((axis) => axis !== 'time' && axis !== null);
  const xAxis = spatialAxes.indexOf('x');
  const yAxis = spatialAxes.indexOf('y');
  const zAxis = spatialAxes.indexOf('z');

  return {
    frameCount,
    level: geo?.level.path ?? '.',
    /** {@inheritDoc ZarrVolume.readFrame} */
    async readFrame(index: number, frameSignal?: AbortSignal): Promise<VoxelData> {
      if (!Number.isSafeInteger(index) || index < 0 || index >= frameCount) {
        throw new Error('Time index is outside the Zarr field.');
      }

      frameSignal?.throwIfAborted();

      const selection = axes.map((axis, dimension) =>
        axis === 'time' ? index : axis === null ? (options.selection?.[dimension] ?? 0) : null,
      );
      const frame = await get(scalar, selection, frameSignal ? { signal: frameSignal } : {});
      const strideZ = frame.stride[zAxis];
      const strideY = frame.stride[yAxis];
      const strideX = frame.stride[xAxis];

      frameSignal?.throwIfAborted();

      if (strideZ === undefined || strideY === undefined || strideX === undefined) {
        throw new Error('Decoded Zarr frame does not have three spatial axes.');
      }

      const normalized: Chunk<'float32'> = {
        data: frame.data,
        shape: [depth, height, width],
        stride: [strideZ, strideY, strideX],
      };

      if (grid) {
        return projectFrame(normalized, grid, noDataValue);
      }

      return {
        values: copyToGridOrder(normalized, dimensions),
        dimensions,
        ...(layout && { origin: layout.origin, spacing: layout.spacing }),
        ...(noDataValue !== undefined && { noDataValue }),
      };
    },
  };
}

/** Options for the original GeoZarr-only entry point. */
export interface GeoZarrVolumeOptions extends ZarrVolumeOptions {
  /** Name of the vertical dimension on the array. */
  readonly verticalDimension: string;

  /** Store-relative path to the vertical coordinate array. */
  readonly verticalCoordinates: string;

  /** GeoZarr supplies the grid layout. */
  readonly layout?: never;
}

/** Return type of the original GeoZarr-only entry point. */
export type GeoZarrVolume = ZarrVolume;

/**
 * Opens a GeoZarr field through the shared reader.
 * @param url - HTTP(S) Zarr store root.
 * @param options - Field, overview, and vertical coordinates.
 * @returns A reader that fetches frames on demand.
 * @see {@link openZarrVolume}
 */
export function openGeoZarrVolume(
  url: string,
  options: GeoZarrVolumeOptions,
): Promise<GeoZarrVolume> {
  return openZarrVolume(url, options);
}

/**
 * Finds the grid size and checks its cell count before downloading data values.
 * @param shape - Lengths of the array dimensions in storage order.
 * @param axes - Labels for those dimensions in the same order.
 * @param maxCells - Maximum cells in one frame.
 * @param selection - Fixed indices for extra stored dimensions labeled null.
 * @returns Validated XYZ dimensions and time length.
 * @throws {Error} If the array shape, axis mapping, or frame size is unsupported.
 */
function getFrameShape(
  shape: readonly number[],
  axes: readonly Axis[],
  maxCells: number,
  selection: Readonly<Record<number, number>>,
): { dimensions: Vector3; frameCount: number } {
  const width = shape[axes.indexOf('x')];
  const height = shape[axes.indexOf('y')];
  const depth = shape[axes.indexOf('z')];
  const timeAxis = axes.indexOf('time');
  const frameCount = timeAxis === -1 ? 1 : shape[timeAxis];

  if (
    axes.length !== shape.length ||
    axes.filter((axis) => axis === 'x').length !== 1 ||
    axes.filter((axis) => axis === 'y').length !== 1 ||
    axes.filter((axis) => axis === 'z').length !== 1 ||
    axes.filter((axis) => axis === 'time').length > 1 ||
    width === undefined ||
    height === undefined ||
    depth === undefined ||
    frameCount === undefined ||
    !shape.every((size) => Number.isSafeInteger(size) && size > 0)
  ) {
    throw new Error('Expected three spatial axes and at most one time axis.');
  }

  for (const [dimension, index] of Object.entries(selection)) {
    const axisIndex = Number(dimension);
    const size = shape[axisIndex];
    if (
      !Number.isSafeInteger(axisIndex) ||
      size === undefined ||
      axes[axisIndex] !== null ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= size
    ) {
      throw new Error('Selection requires an in-range integer index on a null axis.');
    }
  }
  if (axes.some((axis, dimension) => axis === null && selection[dimension] === undefined)) {
    throw new Error('Every null axis requires a selection index.');
  }

  const cells = width * height * depth;

  if (!Number.isSafeInteger(cells) || cells > maxCells) {
    throw new Error(`Zarr frame requires ${cells} cells; maxCells is ${maxCells}.`);
  }

  return { dimensions: [width, height, depth], frameCount };
}

/**
 * Checks the grid geometry and works out where to read source cells for the map.
 * @param layout - Grid corner and signed cell sizes in XYZ order.
 * @param dimensions - Cell counts in X, Y, Z order.
 * @returns Geometry and source lookups for a geographic grid, or undefined for a local grid.
 * @throws {Error} If the geometry is invalid or the geographic grid is unsupported.
 */
function preparePlainGrid(
  layout: ZarrVolumeLayout,
  [width, height, depth]: Vector3,
): ReturnType<typeof createProjectedGrid> | undefined {
  const { crs, origin, spacing } = layout;

  if (
    origin.length !== 3 ||
    !origin.every(Number.isFinite) ||
    spacing.length !== 3 ||
    !spacing.every((size) => Number.isFinite(Math.fround(size)) && Math.fround(size) !== 0)
  ) {
    throw new Error('Zarr layout requires a finite XYZ origin and finite, nonzero XYZ spacing.');
  }

  if (crs === undefined) {
    return undefined;
  }

  if (crs !== 'EPSG:4326') {
    throw new Error('The geographic Zarr layout supports EPSG:4326.');
  }

  return createProjectedGrid(
    {
      affine: [spacing[0], 0, origin[0], 0, spacing[1], origin[1]],
      arrayWidth: width,
      arrayHeight: height,
    },
    { count: depth, origin: origin[2], spacing: spacing[2] },
  );
}

/**
 * Arranges the flat array so adjacent entries move along X. Reuses an array already in that order.
 * @param frame - Decoded frame. A stride is how far to advance in the array to move one cell
 * along an axis. If X changes fastest and there are 64 X cells, the Y stride is 64.
 * @param dimensions - Cell counts in X, Y, Z order.
 * @returns The decoded values in grid order.
 */
function copyToGridOrder(frame: Chunk<'float32'>, [width, height, depth]: Vector3): Float32Array {
  const [strideZ = 0, strideY = 0, strideX = 0] = frame.stride;

  if (strideX === 1 && strideY === width && strideZ === width * height) {
    return frame.data;
  }

  const values = new Float32Array(width * height * depth);

  for (let z = 0; z < depth; z++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        values[x + width * (y + height * z)] =
          frame.data[x * strideX + y * strideY + z * strideZ] ?? Number.NaN;
      }
    }
  }

  return values;
}
