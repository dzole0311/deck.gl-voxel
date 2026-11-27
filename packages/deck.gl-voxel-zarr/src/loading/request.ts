import type { Layer } from '@deck.gl/core';
import type { ZarrFetch, ZarrLoadOptions } from '../types.js';

export const fetchZarrRequest: ZarrFetch = (url, { request }) =>
  globalThis.fetch(new Request(url, request));

/** Applies URL request hooks without replacing Zarrita's Range headers or cancellation signal. */
export function createZarrTransport(
  layer: Layer,
  fetch: ZarrFetch = fetchZarrRequest,
  options: ZarrLoadOptions | null | undefined = {},
): (request: Request) => Promise<Response> {
  const loadOptions = options ?? {};
  return async (request) => {
    const legacy = loadOptions.fetch;
    const core = loadOptions.core?.fetch;
    const headers = new Headers(legacy?.headers);
    new Headers(core?.headers).forEach((value, key) => {
      headers.set(key, value);
    });
    request.headers.forEach((value, key) => {
      headers.set(key, value);
    });
    const prepared = new Request(request, {
      ...legacy,
      ...core,
      headers,
      signal: request.signal,
    });
    const response: unknown = await fetch(prepared.url, {
      propName: 'source',
      layer: layer.getCurrentLayer() ?? layer,
      loadOptions,
      signal: prepared.signal,
      request: prepared,
    });
    if (!(response instanceof Response)) {
      throw new Error(
        'ZarrVoxelLayer fetch must return a raw Response; Zarrita decodes the response bytes.',
      );
    }
    return response;
  };
}
