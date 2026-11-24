import { lngLatToWorld, unitsPerMeter, worldToLngLat } from '@math.gl/web-mercator';
import type { Vector3, VoxelData } from 'deck.gl-voxel';
import type { Chunk } from 'zarrita';

/** Two source cell indices and the share taken from the second one. The first gets the rest. */
type AxisSample = readonly [lower: number, upper: number, weight: number];

/** Geographic edge coordinates in degrees. */
type Bounds = readonly [west: number, south: number, east: number, north: number];

/** Size of the horizontal grid and how its row and column indices map to degrees. */
interface GeographicGrid {
  /**
   * GeoZarr's six numbers for turning column and row indices into longitude and latitude.
   * For the north-up grids we support, this is [dx, 0, west, 0, dy, north]. Multiply the
   * column by dx and add west for longitude. Multiply the row by dy and add north for latitude.
   */
  readonly affine: readonly [number, number, number, number, number, number];
  readonly arrayWidth: number;
  readonly arrayHeight: number;
}

/** Vertical cell geometry, in meters with positive up. */
interface VerticalGrid {
  readonly count: number;
  readonly origin: number;
  readonly spacing: number;
}

/** Where the grid sits on the map and which source cells to blend for each row and column. */
export interface ProjectedGrid {
  readonly dimensions: Vector3;
  readonly origin: Vector3;
  readonly spacing: Vector3;
  readonly columns: readonly AxisSample[];
  readonly rows: readonly AxisSample[];
}

/**
 * Puts a latitude/longitude grid on a deck.gl Web Mercator map. A degree of latitude
 * covers more map space near the poles than at the equator. The renderer needs evenly
 * spaced cells on the map, so fill a new grid by blending nearby source cells.
 * @param values - XYZ grid values with X varying fastest, then Y, then Z.
 * @param dimensions - Cell counts in XYZ order.
 * @param origin - West and north edges in degrees and the bottom edge in meters.
 * @param spacing - X and Y cell sizes in degrees and Z in meters. Negative Y means rows go south.
 * @returns A new values array and a grid in deck.gl's shared map coordinates.
 * @throws {Error} If the bounds, vertical geometry, or array size are invalid.
 */
export function projectGeographicVolume(
  values: Float32Array,
  dimensions: Vector3,
  origin: Vector3,
  spacing: Vector3,
): VoxelData {
  const [width, height, depth] = dimensions;

  if (
    !dimensions.every((size) => Number.isSafeInteger(size) && size > 0) ||
    values.length !== width * height * depth
  ) {
    throw new Error('Geographic volume dimensions must match the scalar array.');
  }

  if (!Number.isFinite(origin[2]) || !Number.isFinite(spacing[2]) || spacing[2] === 0) {
    throw new Error('Geographic volume requires a finite vertical origin and nonzero spacing.');
  }

  const grid = createProjectedGrid(
    {
      affine: [spacing[0], 0, origin[0], 0, spacing[1], origin[1]],
      arrayWidth: width,
      arrayHeight: height,
    },
    { count: depth, origin: origin[2], spacing: spacing[2] },
  );

  return projectFrame(
    { data: values, shape: [depth, height, width], stride: [width * height, width, 1] },
    grid,
  );
}

/**
 * Works out which source cells each new map row and column will read. These lookups
 * can be reused for every time step because the grid geometry stays the same. Web Mercator's
 * scale varies with latitude, so use the middle latitude to set one height scale for the grid.
 *
 * @param level - North-up grid in degrees. Coordinates describe cell edges.
 * @param vertical - First vertical grid edge and signed cell size in meters. Positive Z is up.
 * @param validSupport - Optional west, south, east and north edges of the actual data.
 * @returns Map grid geometry and a lookup for blending source cells.
 * @throws {Error} If the grid transform or bounds are outside what the map grid supports.
 */
