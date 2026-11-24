import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { OrbitViewport } from '@deck.gl/core';
import { ZarrVoxelLayer } from '../dist/index.js';

const sourceOptions = {
  field: '.',
  layout: { axes: ['time', 'z', 'y', 'x'], origin: [0, 0, 0], spacing: [1, 1, 1] },
};

/** Exercises the loading lifecycle without allocating GPU resources. */
function mount(props, viewport) {
  const layer = new ZarrVoxelLayer({
    id: 'volume',
    source: 'https://zarr.invalid',
    sourceOptions,
    ...props,
  });
  if (viewport) {
    layer.context = { viewport };
  }
  layer.setState = (update) => {
    layer.state = { ...layer.state, ...update };
  };
  layer.getCurrentLayer = () => layer;
  layer.initializeState();
  layer.updateState({ props: layer.props, oldProps: {} });
  return layer;
}

function update(layer, props, changeFlags = {}) {
  const oldProps = layer.props;
  const next = layer.clone(props);
  next.state = layer.state;
  next.context = layer.context;
  next.setState = (state) => {
    next.state = { ...next.state, ...state };
  };
  next.getCurrentLayer = () => next;
  layer.getCurrentLayer = () => next;
  next.updateState({ props: next.props, oldProps, changeFlags });
  return next;
}

function serve(context) {
  const pending = [];
  const requests = [];
  context.mock.method(globalThis, 'fetch', async (request) => {
    const path = new URL(request.url).pathname;
    requests.push(path);
    if (path === '/zarr.json') {
      return Response.json({
        zarr_format: 3,
        node_type: 'array',
        shape: [3, 1, 1, 2],
        data_type: 'float32',
        chunk_grid: { name: 'regular', configuration: { chunk_shape: [1, 1, 1, 2] } },
        chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
        codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
        fill_value: 0,
        attributes: {},
      });
    }
    if (path.startsWith('/c/')) {
      // Deliberately ignore cancellation to verify stale results are rejected by the layer.
      return new Promise((resolve) => pending.push({ request, resolve }));
    }
    return new Response(null, { status: 404 });
  });
  return { pending, requests };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) {
      return;
    }
    await setImmediate();
  }
  assert.fail('Expected lifecycle transition did not occur');
}

function resolveFrame(pending, index, value) {
  pending[index].resolve(new Response(new Float32Array([value, value])));
}

test('frame changes cancel stale reads, preserve the reader and forward style without reloading', async (context) => {
  const { pending, requests } = serve(context);
  const volumes = [],
    states = [];
  let metadataLoads = 0;
  let layer = mount({
    onVolumeLoad: (volume) => volumes.push(volume),
    onSourceLoad: () => metadataLoads++,
    onLoadStateChange: (loading) => states.push(loading),
  });
  await waitFor(() => pending.length === 1);
  layer = update(layer, { frameIndex: 1 });
  await waitFor(() => pending.length === 2);
  assert.ok(pending[0].request.signal.aborted);
  resolveFrame(pending, 1, 0.75);
  await waitFor(() => volumes.length === 1);
  resolveFrame(pending, 0, 0.25);
  await setImmediate();
  assert.equal(volumes.length, 1);
  assert.deepEqual([...layer.state.volume.values], [0.75, 0.75]);
  assert.equal(metadataLoads, 1);
  assert.deepEqual(states, [true, false]);
  layer = update(layer, { density: 2, showBounds: true });
  const child = layer.renderLayers();
  assert.equal(child.props.density, 2);
  assert.equal(child.props.showBounds, true);
  assert.equal(child.props.volume, layer.state.volume);
  assert.equal(child.props.parameters.blendColorSrcFactor, 'one');
  assert.equal(child.id, 'volume-volume');
  assert.equal(requests.filter((path) => path === '/zarr.json').length, 1);
  assert.equal(pending.length, 2);
  layer.finalizeState();
});

test('source replacement and finalization abort pending reads without publishing them', async (context) => {
  const { pending } = serve(context);
  const volumes = [];
  let layer = mount({ onVolumeLoad: (volume) => volumes.push(volume) });
  await waitFor(() => pending.length === 1);
  layer = update(layer, { source: 'https://other.invalid' });
  await waitFor(() => pending.length === 2);
  assert.ok(pending[0].request.signal.aborted);
  resolveFrame(pending, 0, 0.1);
  await setImmediate();
  assert.equal(volumes.length, 0);
  layer.finalizeState();
  assert.ok(pending[1].request.signal.aborted);
  resolveFrame(pending, 1, 0.2);
  await setImmediate();
  assert.equal(volumes.length, 0);
});

