import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebMercatorViewport } from '@deck.gl/core';
import { cellValue } from 'deck.gl-voxel';
import { withStartShardIndexes } from '../dist/cell-store.js';
import { GeoZarrCellSource, selectCellLevel } from '../dist/index.js';

globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(performance.now()), 0);
globalThis.cancelAnimationFrame ??= clearTimeout;

test('start-index compatibility changes only suffix index reads for the matching array', async () => {
  const calls = [];
  const inner = {
    get: async () => undefined,
    getRange: async (path, range) => {
      calls.push([path, range]);
      return new Uint8Array();
    },
  };
  const store = withStartShardIndexes(inner, new Set(['/field/0']));
  await store.getRange('/field/0/c/0/1/2', { suffixLength: 68 });
  await store.getRange('/field/0/c/0/1/2', { offset: 100, length: 60 });
  await store.getRange('/other/0/c/0', { suffixLength: 20 });
  assert.deepEqual(calls, [
    ['/field/0/c/0/1/2', { offset: 0, length: 68 }],
    ['/field/0/c/0/1/2', { offset: 100, length: 60 }],
    ['/other/0/c/0', { suffixLength: 20 }],
  ]);
});

test('local screen error selects useful stored levels with hysteresis around transitions', () => {
  assert.equal(selectCellLevel(5, 6), 0);
  assert.equal(selectCellLevel(0.2, 6), 3);
  assert.equal(selectCellLevel(0.01, 6), 5);
  assert.equal(selectCellLevel(0.95, 6, 1), 1);
  assert.equal(selectCellLevel(1.49, 6, 1), 1);
  assert.equal(selectCellLevel(1.6, 6, 1), 0);
});

