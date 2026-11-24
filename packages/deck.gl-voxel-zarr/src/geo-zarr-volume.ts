import { type MultiscaleLevel, parseGeoZarrMetadata } from '@developmentseed/geozarr';
import {
  type Attributes,
  type DataType,
  type Group,
  get,
  type Location,
  NotFoundError,
  open,
  type Readable,
  type Array as ZarrArray,
} from 'zarrita';

import { createProjectedGrid } from './projected-grid.js';
import type { Axis, ZarrVolumeOptions } from './zarr-volume.js';

/** Convention IDs from the {@link https://geozarr.org/conventions.html#core-conventions | GeoZarr spec}. */
const SPATIAL_CONVENTION = '689b58e2-cf7b-45e0-9fff-9cfc0883d6b4';
const PROJ_CONVENTION = 'f17cb550-5864-4468-aeb7-f3180cfb622f';
const CRS_KEYS = ['proj:code', 'proj:wkt2', 'proj:projjson'] as const;

/**
 * Reads the selected array or group's map metadata.
 * Use missing map attributes from an array's direct parent. The parent's resolution levels
 * apply when the group itself is selected.
 *
 * @param location - Zarr store root.
 * @param node - Selected array or group.
 * @param options - Cancellation for the parent metadata lookup.
 * @returns The combined attributes used to recognize and open a GeoZarr field.
 * @throws {Error} If a request for the parent fails. An absent parent is allowed.
 */
export async function readSpatialAttributes(
  location: Location<Readable>,
  node: ZarrArray<DataType> | Group<Readable>,
  options: { signal?: AbortSignal },
): Promise<Attributes> {
  if (node.kind === 'group' || node.path === '/') {
    return node.attrs;
  }

  const parentPath = node.path.slice(0, node.path.lastIndexOf('/')) || '/';
  const parent = await open(location.resolve(parentPath), { ...options, kind: 'group' }).catch(
    (error: unknown) => {
      if (!(error instanceof NotFoundError)) {
        throw error;
      }

      return undefined;
    },
  );
  const inherited = Object.fromEntries(
    Object.entries(parent?.attrs ?? {}).filter(
      ([key]) => key.startsWith('spatial:') || key.startsWith('proj:'),
    ),
  );

  if (CRS_KEYS.some((key) => Object.hasOwn(node.attrs, key))) {
    for (const key of CRS_KEYS) {
      delete inherited[key];
    }
  }

  return { ...inherited, ...node.attrs };
}

/**
 * Looks for both sets of GeoZarr metadata. The spatial fields say where the grid starts
 * and how its cells are spaced. The projection fields say what its coordinates mean,
 * for example longitude and latitude in degrees with EPSG:4326. Each set can be recognized
 * by its registered UUID or its attribute names.
 *
 * @param attrs - Attributes from the field being opened.
 * @returns Whether to validate this field as GeoZarr.
 */
export function hasGeoZarrMetadata(attrs: Attributes): boolean {
  const conventions = attrs.zarr_conventions;
  const registrations: readonly unknown[] = Array.isArray(conventions) ? conventions : [];
  const hasSpatial = Object.keys(attrs).some((key) => key.startsWith('spatial:'));
  const hasProjection = CRS_KEYS.some((key) => Object.hasOwn(attrs, key));

  return (
    (hasSpatial || registrations.some((value) => hasConvention(value, SPATIAL_CONVENTION))) &&
    (hasProjection || registrations.some((value) => hasConvention(value, PROJ_CONVENTION)))
  );
}

/**
 * Opens the chosen GeoZarr array and maps named dimensions to X, Y, Z and time.
 * Additional dimensions require fixed indices in {@link ZarrVolumeOptions.selection}.
 * @param node - Selected field group or directly selected array.
 * @param attrs - Map metadata collected for the field.
 * @param options - Resolution level, vertical coordinates, fixed dimension selections and cancellation.
 * @returns The array, its axes and a function to prepare the map grid once the depth is known.
 * @throws {Error} If the required metadata or axis layout is unsupported.
 */
