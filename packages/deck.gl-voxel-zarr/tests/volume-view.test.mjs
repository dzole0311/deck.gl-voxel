import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { openZarrVolume } from '../dist/index.js';
import { volumeBoxVisible } from '../dist/volume-view.js';

const fullView = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, -1, -1, -1, 1];
const leftView = [8, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, -1, -1, -1, 1];
const rightView = [...leftView.slice(0, 12), -7, -1, -1, 1];

async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) {
      return;
    }
    await setImmediate();
  }
  assert.fail('Expected progressive read did not settle');
}

function fixture(context, version, geo) {
  const names = geo ? ['time', 'height', 'lat', 'lon'] : ['x', 'run', 'time', 'z', 'y'];
  const lengths = { x: 8, lon: 8, y: 4, lat: 4, z: 2, height: 2, time: 2, run: 2 };
  const sizes = { x: 2, lon: 2, y: 2, lat: 2, z: 1, height: 1, time: 2, run: 1 };
  const shape = names.map((name) => lengths[name]),
    chunks = names.map((name) => sizes[name]);
  const attributes = geo
    ? {
        'proj:code': 'EPSG:4326',
        'spatial:dimensions': ['lat', 'lon'],
        'spatial:shape': [4, 8],
        'spatial:transform': [1, 0, -4, 0, -1, 2],
      }
    : {};
  const metadata = {
    zarr_format: 3,
    node_type: 'array',
    shape,
    data_type: 'float32',
    chunk_grid: { name: 'regular', configuration: { chunk_shape: chunks } },
    chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
    codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
    fill_value: 0,
    attributes,
    dimension_names: names,
  };
  const pending = [],
    requests = [];
  let active = 0,
    maximum = 0;
  const values = (coords) => {
    const result = new Float32Array(chunks.reduce((total, size) => total * size, 1));
    for (let flat = 0; flat < result.length; flat++) {
      let remainder = flat;
      const position = {};
      for (let dimension = names.length - 1; dimension >= 0; dimension--) {
        position[names[dimension]] =
          coords[dimension] * chunks[dimension] + (remainder % chunks[dimension]);
        remainder = Math.floor(remainder / chunks[dimension]);
      }
      result[flat] =
        (position.run ?? 0) * 10000 +
        position.time * 1000 +
        (position.z ?? position.height) * 100 +
        (position.y ?? position.lat) * 10 +
        (position.x ?? position.lon);
    }
    return result;
  };
  context.mock.method(globalThis, 'fetch', async (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/zarr.json' && version === 3) {
      return Response.json({ zarr_format: 3, node_type: 'group', attributes: {} });
    }
    if (path === '/grid/zarr.json' && version === 3) {
      return Response.json(metadata);
    }
    if (path === '/grid/.zattrs' && version === 2) {
      return Response.json(attributes);
    }
    if (path === '/grid/.zarray' && version === 2) {
      return Response.json({
        zarr_format: 2,
        shape,
        chunks,
        dtype: '<f4',
        compressor: null,
        filters: null,
        order: 'C',
        fill_value: 0,
      });
    }
    if (path === '/height/zarr.json' && geo) {
      return Response.json({
        ...metadata,
        shape: [2],
        dimension_names: ['height'],
        chunk_grid: { name: 'regular', configuration: { chunk_shape: [2] } },
        attributes: { units: 'm' },
      });
    }
    if (path === '/height/c/0' && geo) {
      return new Response(new Float32Array([5, 15]));
    }
    const match = version === 3 ? /^\/grid\/c\/(.*)$/.exec(path) : /^\/grid\/(\d.*)$/.exec(path);
    if (!match) {
      return new Response(null, { status: 404 });
    }
    const coords = match[1].split(version === 3 ? '/' : '.').map(Number);
    requests.push(coords);
    active++;
    maximum = Math.max(maximum, active);
    return new Promise((resolve) => {
      const entry = {
        done: false,
        request,
        release() {
          if (!entry.done) {
            entry.done = true;
            active--;
            resolve(new Response(values(coords)));
          }
        },
      };
      pending.push(entry);
    });
  });
  const options = geo
    ? { field: 'grid', verticalDimension: 'height', verticalCoordinates: 'height' }
    : {
        field: 'grid',
        layout: { axes: ['x', null, 'time', 'z', 'y'], origin: [0, 0, 0], spacing: [1, 1, 1] },
        selection: { 1: 1 },
      };
  return { options, pending, requests, xAxis: geo ? 3 : 0, maximum: () => maximum };
}