test('failed replacement keeps the previous complete volume and reports idle', async (context) => {
  const { pending } = serve(context);
  const failures = [],
    states = [];
  let layer = mount({ onLoadStateChange: (loading) => states.push(loading) });
  layer.raiseError = (error) => failures.push(error);
  await waitFor(() => pending.length === 1);
  resolveFrame(pending, 0, 0.5);
  await waitFor(() => !layer.state.loading);
  const previous = layer.state.volume;
  layer = update(layer, { frameIndex: 10 });
  layer.raiseError = (error) => failures.push(error);
  await waitFor(() => failures.length === 1);
  assert.match(failures[0].message, /outside the Zarr field/);
  assert.equal(layer.state.volume, previous);
  assert.deepEqual(states, [true, false, true, false]);
  layer.finalizeState();
});

test('custom openers use the same cache and preload lifecycle without app-owned frame reads', async () => {
  const reads = [];
  const volumes = [];
  const states = [];
  let opened = 0;
  const source = async (signal) => {
    signal.throwIfAborted();
    opened++;
    return {
      level: '.',
      frameCount: 4,
      async readFrame(index, frameSignal) {
        frameSignal.throwIfAborted();
        reads.push(index);
        return { values: new Float32Array([index]), dimensions: [1, 1, 1] };
      },
    };
  };
  let layer = mount({
    source,
    preload: true,
    onVolumeLoad: (volume) => volumes.push(volume),
    onLoadStateChange: (busy) => states.push(busy),
  });
  await waitFor(() => reads.length === 4 && !layer.state.loading && !layer.state.buffering);
  assert.deepEqual(reads, [0, 1, 2, 3]);
  assert.deepEqual(states, [true, false]);
  layer = update(layer, { frameIndex: 1 });
  await waitFor(() => volumes.length === 2 && !layer.state.loading);
  assert.equal(opened, 1);
  assert.deepEqual(reads, [0, 1, 2, 3]);
  assert.equal(volumes[1].values[0], 1);
  layer.finalizeState();
});

test('a bounded frame cache evicts old frames', async () => {
  const reads = [];
  let layer = mount({
    source: async () => ({
      level: '.',
      frameCount: 3,
      async readFrame(index, signal) {
        signal.throwIfAborted();
        reads.push(index);
        return { values: new Float32Array([index]), dimensions: [1, 1, 1] };
      },
    }),
    maxCacheBytes: 4,
  });
  await waitFor(() => !layer.state.loading);
  layer = update(layer, { frameIndex: 1 });
  await waitFor(() => !layer.state.loading);
  layer = update(layer, { frameIndex: 0 });
  await waitFor(() => !layer.state.loading);
  assert.deepEqual(reads, [0, 1, 0]);
  layer.finalizeState();
});

test('disabling preload aborts background reads without hiding the displayed frame', async (context) => {
  const { pending } = serve(context);
  let layer = mount({ preload: true });
  await waitFor(() => pending.length === 1);
  resolveFrame(pending, 0, 0.5);
  await waitFor(() => pending.length === 2);
  assert.equal(layer.state.buffering, true);
  const displayed = layer.state.volume;
  layer = update(layer, { preload: false });
  assert.equal(layer.state.buffering, false);
  assert.ok(pending[1].request.signal.aborted);
  resolveFrame(pending, 1, 0.6);
  await setImmediate();
  assert.equal(pending.length, 2);
  assert.equal(layer.state.volume, displayed);
  layer.finalizeState();
});

test('frame timeouts reach onError and leave the current volume available', async () => {
  const failures = [];
  const frame = { values: new Float32Array([0.5]), dimensions: [1, 1, 1] };
  let layer = mount({
    requestTimeout: 5,
    source: async () => ({
      level: '.',
      frameCount: 2,
      async readFrame(index, signal) {
        if (index === 0) {
          return frame;
        }
        return new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      },
    }),
  });
  await waitFor(() => !layer.state.loading);
  layer = update(layer, { frameIndex: 1 });
  layer.raiseError = (error) => failures.push(error);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(failures.length, 1);
  assert.equal(failures[0].name, 'TimeoutError');
  assert.equal(layer.state.volume, frame);
  assert.equal(layer.state.loading, false);
  layer.finalizeState();
});