export async function readGeoZarrField(
  node: ZarrArray<DataType> | Group<Readable>,
  attrs: Attributes,
  options: ZarrVolumeOptions,
): Promise<{
  array: ZarrArray<DataType>;
  axes: readonly Axis[];
  level: MultiscaleLevel;
  createGrid(depth: number): Promise<ReturnType<typeof createProjectedGrid>>;
}> {
  const { signal, verticalDimension, verticalCoordinates, verticalPositive = 'up' } = options;

  if (!verticalDimension || !verticalCoordinates) {
    throw new Error('GeoZarr volumes require verticalDimension and verticalCoordinates.');
  }

  if ((attrs['spatial:transform_type'] ?? 'affine') !== 'affine') {
    throw new Error('GeoZarr volumes require an affine spatial transform.');
  }

  const metadata = parseGeoZarrMetadata(attrs);
  const level =
    options.level === undefined
      ? metadata.levels.at(-1)
      : metadata.levels.find(({ path }) => path === options.level);

  if (!level || metadata.crs.code !== 'EPSG:4326' || metadata.registration !== 'pixel') {
    throw new Error('Expected an existing level with pixel-registered EPSG:4326 GeoZarr metadata.');
  }

  if (node.kind === 'array' && level.path !== '.') {
    throw new Error('Open the GeoZarr multiscale group to select an overview.');
  }

  const openOptions = signal ? { signal } : {};
  const array =
    node.kind === 'array'
      ? node
      : await open(node.resolve(level.path), { kind: 'array', ...openOptions });
  const xDimension = metadata.axes[metadata.xAxisIndex];
  const yDimension = metadata.axes[metadata.yAxisIndex];
  const names = array.dimensionNames;
  const axes: Axis[] = (names ?? []).map((name, dimension) => {
    if (name === xDimension) {
      return 'x';
    }
    if (name === yDimension) {
      return 'y';
    }
    if (name === verticalDimension) {
      return 'z';
    }
    if (name === 'time') {
      return 'time';
    }
    if (options.selection?.[dimension] !== undefined) {
      return null;
    }
    throw new Error('Extra GeoZarr dimensions require a fixed selection index.');
  });

  if (
    !xDimension ||
    !yDimension ||
    !names ||
    names.length !== array.shape.length ||
    new Set(names).size !== names.length ||
    !axes.includes('x') ||
    !axes.includes('y') ||
    !axes.includes('z')
  ) {
    throw new Error('Expected named GeoZarr X, Y and vertical dimensions.');
  }

  return {
    array,
    level,
    axes,
    /**
     * Reads heights or depths for the cell centers once the frame fits the size limit.
     * The renderer needs a starting edge and a cell size. For centers at 5 m and 15 m,
     * the size is 10 m and the first edge is at 0 m.
     * @param depth - Cell count on the vertical axis.
     * @returns The grid in the same Web Mercator coordinates as other deck.gl map layers.
     * @throws {Error} If reading coordinates fails or they aren't evenly spaced.
     */
    async createGrid(depth: number): Promise<ReturnType<typeof createProjectedGrid>> {
      const coordinates = await open(node.resolve(`/${verticalCoordinates}`), {
        kind: 'array',
        ...openOptions,
      });

      if (
        depth < 2 ||
        !(coordinates.is('float32') || coordinates.is('float64')) ||
        coordinates.attrs.units !== 'm' ||
        coordinates.shape.length !== 1 ||
        coordinates.shape[0] !== depth
      ) {
        throw new Error('Expected at least two floating-point vertical cell centers in meters.');
      }

      const { data: heights } = await get(coordinates, null, openOptions);
      const first = heights[0];
      const second = heights[1];

      if (first === undefined || second === undefined) {
        throw new Error('GeoZarr volumes require at least two vertical cell centers.');
      }

      const step = second - first;

      if (
        !Number.isFinite(step) ||
        step === 0 ||
        !heights.every(
          (value, index) => Math.abs(value - first - index * step) <= Math.abs(step) * 1e-5,
        )
      ) {
        throw new Error('Vertical coordinates must be finite and equally spaced.');
      }

      const sign = verticalPositive === 'down' ? -1 : 1;
      const vertical = { count: depth, origin: (first - step / 2) * sign, spacing: step * sign };

      return createProjectedGrid(level, vertical, array.attrs.valid_support_bbox);
    },
  };
}

/**
 * Checks whether a metadata entry names the convention by its registered UUID.
 * @param value - Entry in the Zarr conventions array.
 * @param uuid - Expected registration identifier.
 * @returns Whether the entry registers the convention.
 */
function hasConvention(value: unknown, uuid: string): boolean {
  return typeof value === 'object' && value !== null && 'uuid' in value && value.uuid === uuid;
}