export function createProjectedGrid(
  level: GeographicGrid,
  vertical: VerticalGrid,
  validSupport?: unknown,
): ProjectedGrid {
  const [dx, skewX, westEdge, skewY, dy, northEdge] = level.affine;
  const { arrayWidth: width, arrayHeight: height } = level;

  if (!level.affine.every(Number.isFinite) || dx <= 0 || dy >= 0 || skewX !== 0 || skewY !== 0) {
    throw new Error('Geographic Zarr volumes require a north-up affine.');
  }

  const eastEdge = westEdge + dx * width;
  const southEdge = northEdge + dy * height;
  const bounds = validSupport ?? [westEdge, southEdge, eastEdge, northEdge];

  if (!isBounds(bounds)) {
    throw new Error('Geographic grid bounds must contain four finite coordinates.');
  }

  const [west, south, east, north] = bounds;

  if (west < -180 || east > 180 || west >= east || south < -85 || north > 85 || south >= north) {
    throw new Error(
      'Geographic grid must be inside Web Mercator and cannot cross the antimeridian.',
    );
  }

  const [minX, minY] = lngLatToWorld([west, south]);
  const [maxX, maxY] = lngLatToWorld([east, north]);
  const spacingX = (maxX - minX) / width;
  const spacingY = (maxY - minY) / height;
  const verticalScale = unitsPerMeter((south + north) / 2);
  const columns = Array.from({ length: width }, (_, index) => {
    const longitude = west + ((index + 0.5) * (east - west)) / width;

    return sampleAxis((longitude - westEdge) / dx - 0.5, width);
  });
  const rows = Array.from({ length: height }, (_, index) => {
    const latitude = worldToLngLat([minX, minY + (index + 0.5) * spacingY])[1];

    return sampleAxis((latitude - northEdge) / dy - 0.5, height);
  });

  return {
    dimensions: [width, height, vertical.count],
    origin: [minX, minY, vertical.origin * verticalScale],
    spacing: [spacingX, spacingY, vertical.spacing * verticalScale],
    columns,
    rows,
  };
}

/**
 * Checks that the map bounds are four finite numbers.
 * @param value - Bounds from metadata or calculated from the grid's origin and spacing.
 * @returns Whether the value is a four-number tuple.
 */
function isBounds(value: unknown): value is Bounds {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every(
      (coordinate: unknown) => typeof coordinate === 'number' && Number.isFinite(coordinate),
    )
  );
}

/**
 * Finds the two neighboring source cells to blend. At the edges, use the nearest outer cell.
 * @param index - Source position in cell units. For example, 1.25 uses 75% of cell 1
 * and 25% of cell 2.
 * @param count - Number of source cells on this axis.
 * @returns The source neighbors and the weight for the upper index.
 */
function sampleAxis(index: number, count: number): AxisSample {
  const bounded = Math.max(0, Math.min(count - 1, index));
  const lower = Math.floor(bounded);

  return [lower, Math.min(lower + 1, count - 1), bounded - lower];
}

/**
 * Moves each horizontal layer onto the map grid. Blend the nearby source cells with data
 * and give them all of the weight that missing cells would have used.
 * @param frame - Decoded scalar frame in Z, Y, X dimension order.
 * @param grid - Map grid with source cell indices and blend weights for each row and column.
 * @param noDataValue - Optional number that marks missing cells.
 * @param available - Optional readiness flags in source stride order; unknown contributors keep a target cell unloaded.
 * @returns A new grid whose flat array changes X fastest.
 */
export function projectFrame(
  frame: Chunk<'float32'>,
  grid: ProjectedGrid,
  noDataValue?: number,
  available?: Uint8Array,
): VoxelData {
  const [width, height, depth] = grid.dimensions;
  const [strideZ = 0, strideY = 0, strideX = 0] = frame.stride;
  const values = new Float32Array(width * height * depth);

  for (let z = 0; z < depth; z++) {
    for (const [y, row] of grid.rows.entries()) {
      for (const [x, column] of grid.columns.entries()) {
        let sum = 0;
        let weight = 0;
        let ready = true;

        for (const j of [0, 1] as const) {
          for (const i of [0, 1] as const) {
            const value = frame.data[z * strideZ + row[j] * strideY + column[i] * strideX];
            const contribution =
              (i === 0 ? 1 - column[2] : column[2]) * (j === 0 ? 1 - row[2] : row[2]);

            if (
              contribution > 0 &&
              available &&
              !available[z * strideZ + row[j] * strideY + column[i] * strideX]
            ) {
              ready = false;
            }
            if (value !== undefined && Number.isFinite(value) && value !== noDataValue) {
              sum += value * contribution;
              weight += contribution;
            }
          }
        }

        values[x + width * (y + height * z)] = ready && weight > 0 ? sum / weight : Number.NaN;
      }
    }
  }

  return { values, dimensions: grid.dimensions, origin: grid.origin, spacing: grid.spacing };
}
