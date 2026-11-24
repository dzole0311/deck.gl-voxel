import type { GribberishCodecConfiguration } from '@mattnucc/gribberish/zarr';
import type { VoxelData } from 'deck.gl-voxel';
import { projectGeographicVolume, type ZarrVolume } from 'deck.gl-voxel-zarr';
import { IcechunkStore } from 'icechunk-js';
import { get, open, registry, slice } from 'zarrita';

const COLLECTION = 'https://stac.dynamical.org/noaa-gfs-forecast-virtual/collection.json';
const GROUP = 'height_above_mean_sea_level';
const WEST = -94;
const EAST = -76;
const SOUTH = 19;
const NORTH = 31;
const HEIGHT_STEP_METERS = 500;
const HEIGHT_COUNT = 9;
const FRAME_COUNT = 15;

registry.set('gribberish', async () => {
  const { GribberishCodec } = await import('@mattnucc/gribberish/zarr');

  return {
    fromConfig(configuration, { dataType, shape }) {
      return GribberishCodec.fromConfig(configuration as GribberishCodecConfiguration | undefined, {
        data_type: dataType,
        shape,
      });
    },
  };
});

/**
 * Opens the eastward and northward wind fields for one GFS forecast over the Gulf and Florida.
 * Dynamical's catalog links to an Icechunk index. For this dataset the index points
 * to the byte ranges of NOAA's original GRIB weather files, which the browser reads directly.
 * @param firstTime - Time NOAA started this forecast run, in milliseconds since the Unix epoch.
 * @param stepHours - Hours between displayed frames.
 * @param signal - Cancels reads of the catalog, Icechunk store and coordinate arrays.
 * @returns A reader that builds a wind-speed grid in the browser for each requested frame.
 * @throws {Error} If the cloud store or requested coordinates cannot be opened.
 * @see {@link https://dynamical.org/catalog/noaa-gfs-forecast-virtual/}
 */
export async function openGfsWind(
  firstTime: number,
  stepHours: number,
  signal: AbortSignal,
): Promise<ZarrVolume> {
  const response = await fetch(COLLECTION, { signal });

  if (!response.ok) {
    throw new Error(`Dynamical catalog returned HTTP ${response.status}.`);
  }

  const collection: unknown = await response.json();
  const href = getIcechunkUrl(collection);
  const store = (await IcechunkStore.open(href, { signal })).resolve(GROUP);
  const [init, lead, lat, lon, height, u, v] = await Promise.all([
    readCoordinate(store, 'init_time', signal),
    readCoordinate(store, 'lead_time', signal),
    readCoordinate(store, 'latitude', signal),
    readCoordinate(store, 'longitude', signal),
    readCoordinate(store, GROUP, signal),
    open(store.resolve('wind_u'), { kind: 'array', signal }),
    open(store.resolve('wind_v'), { kind: 'array', signal }),
  ]);

  const shape = [init.length, lead.length, lat.length, lon.length, height.length];

  if (
    !u.is('float64') ||
    !v.is('float64') ||
    [u, v].some(
      (array) => array.shape.length !== 5 || array.shape.some((size, i) => size !== shape[i]),
    )
  ) {
    throw new Error('Dynamical GFS wind arrays do not match the expected coordinate axes.');
  }

  const run = coordinateIndex(init, firstTime / 1000);
  const latStart = coordinateIndex(lat, NORTH);
  const latEnd = coordinateIndex(lat, SOUTH) + 1;
  const lonStart = coordinateIndex(lon, WEST);
  const lonEnd = coordinateIndex(lon, EAST) + 1;
  const width = lonEnd - lonStart;
  const rows = latEnd - latStart;

  if (width < 2 || rows < 2) {
    throw new Error(
      'Dynamical GFS coordinates do not cover the forecast window in north-up order.',
    );
  }

  const dx = (EAST - WEST) / (width - 1);
  const dy = (SOUTH - NORTH) / (rows - 1);
  const frameLeads = Array.from({ length: FRAME_COUNT }, (_, i) =>
    coordinateIndex(lead, i * stepHours * 3600),
  );
  const heightPairs = Array.from({ length: HEIGHT_COUNT }, (_, index) => {
    const target = (index + 1) * HEIGHT_STEP_METERS;
    const upper = height.findIndex((value) => value >= target);
    const lower = height[upper - 1];
    const top = height[upper];

    if (lower === undefined || top === undefined || top <= lower) {
      throw new Error(`Dynamical GFS heights do not bracket ${target} m.`);
    }

    return { lower: upper - 1, upper, weight: (target - lower) / (top - lower) };
  });
  const firstHeight = heightPairs[0]?.lower ?? 0;
  const endHeight = (heightPairs.at(-1)?.upper ?? 0) + 1;
  return {
    frameCount: FRAME_COUNT,
    level: '.',
    /**
     * Loads both wind directions for one forecast hour and combines them into wind speed.
     * @param index - Zero-based index in the displayed forecast times.
     * @param frameSignal - Cancels the byte-range requests to NOAA's GRIB files.
     * @returns Wind speed in m/s on a 3D grid placed on the map.
     * @throws {Error} If the frame cannot be read or the index is outside the timeline.
     */
    async readFrame(index: number, frameSignal?: AbortSignal): Promise<VoxelData> {
      frameSignal?.throwIfAborted();
      const leadIndex = frameLeads[index];

      if (leadIndex === undefined) {
        throw new Error('GFS forecast frame is outside the available range.');
      }

      const selection = [
        run,
        leadIndex,
        slice(latStart, latEnd),
        slice(lonStart, lonEnd),
        slice(firstHeight, endHeight),
      ];
      const options = frameSignal ? { signal: frameSignal } : undefined;
      const [east, north] = await Promise.all([
        get(u, selection, options),
        get(v, selection, options),
      ]);
      frameSignal?.throwIfAborted();

      const values = new Float32Array(width * rows * HEIGHT_COUNT);

      for (const [z, { lower, upper, weight }] of heightPairs.entries()) {
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < width; x++) {
            const eastward = interpolateWind(
              east,
              x,
              y,
              lower - firstHeight,
              upper - firstHeight,
              weight,
            );
            const northward = interpolateWind(
              north,
              x,
              y,
              lower - firstHeight,
              upper - firstHeight,
              weight,
            );
            values[x + width * (y + rows * z)] = Math.hypot(eastward, northward);
          }
        }
      }

      return projectGeographicVolume(
        values,
        [width, rows, HEIGHT_COUNT],
        [WEST - dx / 2, NORTH - dy / 2, HEIGHT_STEP_METERS / 2],
        [dx, dy, HEIGHT_STEP_METERS],
      );
    },
  };
}

