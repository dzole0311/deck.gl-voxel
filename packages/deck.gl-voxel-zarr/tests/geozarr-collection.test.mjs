import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebMercatorViewport } from '@deck.gl/core';
import { worldToLngLat } from '@math.gl/web-mercator';
import { cellValue } from 'deck.gl-voxel';
import {
  discoverGeoZarrFields,
  GeoZarrCollection,
  selectOverviewLevel,
} from '../dist/readers/geozarr-collection.js';

globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(performance.now()), 0);
globalThis.cancelAnimationFrame ??= clearTimeout;

test('local screen error selects useful stored levels with hysteresis around transitions', () => {
  assert.equal(selectOverviewLevel(5, 6), 0);
  assert.equal(selectOverviewLevel(0.2, 6), 3);
  assert.equal(selectOverviewLevel(0.01, 6), 5);
  assert.equal(selectOverviewLevel(0.95, 6, 1), 1);
  assert.equal(selectOverviewLevel(1.49, 6, 1), 1);
  assert.equal(selectOverviewLevel(1.6, 6, 1), 0);
});

function fixture(groundValues = {}, consolidated = true, prefix = '') {
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
    const path = prefix ? `${prefix}/${name}` : name;
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
    nodes[path] = { zarr_format: 3, node_type: 'group', attributes: attrs };
    const validity = new Uint8Array(32).fill(1);
    if (name === 'alpha') {
      validity[0] = 0;
    }
    array(
      `${path}/0`,
      [2, 4, 4],
      'float32',
      new Float32Array(32).fill(name === 'alpha' ? 0.2 : 0.8),
    );
    array(
      `${path}/1`,
      [2, 2, 2],
      'float32',
      new Float32Array(8).fill(name === 'alpha' ? 0.4 : 0.6),
    );
    array(`${path}/validity`, [2, 4, 4], 'uint8', validity);
    const ground = groundValues[name] ?? new Float32Array(16).fill(10);
    const finiteGround = ground.filter(Number.isFinite);
    array(`${path}/ground`, [4, 4], 'float32', ground, {
      actual_range: [Math.min(...finiteGround), Math.max(...finiteGround)],
    });
    array(`${path}/z`, [2], 'float32', new Float32Array([2.5, 7.5]), {
      units: 'm',
      positive: 'up',
    });
  }
  const doc = {
    zarr_format: 3,
    node_type: 'group',
    attributes: {},
    ...(consolidated
      ? { consolidated_metadata: { kind: 'inline', must_understand: false, metadata: nodes } }
      : {}),
  };
  for (const [path, node] of Object.entries(nodes)) {
    bytes.set(`/${path}/zarr.json`, new TextEncoder().encode(JSON.stringify(node)));
  }
  bytes.set('/zarr.json', new TextEncoder().encode(JSON.stringify(doc)));
  let reads = 0,
    active = 0,
    maxActive = 0;
  return {
    fields: ['alpha', 'beta'].map((name) => ({
      path: prefix ? `${prefix}/${name}` : name,
      verticalCoordinates: 'z',
      groundElevation: 'ground',
      validity: 'validity',
    })),
    counts: () => ({ reads, maxActive }),
    store: {
      async get(path, options) {
        options?.signal?.throwIfAborted();
        return bytes.get(path);
      },
    },
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

test('catalog discovery uses custom fetch and reads metadata without coordinate or payload chunks', async () => {
  const f = fixture();
  const paths = [];
  const fields = await discoverGeoZarrFields('https://fixture.test/', {
    fetch: (request) => {
      paths.push(new URL(request.url).pathname);
      return f.fetch(request);
    },
  });
  assert.deepEqual(
    fields.map((field) => field.path),
    ['alpha', 'beta'],
  );
  assert.ok(fields.every((field) => field.attributes['proj:code'] === 'EPSG:3857'));
  assert.deepEqual(paths, ['/zarr.json']);
  assert.equal(f.counts().reads, 0);
});

test('catalog discovery propagates caller cancellation to the custom fetch', async () => {
  const controller = new AbortController();
  let notifyStarted = () => {};
  const started = new Promise((resolve) => {
    notifyStarted = resolve;
  });
  let receivedSignal;
  const discovering = discoverGeoZarrFields('https://fixture.test/', {
    signal: controller.signal,
    fetch: (request) => {
      receivedSignal = request.signal;
      notifyStarted();
      return new Promise((_, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason), {
          once: true,
        });
      });
    },
  });
  await started;
  const reason = new Error('Catalog loading cancelled.');
  controller.abort(reason);
  await assert.rejects(discovering, { message: reason.message });
  assert.equal(receivedSignal.aborted, true);
  assert.equal(receivedSignal.reason, reason);
});

