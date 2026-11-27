import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import {
  createZarrStore,
  readConsolidatedCatalog,
  withStartShardIndexes,
} from '../dist/storage/zarr-store.js';

const startIndexMetadata = new TextEncoder().encode(
  JSON.stringify({
    node_type: 'array',
    codecs: [{ name: 'sharding_indexed', configuration: { index_location: 'start' } }],
  }),
);

test('start-index compatibility changes only suffix index reads for the matching array', async () => {
  const calls = [];
  const inner = {
    get: async (path) => (path === '/field/0/zarr.json' ? startIndexMetadata : undefined),
    getRange: async (path, range) => {
      calls.push([path, range]);
      return new Uint8Array();
    },
  };
  const store = withStartShardIndexes(inner);
  await store.get('/field/0/zarr.json');
  await store.getRange('/field/0/c/0/1/2', { suffixLength: 68 });
  await store.getRange('/field/0/c/0/1/2', { offset: 100, length: 60 });
  await store.getRange('/other/0/c/0', { suffixLength: 20 });
  assert.deepEqual(calls, [
    ['/field/0/c/0/1/2', { offset: 0, length: 68 }],
    ['/field/0/c/0/1/2', { offset: 100, length: 60 }],
    ['/other/0/c/0', { suffixLength: 20 }],
  ]);
});

test('shared shard-index reads follow collection lifetime while payload reads remain individually cancellable', async () => {
  const collection = new AbortController(),
    chunk = new AbortController();
  const signals = [];
  const store = withStartShardIndexes(
    {
      get: async (path) => (path === '/field/zarr.json' ? startIndexMetadata : undefined),
      getRange: async (_path, _range, options) => {
        signals.push(options.signal);
        return new Uint8Array();
      },
    },
    collection.signal,
  );
  await store.get('/field/zarr.json');
  await store.getRange('/field/c/0', { suffixLength: 20 }, { signal: chunk.signal });
  await store.getRange('/field/c/0', { offset: 20, length: 8 }, { signal: chunk.signal });
  chunk.abort();
  assert.equal(signals[0], collection.signal);
  assert.equal(signals[0].aborted, false);
  assert.equal(signals[1].aborted, true);
  collection.abort();
  assert.equal(signals[0].aborted, true);
});

test('HTTP retry errors keep the response status without including the source URL', async () => {
  let attempts = 0;
  await assert.rejects(
    createZarrStore('https://fixture.test/private-data/', {
      retry: true,
      fetch: async () => {
        attempts++;
        return new Response(null, { status: 503 });
      },
    }).get('/zarr.json'),
    (error) => {
      assert.equal(error.message, 'Zarr request failed after three attempts.');
      assert.equal(error.cause.message, 'HTTP 503');
      assert.doesNotMatch(inspect(error), /fixture\.test|private-data/);
      return true;
    },
  );
  assert.equal(attempts, 3);
});

test('plain opened stores keep optional range support and caller ownership', async () => {
  const source = new Map([['/value', new Uint8Array([7])]]);
  source.dispose = () => {
    throw new Error('Caller-owned store disposed');
  };
  const store = createZarrStore(source);
  assert.equal(store.getRange, undefined);
  assert.deepEqual(await store.get('/value'), new Uint8Array([7]));
  const controller = new AbortController();
  controller.abort(new Error('Read cancelled'));
  await assert.rejects(store.get('/value', { signal: controller.signal }), /Read cancelled/);
  assert.throws(
    () => createZarrStore(source, { fetch: globalThis.fetch }),
    /Configure fetch on the opened store/,
  );
});

test('missing catalogs are optional while malformed metadata and transport failures reject', async () => {
  const signal = new AbortController().signal;
  assert.equal(
    (await readConsolidatedCatalog(createZarrStore(new Map()), signal)).nodes,
    undefined,
  );
  const malformed = new Map([['/zarr.json', new TextEncoder().encode('{invalid')]]);
  await assert.rejects(readConsolidatedCatalog(createZarrStore(malformed), signal), SyntaxError);
  const broken = {
    get: async () => {
      throw new Error('Storage unavailable');
    },
  };
  await assert.rejects(
    readConsolidatedCatalog(createZarrStore(broken), signal),
    /Storage unavailable/,
  );
});

test('default URL transport does not add collection retries', async () => {
  let attempts = 0;
  const store = createZarrStore('https://fixture.test/', {
    fetch: async () => {
      attempts++;
      return new Response(null, { status: 503 });
    },
  });
  await assert.rejects(store.get('/value'), /503/);
  assert.equal(attempts, 1);
});

test('opened-store reads keep their starting batch signal across pause and resume', async () => {
  let batch = new AbortController();
  const pending = [];
  const source = {
    get: (_path, options) =>
      new Promise((resolve, reject) => {
        pending.push({ signal: options.signal, resolve });
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true,
        });
      }),
  };
  const store = createZarrStore(source, { readSignal: () => batch.signal });
  const first = store.get('/value');
  batch.abort(new Error('Batch paused'));
  batch = new AbortController();
  await assert.rejects(first, /Batch paused/);
  const next = store.get('/value');
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(pending[1].signal.aborted, false);
  pending[1].resolve(new Uint8Array([8]));
  assert.deepEqual(await next, new Uint8Array([8]));
});