/**
 * Reads the HTTPS URL of the Icechunk store from the STAC catalog entry.
 * @param collection - Catalog JSON received over the network.
 * @returns The published HTTPS store URL.
 * @throws {Error} If an HTTPS Icechunk asset is missing.
 */
function getIcechunkUrl(collection: unknown): string {
  if (typeof collection === 'object' && collection !== null && 'assets' in collection) {
    const assets = collection.assets;

    if (typeof assets === 'object' && assets !== null && 'icechunk-https' in assets) {
      const asset = assets['icechunk-https'];

      if (
        typeof asset === 'object' &&
        asset !== null &&
        'href' in asset &&
        typeof asset.href === 'string' &&
        new URL(asset.href).protocol === 'https:'
      ) {
        return asset.href;
      }
    }
  }

  throw new Error('Dynamical catalog has no HTTPS Icechunk asset.');
}

/**
 * Reads one axis as a list of numbers, such as latitudes or forecast times.
 * @param group - Source Icechunk group.
 * @param name - Coordinate array name.
 * @param signal - Cancels metadata and chunk reads.
 * @returns Coordinate values in published order and units.
 * @throws {Error} If the coordinate does not have a supported numeric type.
 */
async function readCoordinate(
  group: IcechunkStore,
  name: string,
  signal: AbortSignal,
): Promise<number[]> {
  const array = await open(group.resolve(name), { kind: 'array', signal });

  if (array.shape.length === 1 && array.is('int64')) {
    return Array.from((await get(array, null, { signal })).data, Number);
  }

  if (array.shape.length === 1 && array.is('float64')) {
    return Array.from((await get(array, null, { signal })).data);
  }

  throw new Error(`Dynamical GFS coordinate ${name} is not a supported numeric axis.`);
}

/**
 * Finds the array index of an exact time or grid coordinate.
 * @param values - Numeric coordinates in source order.
 * @param value - Required coordinate in source units.
 * @returns The zero-based source index.
 * @throws {Error} If the value is absent from the axis.
 */
function coordinateIndex(values: readonly number[], value: number): number {
  const index = values.indexOf(value);

  if (index < 0) {
    throw new Error(`Dynamical GFS is missing requested coordinate ${value}.`);
  }

  return index;
}

/**
 * Estimates one wind component at a height between two levels in the source data.
 * @param chunk - Wind values already read for the chosen latitudes, longitudes and heights.
 * @param x - Longitude index in the selected window.
 * @param y - Latitude index in the selected window.
 * @param lower - Lower sampled height index.
 * @param upper - Upper sampled height index.
 * @param weight - How far up the target height is between the two levels, from 0 to 1.
 * @returns Wind component in m/s, or NaN if either source value is missing.
 */
function interpolateWind(
  chunk: { data: Float64Array; stride: readonly number[] },
  x: number,
  y: number,
  lower: number,
  upper: number,
  weight: number,
): number {
  const [row = 0, column = 0, vertical = 0] = chunk.stride;
  const offset = y * row + x * column;
  const a = chunk.data[offset + lower * vertical] ?? NaN;
  const b = chunk.data[offset + upper * vertical] ?? NaN;

  return a + (b - a) * weight;
}
