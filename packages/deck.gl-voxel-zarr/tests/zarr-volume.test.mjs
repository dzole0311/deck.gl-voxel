import assert from 'node:assert/strict';
import test from 'node:test';

import { openZarrVolume } from '../dist/index.js';

const storeUrl = 'https://zarr.invalid';

/**
 * Replaces fetch so Zarrita reads test metadata and uncompressed blocks in memory.
 * @param {import('node:test').TestContext} context - Test that owns the fetch replacement.
 * @param {Record<string, object>} files - Objects keyed by URL pathname.
 * @returns {string[]} Requested pathnames in fetch order.
 */
function serveStore(context, files) {
  const requests = [];

  context.mock.method(globalThis, 'fetch', async (request) => {
    const path = new URL(request.url).pathname;

    requests.push(path);

    const file = files[path];

    if (file === undefined) {
      return new Response(null, { status: 404 });
    }

    return file instanceof Float32Array ? new Response(file) : Response.json(file);
  });

  return requests;
}

/**
 * Builds Zarr metadata for a float32 array with one stored block per frame.
 * @param {number[]} shape - Array lengths in source order.
 * @param {number[]} chunkShape - Regular chunk lengths in source order.
 * @param {string[]} [dimensions] - Optional names for the source axes.
 * @param {object} [attributes] - Array metadata attributes.
 * @returns {object} Zarr v3 array metadata.
 */
function v3Array(shape, chunkShape, dimensions, attributes = {}) {
  return {
    zarr_format: 3,
    node_type: 'array',
    shape,
    data_type: 'float32',
    chunk_grid: { name: 'regular', configuration: { chunk_shape: chunkShape } },
    chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
    codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
    fill_value: 0,
    ...(dimensions && { dimension_names: dimensions }),
    attributes,
  };
}

const layout = {
  axes: ['x', 'time', 'z', 'y'],
  origin: [10, 20, 30],
  spacing: [1, 2, -3],
};

for (const version of [2, 3]) {
  test(`opens plain Zarr v${version} and reads only the requested frame in grid order`, async (context) => {
    const shape = [3, 2, 1, 2];
    const chunks = [3, 1, 1, 2];
    const values = new Float32Array([0, 21, 2, 22, 3, -9999]);
    const chunkPath = version === 2 ? '/grid/0.1.0.0' : '/grid/c/0/1/0/0';
    const attributes = { _FillValue: -9999 };
    const requests = serveStore(
      context,
      version === 2
        ? {
            '/.zgroup': { zarr_format: 2 },
            '/grid/.zattrs': attributes,
            '/grid/.zarray': {
              zarr_format: 2,
              shape,
              chunks,
              dtype: '<f4',
              compressor: null,
              filters: null,
              order: 'C',
              fill_value: 0,
            },
            [chunkPath]: values,
          }
        : {
            '/zarr.json': { zarr_format: 3, node_type: 'group', attributes: {} },
            '/grid/zarr.json': v3Array(shape, chunks, undefined, attributes),
            [chunkPath]: values,
          },
    );

    await assert.rejects(
      openZarrVolume(storeUrl, { field: 'grid' }),
      /requires an array path and a layout/,
    );
    await assert.rejects(
      openZarrVolume(storeUrl, { field: 'grid', layout, maxCells: 5 }),
      /maxCells is 5/,
    );

    const reader = await openZarrVolume(storeUrl, { field: 'grid', layout });
    await assert.rejects(reader.readFrame(2), /outside the Zarr field/);
    assert.equal(reader.frameCount, 2);
    assert.ok(!requests.includes(chunkPath));

    const frame = await reader.readFrame(1);

    assert.deepEqual(frame, {
      values: new Float32Array([0, 2, 3, 21, 22, -9999]),
      dimensions: [3, 2, 1],
      origin: [10, 20, 30],
      spacing: [1, 2, -3],
      noDataValue: -9999,
    });
    assert.deepEqual(
      requests.filter((path) => /(?:\/c\/|\/\d\.)/.test(path)),
      [chunkPath],
    );

    const controller = new AbortController();
    controller.abort(new Error('Frame cancelled'));
    await assert.rejects(reader.readFrame(0, controller.signal), /Frame cancelled/);
  });
}