test('native overlap ownership and gaps are deterministic; return visits reuse retained tiles', async () => {
  const f = fixture();
  const source = await GeoZarrCollection.open('https://fixture.test/', {
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

test('ground samplers capture loaded grids without reads and preserve physical zero and NaN lookup', async () => {
  const alpha = new Float32Array(16).fill(Number.NaN);
  alpha[0] = 0;
  alpha[1] = 11;
  alpha[4] = 22;
  const beta = new Float32Array(16).fill(30);
  beta[3] = Number.NaN;
  const f = fixture({ alpha, beta });
  const source = await GeoZarrCollection.open('https://fixture.test/', {
    fields: f.fields,
    bins: 10,
    valueRange: [0, 1],
    fetch: f.fetch,
  });
  const viewport = new WebMercatorViewport({
    width: 600,
    height: 500,
    longitude: 0,
    latitude: 0,
    zoom: 15,
    farZMultiplier: 4,
  });
  try {
    const beforeLoading = source.createGroundSampler();
    const startupReads = f.counts().reads;
    assert.equal(beforeLoading(0, 0), undefined);
    assert.equal(f.counts().reads, startupReads);
    source.update(viewport, 20);
    await settled(source);
    assert.deepEqual(
      source.getTiles().map((tile) => tile.field.path),
      ['alpha', 'beta'],
    );
    const grid = source.getTiles()[0].mesh.grid;
    assert.ok(grid.spacing[1] < 0);
    const sample = source.createGroundSampler();
    const position = (x, y) =>
      worldToLngLat([
        grid.origin[0] + (x + 0.5) * grid.spacing[0],
        grid.origin[1] + (y + 0.5) * grid.spacing[1],
      ]);
    const reads = f.counts().reads;
    assert.equal(sample(...position(0, 0)), 0);
    assert.equal(sample(...position(1, 0)), 11);
    assert.equal(sample(...position(0, 1)), 22);
    assert.equal(sample(...position(2, 0)), 30);
    assert.equal(sample(...position(3, 0)), undefined);
    assert.equal(sample(180, 0), undefined);
    assert.equal(beforeLoading(...position(0, 0)), undefined);
    assert.equal(f.counts().reads, reads);
    source.update(viewport, 20, new Set(['beta']));
    await settled(source);
    const changedReads = f.counts().reads;
    assert.equal(source.createGroundSampler()(...position(0, 0)), 30);
    assert.equal(sample(...position(0, 0)), 0);
    assert.equal(sample(...position(1, 0)), 11);
    assert.equal(f.counts().reads, changedReads);
  } finally {
    source.dispose();
  }
});

test('pausing cancels active reads and keeps view changes dormant until resume', async () => {
  const f = fixture();
  let hold = false;
  const blocked = [];
  const source = await GeoZarrCollection.open('https://fixture.test/', {
    fields: f.fields,
    bins: 10,
    valueRange: [0, 1],
    fetch: async (request) => {
      request.signal.throwIfAborted();
      if (hold && new URL(request.url).pathname.includes('/c/')) {
        blocked.push(request.signal);
        await new Promise((_, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
        });
      }
      return f.fetch(request);
    },
  });
  const viewport = new WebMercatorViewport({
    width: 600,
    height: 500,
    longitude: 0,
    latitude: 0,
    zoom: 15,
  });
  try {
    hold = true;
    source.update(viewport, 20);
    for (let i = 0; i < 100 && blocked.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(blocked.length > 0, 'start real reads before pausing');
    source.setPaused(true);
    assert.ok(blocked.every((signal) => signal.aborted));
    assert.equal(source.getStats().active, 0);
    assert.equal(source.getStats().queued, 0);
    const started = blocked.length;
    source.update(viewport, 20, new Set(['beta']));
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(blocked.length, started, 'no replacement reads or retries while paused');
    assert.deepEqual(source.getStats().errors, []);
    hold = false;
    source.setPaused(false);
    source.setPaused(true);
    source.setPaused(false);
    await settled(source);
    assert.ok(source.getTiles().length > 0);
    assert.ok(source.getTiles().every((tile) => tile.field.path === 'beta'));
    assert.deepEqual(source.getStats().errors, []);
    const tiles = source.getTiles();
    const reads = f.counts().reads;
    source.setPaused(true);
    assert.ok(
      source.getDebugState().chunks.every((chunk) => chunk.status === 'ready'),
      'paused cached tiles retain their logical chunk metadata',
    );
    source.setPaused(false);
    await settled(source);
    assert.deepEqual(source.getTiles(), tiles, 'resuming retains prepared meshes');
    assert.equal(f.counts().reads, reads, 'cached tiles do not download again');
  } finally {
    source.dispose();
  }
});

test('temporary failures retain the loaded overview and recover without camera movement', async () => {
  const f = fixture();
  let remaining = 3;
  const source = await GeoZarrCollection.open('https://fixture.test/', {
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
  const finer = selectOverviewLevel(1.51, 6, 1);
  assert.equal(finer, 0);
  assert.equal(selectOverviewLevel(1.48, 6, finer), 0);
  const coarser = selectOverviewLevel(0.99, 6, 0);
  assert.equal(coarser, 1);
  assert.equal(selectOverviewLevel(1.02, 6, coarser), 1);
});

test('resolution uses both horizontal cell edges when rotating a pitched view by 90 degrees', async () => {
  const f = fixture();
  const source = await GeoZarrCollection.open('https://fixture.test/', {
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

test('inspector reports clipped displayed envelopes without changing cached source tiles', async () => {
  const f = fixture();
  const source = await GeoZarrCollection.open('https://fixture.test/', {
    fields: f.fields,
    bins: 10,
    valueRange: [0, 1],
    fetch: f.fetch,
  });
  try {
    source.update(
      new WebMercatorViewport({ width: 600, height: 500, longitude: 0, latitude: 0, zoom: 15 }),
      20,
    );
    await settled(source);
    const tiles = source.getTiles();
    const grid = tiles[0].mesh.grid;
    const x0 = Math.min(grid.origin[0], grid.origin[0] + grid.spacing[0] * grid.dimensions[0]);
    const y0 = Math.min(grid.origin[1], grid.origin[1] + grid.spacing[1] * grid.dimensions[1]);
    const width = Math.abs(grid.spacing[0] * grid.dimensions[0]);
    const height = Math.abs(grid.spacing[1] * grid.dimensions[1]);
    const bounds = [
      x0 + width / 4,
      y0 + height / 4,
      2,
      x0 + (width * 3) / 4,
      y0 + (height * 3) / 4,
      3,
    ];
    const reads = f.counts().reads;
    const before = source.getDebugState();
    const state = source.getDebugState(bounds);
    assert.ok(before && state);
    assert.equal(state.geometry.origin[0], bounds[0]);
    assert.equal(state.geometry.origin[1], bounds[1]);
    assert.ok(Math.abs(state.geometry.origin[0] + state.geometry.spacing[0] - bounds[3]) < 1e-12);
    assert.ok(Math.abs(state.geometry.origin[1] + state.geometry.spacing[1] - bounds[4]) < 1e-12);
    const scale = grid.elevationScales[0];
    assert.ok(Math.abs(state.geometry.origin[2] - (10 + 20 * (2 - 10)) * scale) < 1e-8);
    assert.ok(
      Math.abs(
        state.geometry.origin[2] + state.geometry.spacing[2] - (10 + 20 * (3 - 10)) * scale,
      ) < 1e-8,
    );
    assert.ok(state.chunks.every((chunk) => chunk.status === 'ready'));
    assert.ok(
      source
        .getDebugState([bounds[0], bounds[1], 1000, bounds[3], bounds[4], 1001])
        .chunks.every((chunk) => chunk.empty),
    );
    assert.deepEqual(source.getDebugState(), before);
    assert.deepEqual(source.getTiles(), tiles);
    assert.equal(f.counts().reads, reads);
  } finally {
    source.dispose();
  }
});

test('inspector clips displayed contributions while in-flight refinement keeps requested world bounds', async () => {
  const f = fixture();
  const requests = [];
  let heldFiner = 0;
  let releaseFiner = () => {};
  const finerGate = new Promise((resolve) => {
    releaseFiner = resolve;
  });
  const source = await GeoZarrCollection.open('https://fixture.test/', {
    fields: [f.fields[0]],
    bins: 10,
    valueRange: [0, 1],
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path.includes('/alpha/0/c/')) {
        heldFiner++;
        request.signal.throwIfAborted();
        await new Promise((resolve, reject) => {
          const abort = () => reject(request.signal.reason);
          request.signal.addEventListener('abort', abort, { once: true });
          void finerGate.then(() => {
            request.signal.removeEventListener('abort', abort);
            resolve();
          });
        });
      }
      return f.fetch(request);
    },
  });
  const worldBounds = (state, chunk) => {
    const origin = state.geometry.origin;
    const extent = state.geometry.spacing.map(
      (spacing, axis) => spacing * state.geometry.dimensions[axis],
    );
    return [
      ...chunk.min.map((fraction, axis) => origin[axis] + fraction * extent[axis]),
      ...chunk.max.map((fraction, axis) => origin[axis] + fraction * extent[axis]),
    ];
  };
  try {
    source.update(
      new WebMercatorViewport({ width: 600, height: 500, longitude: 0, latitude: 0, zoom: 15 }),
      20,
    );
    for (let i = 0; i < 100 && heldFiner === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(
      heldFiner,
      1,
      'hold a real finer scalar request after the overview becomes useful',
    );
    const tiles = source.getTiles();
    assert.equal(tiles.length, 1);
    assert.equal(tiles[0].level, 1);
    const grid = tiles[0].mesh.grid;
    const x0 = Math.min(grid.origin[0], grid.origin[0] + grid.spacing[0] * grid.dimensions[0]);
    const y0 = Math.min(grid.origin[1], grid.origin[1] + grid.spacing[1] * grid.dimensions[1]);
    const width = Math.abs(grid.spacing[0] * grid.dimensions[0]);
    const height = Math.abs(grid.spacing[1] * grid.dimensions[1]);
    const clip = [
      x0 + width / 4,
      y0 + height / 4,
      2,
      x0 + (width * 3) / 4,
      y0 + (height * 3) / 4,
      3,
    ];
    const stats = source.getStats();
    const beforeRequests = [...requests];
    const beforeCounts = f.counts();
    const before = source.getDebugState();
    const clipped = source.getDebugState(clip);
    assert.ok(before && clipped);
    const pending = before.chunks.filter((chunk) => chunk.id.endsWith(' pending'));
    const clippedPending = clipped.chunks.filter((chunk) => chunk.id.endsWith(' pending'));
    const displayed = clipped.chunks.filter((chunk) => chunk.id.endsWith(' displayed'));
    assert.equal(pending.length, 1);
    assert.equal(clippedPending.length, 1);
    assert.equal(displayed.length, 1);
    assert.deepEqual(worldBounds(clipped, clippedPending[0]), worldBounds(before, pending[0]));
    assert.deepEqual(
      clipped.geometry,
      before.geometry,
      'the uncut requested contribution remains in the envelope',
    );
    const displayedWorld = worldBounds(clipped, displayed[0]);
    const expected = [
      clip[0],
      clip[1],
      (10 + 20 * (clip[2] - 10)) * grid.elevationScales[0],
      clip[3],
      clip[4],
      (10 + 20 * (clip[5] - 10)) * grid.elevationScales[0],
    ];
    for (let axis = 0; axis < 6; axis++) {
      assert.ok(Math.abs(displayedWorld[axis] - expected[axis]) < 1e-10);
    }
    assert.deepEqual(
      clipped.chunks.map(({ id, status }) => ({ id, status })),
      before.chunks.map(({ id, status }) => ({ id, status })),
    );
    assert.ok(
      clipped.chunks.every((chunk) =>
        [...chunk.min, ...chunk.max].every((value) => value >= 0 && value <= 1),
      ),
    );
    assert.deepEqual(source.getStats(), stats);
    assert.deepEqual(source.getTiles(), tiles);
    assert.deepEqual(requests, beforeRequests);
    assert.deepEqual(f.counts(), beforeCounts);
    assert.deepEqual(source.getDebugState(), before);
    releaseFiner();
    await settled(source);
    assert.equal(source.getTiles()[0].level, 0);
  } finally {
    releaseFiner();
    source.dispose();
  }
});

test('opened stores read explicit fields and exact selectors without a consolidated catalog', async (context) => {
  context.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected HTTP request');
  });
  const f = fixture({}, false);
  for (const selection of [
    { fields: [f.fields[0]] },
    { field: 'alpha', verticalCoordinates: 'z', groundElevation: 'ground', validity: 'validity' },
  ]) {
    const collection = await GeoZarrCollection.open(f.store, {
      ...selection,
      bins: 10,
      valueRange: [0, 1],
    });
    try {
      collection.update(
        new WebMercatorViewport({ width: 600, height: 500, longitude: 0, latitude: 0, zoom: 15 }),
        20,
      );
      await settled(collection);
      assert.equal(collection.getTiles().length, 1);
      assert.equal(collection.getTiles()[0].field.path, 'alpha');
      assert.equal(cellValue(collection.getTiles()[0].mesh.grid, 1, 0, 0), Math.fround(0.2));
      assert.equal(f.counts().reads, 0);
    } finally {
      collection.dispose();
    }
  }
  await assert.rejects(discoverGeoZarrFields(f.store), /discovery requires consolidated/);
});

test('a field prefix expands catalog entries while an exact selector keeps one field', async () => {
  const f = fixture({}, true, 'surveys');
  for (const [field, expected] of [
    ['surveys', ['surveys/alpha', 'surveys/beta']],
    ['surveys/alpha', ['surveys/alpha']],
  ]) {
    const collection = await GeoZarrCollection.open(f.store, {
      field,
      verticalCoordinates: 'z',
      groundElevation: 'ground',
      validity: 'validity',
      bins: 10,
      valueRange: [0, 1],
    });
    assert.deepEqual(
      collection.fields.map((item) => item.path),
      expected,
    );
    collection.dispose();
  }
});

test('nonconsolidated collection fields adapt start-index shards without an HTTP backend', async (context) => {
  context.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected HTTP request');
  });
  const f = fixture({}, false);
  const path = '/alpha/0';
  const metadata = JSON.parse(new TextDecoder().decode(await f.store.get(`${path}/zarr.json`)));
  const payload = await f.store.get(`${path}/c/0/0/0`);
  const bytes = { name: 'bytes', configuration: { endian: 'little' } };
  metadata.codecs = [
    {
      name: 'sharding_indexed',
      configuration: {
        chunk_shape: [2, 4, 4],
        codecs: [bytes],
        index_codecs: [bytes],
        index_location: 'start',
      },
    },
  ];
  const shard = new Uint8Array(16 + payload.length);
  const index = new DataView(shard.buffer);
  index.setBigUint64(0, 16n, true);
  index.setBigUint64(8, BigInt(payload.length), true);
  shard.set(payload, 16);
  const encoded = new TextEncoder().encode(JSON.stringify(metadata));
  const ranges = [];
  const store = {
    get: (key, options) =>
      key === `${path}/zarr.json` ? Promise.resolve(encoded) : f.store.get(key, options),
    getRange: async (key, range, options) => {
      options?.signal?.throwIfAborted();
      assert.equal(key, `${path}/c/0/0/0`);
      assert.ok('offset' in range);
      ranges.push(range);
      return shard.slice(range.offset, range.offset + range.length);
    },
  };
  const collection = await GeoZarrCollection.open(store, {
    fields: [f.fields[0]],
    bins: 10,
    valueRange: [0, 1],
  });
  try {
    collection.update(
      new WebMercatorViewport({ width: 600, height: 500, longitude: 0, latitude: 0, zoom: 15 }),
      20,
    );
    await settled(collection);
    const tile = collection.getTiles()[0];
    assert.equal(tile.level, 0);
    assert.equal(cellValue(tile.mesh.grid, 1, 0, 0), Math.fround(0.2));
    assert.ok(Number.isNaN(cellValue(tile.mesh.grid, 0, 0, 0)));
    assert.deepEqual(ranges, [
      { offset: 0, length: 16 },
      { offset: 16, length: payload.length },
    ]);
  } finally {
    collection.dispose();
  }
});

test('mesh budget status follows retained bytes after clearing fields and disposing', async () => {
  const f = fixture();
  const collection = await GeoZarrCollection.open(f.store, {
    fields: f.fields,
    bins: 10,
    valueRange: [0, 1],
    maxMeshBytes: 1,
  });
  const viewport = new WebMercatorViewport({
    width: 600,
    height: 500,
    longitude: 0,
    latitude: 0,
    zoom: 15,
  });
  try {
    collection.update(viewport, 20);
    await settled(collection);
    assert.ok(collection.getStats().meshBytes > 1);
    assert.equal(collection.getStats().budgetLimited, true);
    collection.update(viewport, 20, new Set());
    assert.equal(collection.getStats().meshBytes, 0);
    assert.equal(collection.getStats().budgetLimited, false);
    collection.update(viewport, 20, new Set(f.fields.map((field) => field.path)));
    await settled(collection);
    assert.ok(collection.getStats().meshBytes > 1);
    assert.equal(collection.getStats().budgetLimited, true);
    collection.dispose();
    assert.equal(collection.getStats().meshBytes, 0);
    assert.equal(collection.getStats().budgetLimited, false);
  } finally {
    collection.dispose();
  }
});