function fixture() {
  const nodes = {},
    bytes = new Map();
  const array = (path, shape, type, data, attributes = {}) => {
    nodes[path] = {
      zarr_format: 3,
      node_type: 'array',
      shape,
      data_type: type,
      dimension_names:
        shape.length === 3 ? ['z', 'y', 'x'] : shape.length === 2 ? ['y', 'x'] : ['z'],
      chunk_grid: { name: 'regular', configuration: { chunk_shape: shape } },
      chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
      fill_value: type === 'uint8' ? 0 : 'NaN',
      codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
      attributes,
    };
    bytes.set(`/${path}/c/${shape.map(() => 0).join('/')}`, new Uint8Array(data.buffer));
  };
  for (const name of ['alpha', 'beta']) {
    const attrs = {
      'proj:code': 'EPSG:3857',
      'spatial:dimensions': ['y', 'x'],
      'spatial:registration': 'pixel',
      'spatial:shape': [4, 4],
      'spatial:transform': [250, 0, -500, 0, -250, 500],
      multiscales: {
        layout: [
          {
            asset: '0',
            'spatial:shape': [4, 4],
            'spatial:transform': [250, 0, -500, 0, -250, 500],
          },
          {
            asset: '1',
            'spatial:shape': [2, 2],
            'spatial:transform': [500, 0, -500, 0, -500, 500],
            derived_from: '0',
            resampling_method: 'average',
          },
        ],
      },
    };
    nodes[name] = { zarr_format: 3, node_type: 'group', attributes: attrs };
    const validity = new Uint8Array(32).fill(1);
    if (name === 'alpha') {
      validity[0] = 0;
    }
    array(
      `${name}/0`,
      [2, 4, 4],
      'float32',
      new Float32Array(32).fill(name === 'alpha' ? 0.2 : 0.8),
    );
    array(
      `${name}/1`,
      [2, 2, 2],
      'float32',
      new Float32Array(8).fill(name === 'alpha' ? 0.4 : 0.6),
    );
    array(`${name}/validity`, [2, 4, 4], 'uint8', validity);
    array(`${name}/ground`, [4, 4], 'float32', new Float32Array(16).fill(10), {
      actual_range: [10, 10],
    });
    array(`${name}/z`, [2], 'float32', new Float32Array([2.5, 7.5]), {
      units: 'm',
      positive: 'up',
    });
  }
  const doc = {
    zarr_format: 3,
    node_type: 'group',
    attributes: {},
    consolidated_metadata: { kind: 'inline', must_understand: false, metadata: nodes },
  };
  bytes.set('/zarr.json', new TextEncoder().encode(JSON.stringify(doc)));
  let reads = 0,
    active = 0,
    maxActive = 0;
  return {
    fields: ['alpha', 'beta'].map((path) => ({
      path,
      verticalCoordinates: 'z',
      groundElevation: 'ground',
      validity: 'validity',
    })),
    counts: () => ({ reads, maxActive }),
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const value = bytes.get(path);
      if (path.includes('/c/')) {
        reads++;
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        request.signal.throwIfAborted();
      }
      return new Response(value ?? null, { status: value ? 200 : 404 });
    },
  };
}
async function settled(source) {
  for (let i = 0; i < 500; i++) {
    const s = source.getStats();
    if (!s.active && !s.queued) {
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Not settled: ${JSON.stringify(source.getStats())}`);
}

test('native overlap ownership and gaps are deterministic; return visits reuse retained tiles', async () => {
  const f = fixture();
  const source = await GeoZarrCellSource.open('https://fixture.test/', {
    fields: f.fields,
    bins: 10,
    valueRange: [0, 1],
    fetch: f.fetch,
    maxRequests: 2,
    maxMeshBytes: 1000,
  });
  try {
    const viewport = new WebMercatorViewport({
      width: 600,
      height: 500,
      longitude: 0,
      latitude: 0,
      zoom: 15,
      pitch: 30,
    });
    source.update(viewport, 20);
    await settled(source);
    const tiles = source.getTiles();
    assert.equal(tiles.length, 2);
    const alpha = tiles.find((t) => t.field.path === 'alpha'),
      beta = tiles.find((t) => t.field.path === 'beta');
    assert.ok(alpha && beta);
    assert.ok(Number.isNaN(cellValue(alpha.mesh.grid, 0, 0, 0)));
    assert.equal(cellValue(beta.mesh.grid, 0, 0, 0), Math.fround(0.8));
    assert.ok(Number.isNaN(cellValue(beta.mesh.grid, 1, 0, 0)));
    const geometryBefore = source.getTiles()[0].mesh;
    source.update(viewport, 10);
    await settled(source);
    const { getCellMeshBounds } = await import('deck.gl-voxel');
    assert.deepEqual(source.getTiles()[0].bounds, getCellMeshBounds(source.getTiles()[0].mesh, 10));
    assert.equal(source.getTiles()[0].mesh, geometryBefore);
    source.update(viewport, 20);
    await settled(source);
    const before = f.counts().reads;
    const prepared = source.getStats().prepared;
    source.update(
      new WebMercatorViewport({ width: 600, height: 500, longitude: 100, latitude: 20, zoom: 12 }),
      20,
    );
    assert.equal(source.getTiles().length, 0);
    source.update(viewport, 20);
    await settled(source);
    assert.equal(f.counts().reads, before);
    assert.equal(
      source.getStats().prepared,
      prepared,
      'reuse the cached desired level even if its initial overview was evicted',
    );
    assert.ok(source.getStats().cacheHits >= 2);
    assert.ok(f.counts().maxActive <= 2);
    const debug = source.getDebugState();
    assert.ok(debug);
    assert.equal(debug.chunks.length, 2);
    assert.ok(debug.chunks.every((c) => c.id.includes('L0')));
  } finally {
    source.dispose();
  }
});

test('Zarrita decodes an actual start-index shard through the compatibility store', async () => {
  const { open, root } = await import('zarrita');
  const metadata = {
    zarr_format: 3,
    node_type: 'array',
    shape: [1, 1, 1],
    data_type: 'float32',
    chunk_grid: { name: 'regular', configuration: { chunk_shape: [1, 1, 1] } },
    chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
    fill_value: 'NaN',
    attributes: {},
    codecs: [
      {
        name: 'sharding_indexed',
        configuration: {
          chunk_shape: [1, 1, 1],
          codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
          index_codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
          index_location: 'start',
        },
      },
    ],
  };
  const shard = new Uint8Array(20),
    view = new DataView(shard.buffer);
  view.setBigUint64(0, 16n, true);
  view.setBigUint64(8, 4n, true);
  view.setFloat32(16, 42.25, true);
  const bytes = new TextEncoder().encode(JSON.stringify(metadata));
  const store = withStartShardIndexes(
    {
      get: async (path) => (path === '/field/zarr.json' ? bytes : undefined),
      getRange: async (_path, range) =>
        'suffixLength' in range
          ? shard.slice(-range.suffixLength)
          : shard.slice(range.offset, range.offset + range.length),
    },
    new Set(['/field']),
  );
  const array = await open.v3(root(store).resolve('/field'), { kind: 'array' });
  assert.equal((await array.getChunk([0, 0, 0])).data[0], 42.25);
});

test('temporary failures retain the loaded overview and recover without camera movement', async () => {
  const f = fixture();
  let remaining = 3;
  const source = await GeoZarrCellSource.open('https://fixture.test/', {
    fields: [f.fields[0]],
    bins: 10,
    valueRange: [0, 1],
    fetch: async (request) => {
      if (request.url.includes('/alpha/0/c/') && remaining-- > 0) {
        return new Response(null, { status: 503 });
      }
      return f.fetch(request);
    },
  });
  try {
    source.update(
      new WebMercatorViewport({
        width: 600,
        height: 500,
        longitude: 0,
        latitude: 0,
        zoom: 15,
        pitch: 30,
      }),
      20,
    );
    for (let i = 0; i < 300 && !source.getStats().errors.length; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(source.getStats().errors.length, 1);
    assert.equal(source.getTiles()[0].level, 1, 'the useful overview survives failed refinement');
    await settled(source);
    assert.equal(source.getTiles()[0].level, 0);
    assert.deepEqual(source.getStats().errors, []);
  } finally {
    source.dispose();
  }
});

test('adjacent levels have overlapping hysteresis rather than a shared toggle threshold', () => {
  const finer = selectCellLevel(1.51, 6, 1);
  assert.equal(finer, 0);
  assert.equal(selectCellLevel(1.48, 6, finer), 0);
  const coarser = selectCellLevel(0.99, 6, 0);
  assert.equal(coarser, 1);
  assert.equal(selectCellLevel(1.02, 6, coarser), 1);
});

test('shared shard-index reads follow collection lifetime while payload reads remain individually cancellable', async () => {
  const collection = new AbortController(),
    chunk = new AbortController();
  const signals = [];
  const store = withStartShardIndexes(
    {
      get: async () => undefined,
      getRange: async (_path, _range, options) => {
        signals.push(options.signal);
        return new Uint8Array();
      },
    },
    new Set(['/field']),
    collection.signal,
  );
  await store.getRange('/field/c/0', { suffixLength: 20 }, { signal: chunk.signal });
  await store.getRange('/field/c/0', { offset: 20, length: 8 }, { signal: chunk.signal });
  chunk.abort();
  assert.equal(signals[0], collection.signal);
  assert.equal(signals[0].aborted, false);
  assert.equal(signals[1].aborted, true);
  collection.abort();
  assert.equal(signals[0].aborted, true);
});

test('resolution uses both horizontal cell edges when rotating a pitched view by 90 degrees', async () => {
  const f = fixture();
  const source = await GeoZarrCellSource.open('https://fixture.test/', {
    fields: [f.fields[0]],
    bins: 10,
    valueRange: [0, 1],
    fetch: f.fetch,
  });
  try {
    const view = { width: 600, height: 500, longitude: 0, latitude: 0, zoom: 9, pitch: 80 };
    source.update(new WebMercatorViewport({ ...view, bearing: 0 }), 20);
    await settled(source);
    const level = source.getTiles()[0].level;
    assert.equal(level, 0);
    source.update(new WebMercatorViewport({ ...view, bearing: 90 }), 20);
    await settled(source);
    assert.equal(
      source.getTiles()[0].level,
      level,
      'A bearing change must not coarsen cells whose other horizontal edge remains clearly visible',
    );
  } finally {
    source.dispose();
  }
});