test('detects GeoZarr projection inherited from a parent and applies the array affine', async (context) => {
  const shape = [2, 2, 2];
  const groupAttrs = {
    'proj:code': 'EPSG:4326',
    'spatial:dimensions': ['lat', 'lon'],
    'spatial:transform': [1, 0, -2, 0, -1, 2],
    'spatial:shape': [2, 2],
  };
  const fieldAttrs = { 'spatial:transform': [1, 0, -1, 0, -1, 1] };
  const data = new Float32Array([10, 20, 30, 40, 50, 60, 70, 80]);
  const requests = serveStore(context, {
    '/zarr.json': { zarr_format: 3, node_type: 'group', attributes: groupAttrs },
    '/temperature/zarr.json': v3Array(shape, shape, ['depth', 'lat', 'lon'], fieldAttrs),
    '/temperature/c/0/0/0': data,
    '/plain/zarr.json': v3Array(shape, shape),
    '/plain/c/0/0/0': data,
    '/depth/zarr.json': v3Array([2], [2], ['depth'], { units: 'm' }),
    '/depth/c/0': new Float32Array([5, 15]),
  });
  const options = {
    field: 'temperature',
    verticalDimension: 'depth',
    verticalCoordinates: 'depth',
    verticalPositive: 'down',
  };

  await assert.rejects(
    openZarrVolume(storeUrl, { ...options, layout }),
    /Remove the plain Zarr layout/,
  );
  const reader = await openZarrVolume(storeUrl, options);
  assert.equal(reader.level, '.');
  assert.equal(reader.frameCount, 1);
  assert.ok(!requests.includes('/temperature/c/0/0/0'));

  const frame = await reader.readFrame(0);
  assert.deepEqual(frame.dimensions, [2, 2, 2]);
  assert.ok(Math.abs(frame.origin[0] - ((180 - 1) * 512) / 360) < 1e-8);
  assert.ok(frame.spacing[2] < 0);
  assert.deepEqual([...frame.values].map(Math.round), [30, 40, 10, 20, 70, 80, 50, 60]);

  const plain = await openZarrVolume(`${storeUrl}/plain`, {
    field: '.',
    layout: {
      axes: ['z', 'y', 'x'],
      origin: [-1, 1, -0],
      spacing: [1, -1, -10],
      crs: 'EPSG:4326',
    },
  });

  assert.deepEqual(await plain.readFrame(0), frame);
});

test('selects a forecast run and ensemble member without downloading other chunks', async (context) => {
  const shape = [2, 3, 2, 1, 1, 2];
  const chunks = [1, 1, 1, 1, 1, 2];
  const requests = serveStore(context, {
    '/grid/zarr.json': v3Array(shape, chunks),
    '/grid/c/1/2/1/0/0/0': new Float32Array([12, 13]),
  });
  const options = {
    field: 'grid',
    layout: { axes: [null, null, 'time', 'z', 'y', 'x'], origin: [0, 0, 0], spacing: [1, 1, 1] },
    selection: { 0: 1, 1: 2 },
  };
  const reader = await openZarrVolume(storeUrl, options);
  assert.equal(reader.frameCount, 2);
  const frame = await reader.readFrame(1);
  assert.deepEqual(frame.dimensions, [2, 1, 1]);
  assert.deepEqual([...frame.values], [12, 13]);
  assert.deepEqual(
    requests.filter((path) => path.includes('/c/')),
    ['/grid/c/1/2/1/0/0/0'],
  );
  await assert.rejects(
    openZarrVolume(storeUrl, { ...options, selection: { 0: 1 } }),
    /requires a selection/,
  );
  await assert.rejects(
    openZarrVolume(storeUrl, { ...options, selection: { 0: 2, 1: 0 } }),
    /in-range integer/,
  );
  await assert.rejects(
    openZarrVolume(storeUrl, { ...options, selection: { 0: 1, 1: 0, 2: 0 } }),
    /null axis/,
  );
});

