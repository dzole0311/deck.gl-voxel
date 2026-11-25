import {
  type AbsolutePath,
  type AsyncReadable,
  FetchStore,
  type GetOptions,
  type RangeQuery,
  withConsolidatedMetadata,
} from 'zarrita';

/** Narrows external JSON objects without trusting metadata or context responses. */
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Adapts Zarrita 0.7.5's suffix-only shard-index getter to index_location=start.
 * Only index reads change; Zarrita owns index decoding, offsets, codecs and missing shards.
 */
export function withStartShardIndexes(
  inner: AsyncReadable,
  starts: ReadonlySet<string>,
  lifetime?: AbortSignal,
): AsyncReadable {
  return {
    get: (path, options) => inner.get(path, options),
    async getRange(path: AbsolutePath, range: RangeQuery, options?: GetOptions) {
      const startIndex = Array.from(starts).some((array) => path.startsWith(`${array}/`));
      const adapted =
        'suffixLength' in range && startIndex ? { offset: 0, length: range.suffixLength } : range;
      if (!inner.getRange) {
        throw new Error('Sharded arrays require byte-range reads.');
      }
      // Zarrita shares one index promise across inner chunks. An obsolete chunk must not cancel another chunk's index.
      return inner.getRange(
        path,
        adapted,
        'suffixLength' in range && lifetime ? { signal: lifetime } : options,
      );
    },
  };
}

/** Opens a consolidated v3 HTTP store with bounded retries and correct start-index reads. */
export async function openCellStore(
  url: string,
  signal: AbortSignal,
  fetcher: typeof fetch = globalThis.fetch,
) {
  const starts = new Set<string>();
  const raw = new FetchStore(url, {
    useSuffixRequest: true,
    async fetch(request) {
      let last: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        request.signal.throwIfAborted();
        try {
          const response = await fetcher(
            new Request(request, {
              signal: AbortSignal.any([signal, request.signal, AbortSignal.timeout(30_000)]),
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
          last = new Error(`HTTP ${response.status}: ${request.url}`);
        } catch (error) {
          request.signal.throwIfAborted();
          signal.throwIfAborted();
          last = error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
      }
      throw new Error('GeoZarr request failed after three attempts.', { cause: last });
    },
  });
  const bytes = await raw.get('/zarr.json', { signal });
  if (!bytes) {
    throw new Error('GeoZarr root metadata is missing.');
  }
  const metadata: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (
    !record(metadata) ||
    !record(metadata.consolidated_metadata) ||
    !record(metadata.consolidated_metadata.metadata)
  ) {
    throw new Error('Cell collections require consolidated Zarr v3 metadata.');
  }
  const nodes = metadata.consolidated_metadata.metadata;
  for (const [path, node] of Object.entries(nodes)) {
    if (!record(node) || !Array.isArray(node.codecs)) {
      continue;
    }
    if (
      node.codecs.some(
        (codec: unknown) =>
          record(codec) &&
          codec.name === 'sharding_indexed' &&
          record(codec.configuration) &&
          codec.configuration.index_location === 'start',
      )
    ) {
      starts.add(`/${path}`);
    }
  }
  const adapted = withStartShardIndexes(raw, starts, signal);
  const store = await withConsolidatedMetadata(
    {
      ...adapted,
      get: (path: AbsolutePath, options?: GetOptions) =>
        path === '/zarr.json' ? Promise.resolve(bytes) : adapted.get(path, options),
    },
    { format: 'v3' },
  );
  return { store, nodes };
}