for (const [version, geo] of [
  [2, false],
  [3, false],
  [3, true],
]) {
  test(`${geo ? 'GeoZarr' : 'plain Zarr'} v${version} progressively reads visible chunks and reuses them across views and frames`, async (context) => {
    const store = fixture(context, version, geo);
    const reader = await openZarrVolume('https://zarr.invalid', {
      ...store.options,
      maxRequests: 2,
    });
    const signal = new AbortController().signal;
    const partials = [];
    let complete = false;
    const read = reader
      .readView(0, {
        volumeToClip: leftView,
        signal,
        onProgress: (volume) => partials.push(volume),
      })
      .then((volume) => {
        complete = true;
        return volume;
      });
    await until(() => store.pending.length === 2);
    assert.ok(
      store.requests.every((coords) => coords[store.xAxis] === 0),
      'center chunks run first',
    );
    store.pending[0].release();
    await until(() => partials.length > 0);
    assert.equal(complete, false);
    assert.ok(partials[0].values.some(Number.isFinite));
    assert.ok(partials[0].values.some(Number.isNaN));
    const first = partials[0].values.slice();
    for (let attempt = 0; attempt < 100 && !complete; attempt++) {
      for (const pending of store.pending) {
        pending.release();
      }
      await setImmediate();
    }
    const result = await read;
    assert.deepEqual(partials[0].values, first, 'published arrays are immutable snapshots');
    assert.equal(store.maximum(), 2);
    assert.equal(store.requests.length, 8);
    assert.ok(store.requests.every((coords) => coords[store.xAxis] <= 1));
    assert.ok(result.values.some(Number.isFinite));
    const frame = await reader.readView(1, { volumeToClip: leftView, signal });
    assert.equal(store.requests.length, 8, 'one decoded time chunk serves both frames');
    for (let cell = 0; cell < result.values.length; cell++) {
      if (Number.isFinite(result.values[cell])) {
        assert.ok(Math.abs(frame.values[cell] - result.values[cell] - 1000) < 0.01);
      }
    }
    complete = false;
    const pan = reader.readView(0, { volumeToClip: rightView, signal }).then(() => {
      complete = true;
    });
    for (let attempt = 0; attempt < 100 && !complete; attempt++) {
      for (const pending of store.pending) {
        pending.release();
      }
      await setImmediate();
    }
    await pan;
    assert.equal(store.requests.length, 16);
    await reader.readView(0, { volumeToClip: leftView, signal });
    assert.equal(store.requests.length, 16, 'returning to a previous view uses the decoded cache');
    const whole = await reader.readView(0, { volumeToClip: fullView, signal });
    assert.ok(whole.values.every(Number.isFinite));
    complete = false;
    const reference = reader.readFrame(0, signal).then((volume) => {
      complete = true;
      return volume;
    });
    for (let attempt = 0; attempt < 100 && !complete; attempt++) {
      for (const pending of store.pending) {
        pending.release();
      }
      await setImmediate();
    }
    assert.deepEqual(
      whole,
      await reference,
      'completed progressive data agrees with the existing whole-frame reader',
    );
    reader.dispose();
    await assert.rejects(reader.readView(0, { volumeToClip: fullView, signal }), /disposed/);
  });
}

test('frustum tests retain intersecting boxes and reject fully offscreen boxes', () => {
  assert.equal(volumeBoxVisible([0, 0, 0], [1, 1, 1], fullView), true);
  assert.equal(volumeBoxVisible([2, 0, 0], [3, 1, 1], fullView), false);
  assert.equal(volumeBoxVisible([-0.1, 0.2, 0.2], [0.1, 0.8, 0.8], fullView), true);
});

test('cancelling a view stops waiting immediately and suppresses late progress', async (context) => {
  const store = fixture(context, 3, false);
  const reader = await openZarrVolume('https://zarr.invalid', { ...store.options, maxRequests: 2 });
  const request = new AbortController();
  const snapshots = [];
  const rejected = assert.rejects(
    reader.readView(0, {
      volumeToClip: leftView,
      signal: request.signal,
      onProgress: (volume) => snapshots.push(volume),
    }),
    /superseded/,
  );
  await until(() => store.pending.length === 2);
  request.abort(new Error('superseded'));
  await rejected;
  assert.ok(store.pending.every((entry) => entry.request.signal.aborted));
  for (const pending of store.pending) {
    pending.release();
  }
  await setImmediate();
  assert.equal(snapshots.length, 0);
  const empty = await reader.readView(0, {
    volumeToClip: fullView,
    signal: new AbortController().signal,
    clipBounds: [0, 0, 0, 0, 1, 1],
  });
  assert.ok(empty.values.every(Number.isNaN));
  assert.equal(store.requests.length, 2, 'an empty clipped view does not fetch data');
  reader.dispose();
});
