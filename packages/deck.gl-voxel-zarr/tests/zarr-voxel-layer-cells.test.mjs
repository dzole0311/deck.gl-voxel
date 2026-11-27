import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { WebMercatorViewport } from '@deck.gl/core';
import { GeoZarrCollection, ZarrVoxelLayer } from '../dist/index.js';
import { CollectionLoadingLayer } from '../dist/loading/collection-loading-layer.js';

const sourceOptions = {
  field: 'fraction',
  verticalCoordinates: 'z',
  groundElevation: 'ground',
  validity: 'validity',
};
const palette = new Uint8Array([0, 0, 255, 255, 255, 0, 0, 255]);

/** Models a borrowed reader while recording the selection active when fetching resumes. */
function reader() {
  const calls = [],
    listeners = new Set();
  let paused = false,
    view;
  return {
    calls,
    requests: [],
    disposed: 0,
    getStats: () => ({ active: 0, queued: 0 }),
    getTiles: () => [],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify() {
      for (const listener of listeners) {
        listener();
      }
    },
    setPaused(value) {
      calls.push(['paused', value]);
      if (paused && !value && view) {
        this.requests.push(view);
      }
      paused = value;
    },
    update(viewport, exaggeration, fields) {
      calls.push(['view', viewport.id, exaggeration, fields]);
      view = viewport.id;
      if (!paused) {
        this.requests.push(view);
      }
    },
    dispose() {
      this.disposed++;
      listeners.clear();
    },
  };
}

function facade(props = {}) {
  return new ZarrVoxelLayer({
    id: 'collection',
    renderMode: 'cells',
    source: 'https://fixture.invalid/',
    sourceOptions,
    palette,
    ...props,
  });
}

/** Drives package lifecycle code without a GPU. */
function mount(props, viewport = { id: 'first' }) {
  const parent = facade(props),
    layer = parent.renderLayers();
  layer.parent = parent;
  layer.context = { viewport };
  layer.getCurrentLayer = () => layer;
  layer.setState = (state) => {
    layer.state = { ...layer.state, ...state };
  };
  layer.initializeState();
  layer.updateState({ props: layer.props, oldProps: {}, changeFlags: {} });
  return layer;
}

function update(layer, props, changeFlags = {}) {
  const parent = layer.parent.clone(props),
    next = parent.renderLayers();
  next.parent = parent;
  next.context = layer.context;
  next.state = layer.state;
  next.setState = (state) => {
    next.state = { ...next.state, ...state };
  };
  next.getCurrentLayer = () => next;
  layer.getCurrentLayer = () => next.getCurrentLayer();
  next.updateState({ props: next.props, oldProps: layer.props, changeFlags });
  return next;
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) {
      return;
    }
    await setImmediate();
  }
  assert.fail('Expected collection lifecycle transition.');
}

test('one public URL layer chooses a renderer without mixing defaults or clipping units', () => {
  const cells = facade({ physicalClipBounds: [-1, -1, 0, 1, 1, 10] });
  facade().validateProps();
  facade().renderLayers().validateProps();
  assert.equal(cells.props.pickable, true);
  assert.equal(cells.props.coordinateSystem, 'cartesian');
  const child = cells.renderLayers();
  assert.ok(child instanceof CollectionLoadingLayer);
  assert.equal(child.props.physicalClipBounds, cells.props.physicalClipBounds);
  assert.equal(child.props.clipBounds, undefined);
  assert.equal(child.props.maxCacheBytes, undefined);
  assert.equal(facade({ pickable: false }).renderLayers().props.pickable, false);
  const dense = new ZarrVoxelLayer({ id: 'dense', source: 'https://fixture.invalid/' });
  assert.equal(dense.props.pickable, false);
  assert.equal(dense.renderLayers().props.coordinateSystem, 'cartesian');
  assert.equal(dense.renderLayers().props.maxCacheBytes, 64 * 1024 * 1024);
});

test('actual Deck null load options open a URL collection without a custom transport', async (context) => {
  const requests = [],
    errors = [];
  context.mock.method(globalThis, 'fetch', async (request) => {
    requests.push(new URL(request.url).pathname);
    return Response.json({
      zarr_format: 3,
      node_type: 'group',
      attributes: {},
      consolidated_metadata: { kind: 'inline', metadata: {} },
    });
  });
  globalThis.requestAnimationFrame ??= (callback) =>
    setTimeout(() => callback(performance.now()), 0);
  globalThis.cancelAnimationFrame ??= clearTimeout;
  const layer = mount(
    { sourceOptions: { fields: [] }, onError: (error) => errors.push(error) },
    new WebMercatorViewport({ width: 600, height: 400, longitude: 0, latitude: 0, zoom: 10 }),
  );
  assert.equal(layer.props.loadOptions, null);
  await waitFor(() => layer.state.lifecycle.reader || errors.length);
  assert.deepEqual(errors, []);
  assert.ok(layer.state.lifecycle.reader);
  assert.deepEqual(requests, ['/zarr.json']);
  layer.finalizeState();
});