test('GeoZarr derives permuted spatial axes and selects an extra named dimension', async (context) => {
  const attributes = {
    'proj:code': 'EPSG:4326',
    'spatial:dimensions': ['lat', 'lon'],
    'spatial:transform': [1, 0, 0, 0, -1, 2],
    'spatial:shape': [2, 2],
  };
  serveStore(context, {
    '/grid/zarr.json': v3Array(
      [2, 2, 2, 2],
      [1, 2, 2, 2],
      ['run', 'lon', 'height', 'lat'],
      attributes,
    ),
    '/grid/c/1/0/0/0': new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]),
    '/height/zarr.json': v3Array([2], [2], ['height'], { units: 'm' }),
    '/height/c/0': new Float32Array([5, 15]),
  });
  const reader = await openZarrVolume(storeUrl, {
    field: 'grid',
    verticalDimension: 'height',
    verticalCoordinates: 'height',
    selection: { 0: 1 },
  });
  const frame = await reader.readFrame(0);
  assert.deepEqual(frame.dimensions, [2, 2, 2]);
  assert.deepEqual([...frame.values].map(Math.round), [1, 5, 0, 4, 3, 7, 2, 6]);
});

test('an opened synchronous store reads dense frames without HTTP or range capability', async (context) => {
  context.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected HTTP request');
  });
  const encode = (value) => new TextEncoder().encode(JSON.stringify(value));
  const store = new Map([
    ['/zarr.json', encode({ zarr_format: 3, node_type: 'group', attributes: {} })],
    ['/grid/zarr.json', encode(v3Array([1, 1, 2], [1, 1, 2]))],
    ['/grid/c/0/0/0', new Uint8Array(new Float32Array([0, 7]).buffer)],
  ]);
  const reader = await openZarrVolume(store, {
    field: 'grid',
    layout: { axes: ['z', 'y', 'x'], origin: [10, 20, 30], spacing: [2, -3, 5] },
  });
  try {
    const frame = await reader.readFrame(0);
    assert.deepEqual(frame.dimensions, [2, 1, 1]);
    assert.deepEqual(frame.origin, [10, 20, 30]);
    assert.deepEqual([...frame.values], [0, 7]);
  } finally {
    reader.dispose();
  }
  assert.ok(store.has('/grid/c/0/0/0'));
});

test('direct nonconsolidated metadata adapts start-index shards on an opened store', async (context) => {
  context.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected HTTP request');
  });
  const encode = (value) => new TextEncoder().encode(JSON.stringify(value));
  const array = v3Array([1, 1, 2], [1, 1, 2]);
  const bytes = { name: 'bytes', configuration: { endian: 'little' } };
  array.codecs = [
    {
      name: 'sharding_indexed',
      configuration: {
        chunk_shape: [1, 1, 2],
        codecs: [bytes],
        index_codecs: [bytes],
        index_location: 'start',
      },
    },
  ];
  const shard = new Uint8Array(24);
  const index = new DataView(shard.buffer);
  index.setBigUint64(0, 16n, true);
  index.setBigUint64(8, 8n, true);
  shard.set(new Uint8Array(new Float32Array([3, 9]).buffer), 16);
  const metadata = new Map([
    ['/zarr.json', encode({ zarr_format: 3, node_type: 'group', attributes: {} })],
    ['/grid/zarr.json', encode(array)],
  ]);
  const ranges = [];
  const store = {
    get: async (path) => metadata.get(path),
    getRange: async (path, range, options) => {
      assert.equal(path, '/grid/c/0/0/0');
      options?.signal?.throwIfAborted();
      ranges.push(range);
      assert.ok('offset' in range, 'start-index reads must use absolute byte offsets');
      return shard.slice(range.offset, range.offset + range.length);
    },
  };
  const reader = await openZarrVolume(store, {
    field: 'grid',
    layout: { axes: ['z', 'y', 'x'], origin: [0, 0, 0], spacing: [1, 1, 1] },
  });
  try {
    assert.deepEqual([...(await reader.readFrame(0)).values], [3, 9]);
  } finally {
    reader.dispose();
  }
  assert.deepEqual(ranges, [
    { offset: 0, length: 16 },
    { offset: 16, length: 8 },
  ]);
});