test('equivalent nested source options preserve metadata and cache across style and frame updates', async (context) => {
  const { pending, requests } = serve(context);
  const options = { ...structuredClone(sourceOptions), selection: {} };
  let layer = mount({ sourceOptions: options });
  await waitFor(() => pending.length === 1);
  resolveFrame(pending, 0, 0.5);
  await waitFor(() => !layer.state.loading);
  layer = update(layer, { sourceOptions: structuredClone(options), density: 2 });
  await setImmediate();
  assert.equal(requests.filter((path) => path === '/zarr.json').length, 1);
  assert.equal(pending.length, 1);
  layer = update(layer, { sourceOptions: structuredClone(options), frameIndex: 1 });
  await waitFor(() => pending.length === 2);
  resolveFrame(pending, 1, 0.75);
  await waitFor(() => !layer.state.loading);
  layer = update(layer, { frameIndex: 0 });
  await waitFor(() => !layer.state.loading);
  assert.equal(pending.length, 2, 'returning to a cached frame does not refetch');
  layer = update(layer, {
    sourceOptions: { ...options, layout: { ...options.layout, origin: [10, 0, 0] } },
  });
  await waitFor(() => pending.length === 3);
  assert.equal(requests.filter((path) => path === '/zarr.json').length, 2);
  resolveFrame(pending, 2, 0.5);
  await waitFor(() => !layer.state.loading);
  assert.deepEqual(layer.state.volume.origin, [10, 0, 0]);
  layer.finalizeState();
});

test('pausing preload preserves transport shared by the visible frame and caches its result', async (context) => {
  const { pending } = serve(context);
  let layer = mount({ preload: true });
  await waitFor(() => pending.length === 1);
  resolveFrame(pending, 0, 0.5);
  await waitFor(() => pending.length === 2);
  layer = update(layer, { frameIndex: 1 });
  await setImmediate();
  layer = update(layer, { preload: false });
  assert.equal(
    pending[1].request.signal.aborted,
    false,
    'visible read still owns the shared request',
  );
  resolveFrame(pending, 1, 0.75);
  await waitFor(() => !layer.state.loading);
  assert.deepEqual([...layer.state.volume.values], [0.75, 0.75]);
  assert.equal(pending.length, 2, 'successful shared data is not downloaded twice');
  layer = update(layer, { frameIndex: 0 });
  await waitFor(() => !layer.state.loading);
  layer = update(layer, { frameIndex: 1 });
  await waitFor(() => !layer.state.loading);
  assert.equal(pending.length, 2, 'shared frame remains cached');
  layer.finalizeState();
});

test('URL transport applies auth to every request and reopens when credentials change', async (context) => {
  const { pending } = serve(context);
  const seen = [];
  const transport = async (url, details) => {
    assert.equal(url, details.request.url);
    assert.equal(details.propName, 'source');
    assert.ok(details.layer instanceof ZarrVoxelLayer);
    assert.equal(details.signal, details.request.signal);
    seen.push(details.request);
    return globalThis.fetch(details.request);
  };
  const options = {
    core: { fetch: { headers: { Authorization: 'Bearer fixture' }, credentials: 'include' } },
  };
  let layer = mount({ fetch: transport, loadOptions: options });
  await waitFor(() => pending.length === 1);
  assert.ok(seen.length > 1);
  for (const request of seen) {
    assert.equal(request.headers.get('Authorization'), 'Bearer fixture');
    assert.equal(request.credentials, 'include');
  }
  resolveFrame(pending, 0, 0.5);
  await waitFor(() => !layer.state.loading);
  const count = seen.length;
  layer = update(layer, { loadOptions: structuredClone(options), density: 2 });
  await setImmediate();
  assert.equal(seen.length, count);
  layer = update(layer, {
    loadOptions: { fetch: { headers: { Authorization: 'Bearer replacement' } } },
  });
  await waitFor(() => pending.length === 2);
  for (const request of seen.slice(count)) {
    assert.equal(request.headers.get('Authorization'), 'Bearer replacement');
  }
  layer.finalizeState();
  assert.ok(pending[1].request.signal.aborted);
  resolveFrame(pending, 1, 0.75);
});