test('style, equivalent options and equivalent field sets retain the collection and current callbacks', async (context) => {
  const source = reader(),
    updates = [];
  let opens = 0,
    options;
  context.mock.method(GeoZarrCollection, 'open', async (_input, settings) => {
    opens++;
    options = settings;
    return source;
  });
  let layer = mount({
    selectedFields: new Set(['alpha']),
    onSourceUpdate: () => updates.push('old'),
  });
  await waitFor(() => layer.state.lifecycle.reader);
  assert.equal(options.bins, 2);
  assert.deepEqual(options.valueRange, [0, 1]);
  const viewCalls = source.calls.filter(([kind]) => kind === 'view').length;
  layer = update(layer, {
    palette: palette.slice(),
    sourceOptions: { ...sourceOptions },
    selectedFields: new Set(['alpha']),
    physicalClipBounds: [-1, -1, 0, 1, 1, 10],
    onSourceUpdate: () => updates.push('current'),
  });
  source.notify();
  layer.updateState({
    props: layer.props,
    oldProps: layer.props,
    changeFlags: { stateChanged: true },
  });
  assert.equal(opens, 1);
  assert.equal(updates.at(-1), 'current');
  assert.equal(source.calls.filter(([kind]) => kind === 'view').length, viewCalls);
  layer = update(layer, { selectedFields: new Set(['beta']) });
  assert.equal(opens, 1);
  assert.deepEqual(source.calls.findLast(([kind]) => kind === 'view')[3], new Set(['beta']));
  layer.finalizeState();
  layer.finalizeState();
  assert.equal(source.disposed, 1);
});

test('hiding pauses first and showing selects the current Deck view before resuming', async (context) => {
  const source = reader();
  context.mock.method(GeoZarrCollection, 'open', async () => source);
  let layer = mount();
  await waitFor(() => layer.state.lifecycle.reader);
  layer = update(layer, { visible: false });
  const reads = source.requests.length;
  let latest = { id: 'first', camera: 'hidden-pan' };
  layer.context.deck = { getViewports: () => [latest] };
  layer = update(layer, {}, { viewportChanged: true });
  assert.equal(source.requests.length, reads);
  latest = { id: 'first', camera: 'final-pan' };
  const seen = [];
  source.update = (viewport) => seen.push(viewport);
  layer = update(layer, { visible: true });
  assert.equal(seen.at(-1), latest);
  assert.deepEqual(source.calls.at(-1), ['paused', false]);
  layer.finalizeState();
});

test('an initially hidden layer opens metadata without starting payload work', async (context) => {
  const source = reader();
  context.mock.method(GeoZarrCollection, 'open', async () => source);
  const layer = mount({ visible: false });
  await waitFor(() => layer.state.lifecycle.reader);
  assert.deepEqual(source.calls[0], ['paused', true]);
  assert.equal(source.requests.length, 0);
  layer.finalizeState();
});

test('replacement aborts obsolete store openers before they can open or publish a collection', async (context) => {
  const source = reader(),
    loaded = [];
  let release,
    signal,
    opens = 0;
  context.mock.method(GeoZarrCollection, 'open', async () => {
    opens++;
    return source;
  });
  let layer = mount({
    source: (request) => {
      signal = request;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    onSourceLoad: () => loaded.push('obsolete'),
  });
  layer = update(layer, {
    source: 'https://replacement.invalid/',
    onSourceLoad: () => loaded.push('current'),
  });
  assert.ok(signal.aborted);
  release({ get: () => undefined });
  await waitFor(() => loaded.length);
  assert.deepEqual(loaded, ['current']);
  assert.equal(opens, 1);
  layer.finalizeState();
  assert.equal(source.disposed, 1);
});

test('a collection resolved after finalization is disposed without publishing', async (context) => {
  const source = reader();
  let resolve,
    loaded = 0;
  context.mock.method(
    GeoZarrCollection,
    'open',
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const layer = mount({ onSourceLoad: () => loaded++ });
  layer.finalizeState();
  resolve(source);
  await setImmediate();
  assert.equal(loaded, 0);
  assert.equal(source.disposed, 1);
});
