import type { GribberishCodecConfiguration } from '@mattnucc/gribberish/zarr';
import {
  ChunkCache,
  createChunkedVolume,
  type ZarrSourceContext,
  type ZarrVolume,
} from 'deck.gl-voxel-zarr';
import { IcechunkStore } from 'icechunk-js';
import { type Chunk, get, open, registry, slice, type Array as ZarrArray } from 'zarrita';

const COLLECTION = 'https://stac.dynamical.org/noaa-gfs-forecast-virtual/collection.json';
const GROUP = 'height_above_mean_sea_level';
const WEST = -125;
const EAST = -66;
const SOUTH = 24;
const NORTH = 50;
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
 * Opens one GFS wind forecast over the Gulf and Florida
 * Dynamical's Icechunk index points to NOAA GRIB files that the browser reads directly
 * @param firstTime - Forecast start time in milliseconds since the Unix epoch
 * @param stepHours - Hours between displayed frames
 * @param signal - Cancels catalog, store and coordinate reads
 * @param context - Cache byte limit and read concurrency supplied by the layer
 * @returns A reader that computes wind speed from the two wind components
 * @throws {Error} If the store cannot be opened or a requested coordinate is missing
 * @see {@link https://dynamical.org/catalog/noaa-gfs-forecast-virtual/}
 */
export async function openGfsWind(
  firstTime: number,
  stepHours: number,
  signal: AbortSignal,
  context: ZarrSourceContext,
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
  const componentCacheBytes = Math.floor(context.maxCacheBytes / 2);
  const components = new ChunkCache<string, Chunk<'float64'>>({
    maxBytes: componentCacheBytes,
    maxRequests: context.maxRequests,
    load: (key, signal) => {
      const [component, leadText, heightText] = key.split(':');
      const leadIndex = Number(leadText);
      const heightIndex = Number(heightText);
      if (
        !Number.isSafeInteger(leadIndex) ||
        !Number.isSafeInteger(heightIndex) ||
        (component !== 'u' && component !== 'v')
      ) {
        throw new Error('GFS component key is missing its forecast or height.');
      }
      return readComponent(component === 'u' ? u : v, leadIndex, heightIndex, signal);
    },
    byteLength: (chunk) => chunk.data.buffer.byteLength,
  });

  function readComponent(
    array: ZarrArray<'float64'>,
    leadIndex: number,
    heightIndex: number,
    signal: AbortSignal,
  ) {
    return get(
      array,
      [run, leadIndex, slice(latStart, latEnd), slice(lonStart, lonEnd), heightIndex],
      { signal },
    );
  }

  return createChunkedVolume({
    geometry: {
      dimensions: [width, rows, HEIGHT_COUNT],
      origin: [WEST - dx / 2, NORTH - dy / 2, HEIGHT_STEP_METERS / 2],
      spacing: [dx, dy, HEIGHT_STEP_METERS],
    },
    geographic: true,
    maxCacheBytes: context.maxCacheBytes - componentCacheBytes,
    maxRequests: context.maxRequests,
    frameCount: FRAME_COUNT,
    // Each GRIB chunk covers the whole horizontal grid at one height
    chunkDimensions: [width, rows, 1],
    dispose: () => components.clear(),
    async readChunk(index, [, , z], signal) {
      const leadIndex = frameLeads[index];
      const pair = heightPairs[z];
      if (leadIndex === undefined || !pair) {
        throw new Error('GFS forecast frame or height is outside the available range.');
      }
      const { lower, upper, weight } = pair;
      const [eastLower, eastUpper, northLower, northUpper] = await Promise.all([
        components.read(`u:${leadIndex}:${lower}`, signal),
        components.read(`u:${leadIndex}:${upper}`, signal),
        components.read(`v:${leadIndex}:${lower}`, signal),
        components.read(`v:${leadIndex}:${upper}`, signal),
      ]);
      signal.throwIfAborted();
      const values = new Float32Array(width * rows);
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < width; x++) {
          const eastward = interpolateWind(eastLower, eastUpper, x, y, weight);
          const northward = interpolateWind(northLower, northUpper, x, y, weight);
          values[x + width * y] = Math.hypot(eastward, northward);
        }
      }
      return values;
    },
  });
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

/** Blends two cached height slices for one wind component and keeps missing values as NaN */
function interpolateWind(
  lower: { data: Float64Array; stride: readonly number[] },
  upper: { data: Float64Array; stride: readonly number[] },
  x: number,
  y: number,
  weight: number,
): number {
  const a = lower.data[y * (lower.stride[0] ?? 0) + x * (lower.stride[1] ?? 0)] ?? NaN;
  const b = upper.data[y * (upper.stride[0] ?? 0) + x * (upper.stride[1] ?? 0)] ?? NaN;
  return a + (b - a) * weight;
}