test('authenticated URL rewriting preserves coordinate reads and sharded byte ranges', async (context) => {
  context.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected global fetch');
  });
  const bytesCodec = { name: 'bytes', configuration: { endian: 'little' } };
  const shard = new Uint8Array(64);
  shard.set(new Uint8Array(new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer));
  const index = new DataView(shard.buffer, 32);
  [0n, 16n, 16n, 16n].forEach((value, offset) => {
    index.setBigUint64(offset * 8, value, true);
  });
  const metadata = (shape, names, attributes = {}) => ({
    zarr_format: 3,
    node_type: 'array',
    shape,
    data_type: 'float32',
    chunk_grid: { name: 'regular', configuration: { chunk_shape: shape } },
    chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
    codecs: [bytesCodec],
    fill_value: 0,
    dimension_names: names,
    attributes,
  });
  const grid = metadata([2, 2, 2], ['height', 'lat', 'lon'], {
    'proj:code': 'EPSG:4326',
    'spatial:dimensions': ['lat', 'lon'],
    'spatial:transform': [1, 0, -1, 0, -1, 1],
    'spatial:shape': [2, 2],
  });
  grid.codecs = [
    {
      name: 'sharding_indexed',
      configuration: {
        chunk_shape: [1, 2, 2],
        codecs: [bytesCodec],
        index_codecs: [bytesCodec],
        index_location: 'end',
      },
    },
  ];
  const seen = [];
  const fetch = async (url, { request }) => {
    const signed = new URL(url);
    signed.searchParams.set('signature', 'fixture');
    const rewritten = new Request(signed, request);
    seen.push(rewritten);
    assert.equal(rewritten.headers.get('Authorization'), 'Bearer fixture');
    const path = signed.pathname;
    if (path === '/zarr.json') {
      return Response.json({ zarr_format: 3, node_type: 'group', attributes: {} });
    }
    if (path === '/grid/zarr.json') {
      return Response.json(grid);
    }
    if (path === '/height/zarr.json') {
      return Response.json(metadata([2], ['height'], { units: 'm' }));
    }
    if (path === '/height/c/0') {
      return new Response(new Float32Array([5, 15]));
    }
    if (path === '/grid/c/0/0/0') {
      const range = rewritten.headers.get('Range');
      const match = /^bytes=(\d*)-(\d*)$/.exec(range ?? '');
      assert.ok(match, 'Zarrita byte ranges must survive the transport hook');
      const start = match[1] ? Number(match[1]) : shard.length - Number(match[2]);
      const end = match[1] && match[2] ? Number(match[2]) : shard.length - 1;
      return new Response(shard.slice(start, end + 1), {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${shard.length}`,
        },
      });
    }
    return new Response(null, { status: 404 });
  };
  const failures = [];
  const layer = mount({
    fetch,
    sourceOptions: { field: 'grid', verticalDimension: 'height', verticalCoordinates: 'height' },
    loadOptions: { core: { fetch: { headers: { Authorization: 'Bearer fixture' } } } },
  });
  layer.raiseError = (error) => failures.push(error);
  await waitFor(() => !layer.state.loading);
  assert.deepEqual(failures, []);
  assert.deepEqual([...layer.state.volume.values].map(Math.round), [3, 4, 1, 2, 7, 8, 5, 6]);
  const progressive = await layer.state.lifecycle.volumeReader.readView(0, {
    volumeToClip: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, -1, -1, -1, 1],
    signal: new AbortController().signal,
  });
  assert.deepEqual(progressive, layer.state.volume);
  assert.ok(seen.some((request) => new URL(request.url).pathname === '/height/c/0'));
  assert.ok(seen.some((request) => request.headers.get('Range') === 'bytes=-32'));
  assert.ok(
    seen.every((request) => new URL(request.url).searchParams.get('signature') === 'fixture'),
  );
  layer.finalizeState();
});

test('viewport reads publish partials, debounce cameras and reject stale frames after cancellation', async () => {
  const geometry = { dimensions: [2, 1, 1], origin: [0, 0, 0], spacing: [1, 1, 1] };
  const requests = [],
    states = [],
    completed = [];
  let disposals = 0;
  const viewport = (x) =>
    new OrbitViewport({ id: 'view', width: 400, height: 400, target: [x, 0, 0], zoom: 2 });
  const volume = (value) => ({ ...geometry, values: new Float32Array([value, value]) });
  let layer = mount(
    {
      debounceTime: 10,
      source: async () => ({
        geometry,
        frameCount: 2,
        level: '.',
        readFrame() {
          throw new Error('Viewport sources must not load full frames');
        },
        readView(index, query) {
          return new Promise((resolve) => requests.push({ index, query, resolve }));
        },
        dispose() {
          disposals++;
        },
      }),
      onLoadStateChange: (busy) => states.push(busy),
      onVolumeLoad: (result) => completed.push(result),
    },
    viewport(0),
  );
  await waitFor(() => requests.length === 1);
  const partial = { ...geometry, values: new Float32Array([0.5, NaN]) };
  requests[0].query.onProgress(partial);
  assert.equal(layer.state.volume, partial);
  assert.equal(layer.state.loading, true);
  assert.equal(completed.length, 0);
  layer = update(layer, { frameIndex: 1 });
  await waitFor(() => requests.length === 2);
  assert.equal(requests[0].query.signal.aborted, true);
  requests[0].query.onProgress(volume(99));
  assert.equal(layer.state.volume, partial);
  layer.context = { viewport: viewport(1) };
  layer = update(layer, {}, { viewportChanged: true });
  layer.context = { viewport: viewport(2) };
  layer = update(layer, {}, { viewportChanged: true });
  assert.equal(requests[1].query.signal.aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(requests.length, 3);
  assert.equal(requests[2].index, 1);
  requests[0].resolve(volume(99));
  requests[1].resolve(volume(98));
  const final = volume(0.75);
  requests[2].resolve(final);
  await waitFor(() => !layer.state.loading);
  assert.equal(layer.state.volume, final);
  assert.deepEqual(completed, [final]);
  assert.deepEqual(states, [true, false]);
  layer.context = { viewport: viewport(3) };
  layer = update(layer, {}, { viewportChanged: true });
  layer.finalizeState();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(requests.length, 3, 'finalization cancels a scheduled viewport query');
  assert.equal(disposals, 1);
});

test('custom openers receive layer budgets and reopen when either limit changes', async () => {
  const contexts = [];
  let disposed = 0;
  let layer = mount({
    maxCacheBytes: 123,
    maxRequests: 2,
    source: async (signal, context) => {
      signal.throwIfAborted();
      contexts.push(context);
      return {
        frameCount: 1,
        level: '.',
        readFrame: async () => ({ values: new Float32Array([1]), dimensions: [1, 1, 1] }),
        dispose: () => {
          disposed++;
        },
      };
    },
  });
  await waitFor(() => !layer.state.loading);
  assert.deepEqual(contexts, [{ maxCacheBytes: 123, maxRequests: 2 }]);
  layer = update(layer, { maxCacheBytes: 0 });
  await waitFor(() => !layer.state.loading);
  assert.deepEqual(contexts[1], { maxCacheBytes: 0, maxRequests: 2 });
  layer = update(layer, { maxRequests: 1 });
  await waitFor(() => !layer.state.loading);
  assert.deepEqual(contexts[2], { maxCacheBytes: 0, maxRequests: 1 });
  assert.equal(disposed, 2);
  layer.finalizeState();
  assert.equal(disposed, 3);
});

test('failed views restore the completed volume without reporting rollback as progress', async () => {
  const complete = { dimensions: [2, 1, 1], values: new Float32Array([1, 2]) };
  const partial = { dimensions: [2, 1, 1], values: new Float32Array([3, NaN]) };
  const progress = [],
    completed = [],
    failures = [];
  const viewport = new OrbitViewport({ width: 400, height: 400, target: [1, 0.5, 0.5], zoom: 5 });
  let layer = mount(
    {
      source: async () => ({
        geometry: { dimensions: complete.dimensions },
        frameCount: 3,
        level: '.',
        readFrame: async () => {
          throw new Error('Unexpected whole-frame read');
        },
        async readView(index, options) {
          if (index === 0) {
            return complete;
          }
          if (index === 1) {
            options.onProgress(partial);
          }
          throw new Error('Chunk failed');
        },
      }),
      onVolumeProgress: (volume) => progress.push(volume),
      onVolumeLoad: (volume) => completed.push(volume),
    },
    viewport,
  );
  layer.raiseError = (error) => failures.push(error);
  await waitFor(() => !layer.state.loading);
  layer = update(layer, { frameIndex: 1 });
  layer.raiseError = (error) => failures.push(error);
  await waitFor(() => !layer.state.loading);
  assert.equal(layer.state.volume, complete);
  assert.deepEqual(progress, [partial]);
  assert.deepEqual(completed, [complete]);
  layer = update(layer, { frameIndex: 2 });
  layer.raiseError = (error) => failures.push(error);
  await waitFor(() => !layer.state.loading);
  assert.equal(layer.state.volume, complete);
  assert.equal(failures.length, 2);
  assert.deepEqual(
    progress,
    [partial],
    'a failure before progress must not manufacture a progress event',
  );
  layer.finalizeState();
});
