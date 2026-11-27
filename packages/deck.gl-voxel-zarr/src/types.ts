import type { Layer } from '@deck.gl/core';

/** HTTP settings used by URL sources; opened stores configure their own transport. */
export interface ZarrLoadOptions {
  core?: { fetch?: Omit<RequestInit, 'signal'> };
  /** Older spelling of core.fetch; core settings take precedence. */
  fetch?: Omit<RequestInit, 'signal'>;
}

/** The original byte-range request and the current layer, passed to a URL request hook. */
export interface ZarrFetchContext {
  propName: string;
  layer: Layer;
  loadOptions: ZarrLoadOptions;
  signal: AbortSignal;
  /** Preserve this request when rewriting a URL so Range headers and cancellation survive. */
  request: Request;
}

/** Returns raw bytes in a Response; Zarrita handles decoding. */
export type ZarrFetch = (url: string, context: ZarrFetchContext) => Response | Promise<Response>;

/** Limits for custom frame readers; combined decoded caches must fit maxCacheBytes. */
export interface ZarrSourceContext {
  readonly maxCells: number;
  readonly maxCacheBytes: number;
  readonly maxRequests: number;
}
