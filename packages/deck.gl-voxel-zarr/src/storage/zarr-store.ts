import {
  type AbsolutePath,
  type AsyncReadable,
  FetchStore,
  type GetOptions,
  type RangeQuery,
  type Readable,
  withConsolidatedMetadata,
} from 'zarrita';

/** A URL-backed Zarr root or an opened store whose transport stays owned by the caller. */
export type ZarrStoreInput = string | Readable;

interface StoreOptions {
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly signal?: AbortSignal;
  readonly readSignal?: () => AbortSignal;
  readonly retry?: boolean;
}

/** Checks whether external JSON contains an object rather than an array or null. */
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Preserves the collection's bounded HTTP retry policy without changing other readers' defaults. */
async function fetchWithRetries(
  request: Request,
  fetcher: (request: Request) => Promise<Response>,
): Promise<Response> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    request.signal.throwIfAborted();
    try {
      const response = await fetcher(
        new Request(request, {
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
        }),
      );
      if (
        response.ok ||
        response.status === 404 ||
        (response.status < 500 && response.status !== 429)
      ) {
        return response;
      }
      await response.body?.cancel();
      last = new Error(`HTTP ${response.status}`);
    } catch (error) {
      request.signal.throwIfAborted();
      last = error;
    }
    if (attempt < 2) {
      await new Promise<void>((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
    }
  }
  throw new Error('Zarr request failed after three attempts.', { cause: last });
}

/**
 * Normalizes URL and readable inputs without owning or disposing the supplied store.
 * Fetch settings apply only to URLs. Collection readers opt into retries and batch cancellation;
 * other readers keep their existing request policy. Each read keeps its starting batch signal.
 */
export function createZarrStore(input: ZarrStoreInput, options: StoreOptions = {}): AsyncReadable {
  if (typeof input !== 'string' && options.fetch) {
    throw new Error(
      'Configure fetch on the opened store, rather than supplying URL fetch settings.',
    );
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  const inner =
    typeof input === 'string'
      ? new FetchStore(input, {
          useSuffixRequest: true,
          fetch: options.retry ? (request) => fetchWithRetries(request, fetcher) : fetcher,
        })
      : input;
  const readOptions = (request?: GetOptions): GetOptions => {
    const signals = [options.signal, request?.signal, options.readSignal?.()].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const first = signals[0];
    return first ? { signal: signals.length === 1 ? first : AbortSignal.any(signals) } : {};
  };
  const getRange = inner.getRange?.bind(inner);
  const store: AsyncReadable = {
    async get(path, request) {
      const settings = readOptions(request);
      settings.signal?.throwIfAborted();
      const bytes = await inner.get(path, settings);
      settings.signal?.throwIfAborted();
      return bytes;
    },
    ...(getRange
      ? {
          async getRange(path: AbsolutePath, range: RangeQuery, request?: GetOptions) {
            const settings = readOptions(request);
            settings.signal?.throwIfAborted();
            const bytes = await getRange(path, range, settings);
            settings.signal?.throwIfAborted();
            return bytes;
          },
        }
      : {}),
  };
  return withStartShardIndexes(store, options.signal);
}

/**
 * Adapts Zarrita's suffix-only shard-index reads using each array's Zarr metadata.
 * Shared index reads use the collection signal when supplied; payloads keep their own cancellation.
 * This works with HTTP, memory and opened stores, including metadata served from a consolidated catalog.
 */
export function withStartShardIndexes(inner: AsyncReadable, lifetime?: AbortSignal): AsyncReadable {
  const startArrays = new Set<string>();
  const getRange = inner.getRange?.bind(inner);
  return {
    async get(path, options) {
      const bytes = await inner.get(path, options);
      if (bytes && path.endsWith('/zarr.json')) {
        const metadata: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (record(metadata) && metadata.node_type === 'array' && Array.isArray(metadata.codecs)) {
          const array = path.slice(0, -'/zarr.json'.length);
          const atStart = metadata.codecs.some(
            (codec: unknown) =>
              record(codec) &&
              codec.name === 'sharding_indexed' &&
              record(codec.configuration) &&
              codec.configuration.index_location === 'start',
          );
          if (atStart) {
            startArrays.add(array);
          } else {
            startArrays.delete(array);
          }
        }
      }
      return bytes;
    },
    ...(getRange
      ? {
          getRange(path: AbsolutePath, range: RangeQuery, options?: GetOptions) {
            const indexRead = 'suffixLength' in range;
            let startIndex = false;
            if (indexRead) {
              for (const array of startArrays) {
                if (path.startsWith(`${array}/`)) {
                  startIndex = true;
                  break;
                }
              }
            }
            const adapted =
              indexRead && startIndex ? { offset: 0, length: range.suffixLength } : range;
            return getRange(path, adapted, indexRead && lifetime ? { signal: lifetime } : options);
          },
        }
      : {}),
  };
}

/**
 * Uses inline v3 metadata when available and otherwise leaves explicit field opening available.
 * A missing catalog is allowed. HTTP failures and malformed JSON still reject.
 */
export async function readConsolidatedCatalog(
  input: AsyncReadable,
  signal: AbortSignal,
): Promise<{ store: AsyncReadable; nodes: Record<string, unknown> | undefined }> {
  const bytes = await input.get('/zarr.json', { signal });
  const metadata: unknown = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : undefined;
  let nodes: Record<string, unknown> | undefined;
  if (record(metadata) && metadata.consolidated_metadata !== undefined) {
    const catalog = metadata.consolidated_metadata;
    if (!record(catalog) || !record(catalog.metadata)) {
      throw new Error('Invalid consolidated Zarr v3 metadata.');
    }
    nodes = catalog.metadata;
  }
  const cached: AsyncReadable = {
    get: (path, options) =>
      path === '/zarr.json' ? Promise.resolve(bytes) : input.get(path, options),
    ...(input.getRange ? { getRange: input.getRange.bind(input) } : {}),
  };
  const store = nodes ? await withConsolidatedMetadata(cached, { format: 'v3' }) : cached;
  signal.throwIfAborted();
  return { store: withStartShardIndexes(store, signal), nodes };
}
