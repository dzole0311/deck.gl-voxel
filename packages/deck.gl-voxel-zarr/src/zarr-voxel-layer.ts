import {
  CompositeLayer,
  type DefaultProps,
  type Layer,
  type UpdateParameters,
} from '@deck.gl/core';
import { type VoxelData, VoxelLayer, type VoxelLayerProps } from 'deck.gl-voxel';
import { FrameCache } from './frame-cache.js';
import { openZarrVolume, type ZarrVolume, type ZarrVolumeOptions } from './zarr-volume.js';

/** Options for {@link openZarrVolume}; the layer owns cancellation of metadata and frame reads. */
export type ZarrLayerSourceOptions = Omit<ZarrVolumeOptions, 'signal' | 'fetch'>;

/** Request settings for URL sources; Zarrita owns decoding and the layer owns cancellation. */
export interface ZarrLoadOptions {
  /** Native fetch settings, including headers and credentials, applied to every store request. */
  core?: { fetch?: Omit<RequestInit, 'signal'> };
  /** Legacy alias for core.fetch; core settings take precedence when both are supplied. */
  fetch?: Omit<RequestInit, 'signal'>;
}

/** deck.gl fetch context extended with the raw Zarr request, including Range headers. */
export interface ZarrFetchContext {
  propName: string;
  layer: Layer;
  loadOptions: ZarrLoadOptions;
  signal: AbortSignal;
  /** Use new Request(signedUrl, request) when rewriting URLs to preserve request settings. */
  request: Request;
}

/** Returns a raw response; Zarrita, rather than loaders.gl, decodes the bytes. */
export type ZarrFetch = (url: string, context: ZarrFetchContext) => Response | Promise<Response>;

/** Render settings for a URL-backed volume. Equivalent sourceOptions preserve the opened reader. */
export type ZarrVoxelLayerProps = Omit<VoxelLayerProps, 'volume' | 'fetch' | 'loadOptions'> & {
  /** HTTP(S) store root, or an opener for derived/virtual Zarr fields. The layer supplies cancellation. */
  source: string | ((signal: AbortSignal) => Promise<ZarrVolume>);
  /** URL-source selection passed to {@link openZarrVolume}; defaults to the root field. Ignored for openers. */
  sourceOptions?: ZarrLayerSourceOptions;
  /** URL-source request hook. Return a raw Response and preserve context.request when rewriting URLs. Custom source openers own their transport. */
  fetch?: ZarrFetch;
  /** URL-source HTTP settings; supports core.fetch and the legacy fetch alias. Supply a new object when settings change. */
  loadOptions?: ZarrLoadOptions;
  /**
   * Zero-based time index. Use zero for a field with no time axis.
   * @default 0
   */
  frameIndex?: number;
  /**
   * Buffer two following frames before playback, then warm the remaining timeline sequentially.
   * Reads share the frame cache; disabling preload cancels background work.
   * @default false
   */
  preload?: boolean;
  /**
   * Cached scalar-array byte limit, excluding the displayed volume, in-flight reads and GPU resources.
   * Least recently used frames are evicted; oversized frames are displayed without caching.
   * @default 67108864
   */
  maxCacheBytes?: number;
  /**
   * Timeout in milliseconds for opening or reading a frame; zero disables the timeout.
   * @default 0
   */
  requestTimeout?: number;
  /** Reports metadata readiness; the layer retains ownership of pending reads. */
  onSourceLoad?: (reader: ZarrVolume) => void;
  /** Observes the complete frame after it becomes drawable. Treat its values as immutable. */
  onVolumeLoad?: (volume: VoxelData) => void;
  /** Reports current-frame loading and initial playback buffering, including failures returning to idle. */
  onLoadStateChange?: (loading: boolean) => void;
};

const DEFAULT_MAX_CACHE_BYTES = 64 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT = 0;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Compare the same option values in deck.gl's prop diff and in our reopen decision.
// Non-plain objects (such as Headers) retain identity comparison.
function equalOptions(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => equalOptions(value, right[index]))
    );
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) {
    return false;
  }
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && equalOptions(left[key], right[key]))
  );
}

const fetchZarrRequest: ZarrFetch = (url, { request }) =>
  globalThis.fetch(new Request(url, request));

/**
 * Loads whole frames from a Zarr URL or derived-field opener and renders them with {@link VoxelLayer}.
 * Stable layer IDs preserve the opened reader across style and frame updates. Replacing
 * source or changing sourceOptions values cancels old work. Previous data stays visible until a complete
 * replacement arrives; superseded reads cannot publish. Finalization cancels all reads.
 * The child VoxelLayer owns its GPU resources and releases them when deck.gl replaces
 * its volume or finalizes the child. Reader format and frame-size limits apply.
 */
export class ZarrVoxelLayer extends CompositeLayer<ZarrVoxelLayerProps> {
  static override layerName = 'ZarrVoxelLayer';
  static override defaultProps: DefaultProps<ZarrVoxelLayerProps> = {
    ...VoxelLayer.defaultProps,
    source: '',
    sourceOptions: { type: 'object', value: { field: '.' }, equal: equalOptions },
    fetch: { type: 'function', value: fetchZarrRequest, compare: true },
    loadOptions: { type: 'object', value: {}, equal: equalOptions },
    frameIndex: 0,
    preload: false,
    maxCacheBytes: DEFAULT_MAX_CACHE_BYTES,
    requestTimeout: DEFAULT_REQUEST_TIMEOUT,
  };

  declare state: {
    volume: VoxelData | undefined;
    loading: boolean;
    buffering: boolean;
    lifecycle: {
      reader: Promise<FrameCache> | undefined;
      cache: FrameCache | undefined;
      opening: AbortController | undefined;
      reading: AbortController | undefined;
      preloading: AbortController | undefined;
    };
  };

  private get current(): ZarrVoxelLayer {
    const layer = this.getCurrentLayer();
    return layer instanceof ZarrVoxelLayer ? layer : this;
  }

  override initializeState(): void {
    this.setState({
      volume: undefined,
      loading: false,
      buffering: false,
      lifecycle: {
        reader: undefined,
        cache: undefined,
        opening: undefined,
        reading: undefined,
        preloading: undefined,
      },
    });
  }

  /** Whether the current frame, its sublayer and the initial playback buffer are ready. */
  override get isLoaded(): boolean {
    return (
      super.isLoaded &&
      Boolean(this.state?.volume) &&
      !this.state?.loading &&
      !this.state?.buffering
    );
  }

  override updateState({ props, oldProps }: UpdateParameters<this>): void {
    const lifecycle = this.state.lifecycle;
    const sourceChanged =
      !lifecycle.reader ||
      props.source !== oldProps.source ||
      !equalOptions(props.sourceOptions, oldProps.sourceOptions) ||
      props.fetch !== oldProps.fetch ||
      !equalOptions(props.loadOptions, oldProps.loadOptions) ||
      props.maxCacheBytes !== oldProps.maxCacheBytes ||
      props.requestTimeout !== oldProps.requestTimeout;

    if (sourceChanged) {
      lifecycle.opening?.abort();
      lifecycle.reading?.abort();
      this.cancelPreload();
      lifecycle.cache = undefined;
      const request = new AbortController();
      lifecycle.opening = request;
      // Defer opening so synchronous validation errors follow the same error path as I/O.
      lifecycle.reader = Promise.resolve()
        .then(async () => {
          request.signal.throwIfAborted();
          const maxBytes = props.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
          const timeout = props.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
          if (
            !Number.isSafeInteger(maxBytes) ||
            maxBytes < 0 ||
            !Number.isSafeInteger(timeout) ||
            timeout < 0
          ) {
            throw new Error('maxCacheBytes and requestTimeout must be nonnegative safe integers.');
          }
          const signal = this.requestSignal(request);
          const reader = await (typeof props.source === 'function'
            ? props.source(signal)
            : openZarrVolume(props.source, {
                field: '.',
                ...props.sourceOptions,
                signal,
                fetch: this.createTransport(),
              }));
          signal.throwIfAborted();
          return reader;
        })
        .then((reader) => {
          request.signal.throwIfAborted();
          this.current.props.onSourceLoad?.(reader);
          const cache = new FrameCache(reader, props.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES);
          lifecycle.cache = cache;
          return cache;
        });
    }

    if (sourceChanged || props.frameIndex !== oldProps.frameIndex) {
      void this.readFrame();
    } else if (props.preload !== oldProps.preload) {
      if (props.preload) {
        if (lifecycle.cache) {
          this.startPreload(lifecycle.cache);
        }
      } else {
        this.cancelPreload();
      }
    }
  }

  /** HTTP settings for URL-source requests; custom openers configure their own transport. */
  override getLoadOptions(): ZarrLoadOptions {
    return this.props.loadOptions ?? {};
  }

  private createTransport(): (request: Request) => Promise<Response> {
    const loadOptions = this.getLoadOptions();
    const fetch = this.props.fetch ?? fetchZarrRequest;
    return async (request) => {
      const legacy = loadOptions.fetch;
      const core = loadOptions.core?.fetch;
      const headers = new Headers(legacy?.headers);
      new Headers(core?.headers).forEach((value, key) => {
        headers.set(key, value);
      });
      // Zarrita's Range and cancellation must survive authentication defaults.
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
        layer: this.current,
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

  private requestSignal(request: AbortController): AbortSignal {
    const timeout = this.props.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
    return timeout > 0
      ? AbortSignal.any([request.signal, AbortSignal.timeout(timeout)])
      : request.signal;
  }

  private setActivity(kind: 'loading' | 'buffering', value: boolean): void {
    const current = this.current;
    const wasBusy = current.state.loading || current.state.buffering;
    current.setState({ [kind]: value });
    const busy = current.state.loading || current.state.buffering;
    if (busy !== wasBusy) {
      current.props.onLoadStateChange?.(busy);
    }
  }

  private cancelPreload(): void {
    this.state.lifecycle.preloading?.abort();
    this.state.lifecycle.preloading = undefined;
    this.setActivity('buffering', false);
  }

  private startPreload(cache: FrameCache): void {
    const lifecycle = this.state.lifecycle;
    if (!this.props.preload || lifecycle.preloading || cache.isComplete || cache.frameCount < 2) {
      return;
    }
    const request = new AbortController();
    lifecycle.preloading = request;
    const start = this.props.frameIndex ?? 0;
    const count = Math.min(2, cache.frameCount - 1);
    this.setActivity(
      'buffering',
      Array.from({ length: count }, (_, offset) =>
        cache.has((start + offset + 1) % cache.frameCount),
      ).includes(false),
    );
    void (async () => {
      try {
        for (let offset = 1; offset <= cache.frameCount; offset++) {
          const signal = this.requestSignal(request);
          await cache.read((start + offset) % cache.frameCount, signal);
          signal.throwIfAborted();
          if (offset === count) {
            this.setActivity('buffering', false);
          }
        }
      } catch (error: unknown) {
        if (!request.signal.aborted && this.current.state.buffering) {
          this.current.raiseError(
            error instanceof Error ? error : new Error(String(error)),
            'buffering Zarr volume',
          );
        }
      } finally {
        if (lifecycle.preloading === request) {
          lifecycle.preloading = undefined;
          this.setActivity('buffering', false);
        }
      }
    })();
  }

  private async readFrame(): Promise<void> {
    const lifecycle = this.state.lifecycle;
    lifecycle.reading?.abort();
    const request = new AbortController();
    lifecycle.reading = request;
    const index = this.props.frameIndex ?? 0;
    this.setActivity('loading', true);

    try {
      const cache = await lifecycle.reader;
      request.signal.throwIfAborted();
      if (!cache) {
        return;
      }
      const signal = this.requestSignal(request);
      const volume = await cache.read(index, signal);
      signal.throwIfAborted();
      request.signal.throwIfAborted();
      const current = this.current;
      current.setState({ volume });
      current.props.onVolumeLoad?.(volume);
      current.startPreload(cache);
    } catch (error: unknown) {
      if (!request.signal.aborted) {
        this.current.raiseError(
          error instanceof Error ? error : new Error(String(error)),
          'loading Zarr volume',
        );
      }
    } finally {
      if (lifecycle.reading === request) {
        lifecycle.reading = undefined;
        this.setActivity('loading', false);
      }
    }
  }

  override renderLayers(): VoxelLayer | null {
    const { volume } = this.state;
    if (!volume) {
      return null;
    }
    const {
      source: _source,
      sourceOptions: _sourceOptions,
      frameIndex: _frameIndex,
      preload: _preload,
      maxCacheBytes: _maxCacheBytes,
      requestTimeout: _requestTimeout,
      onSourceLoad: _onSourceLoad,
      onVolumeLoad: _onVolumeLoad,
      onLoadStateChange: _onLoadStateChange,
      ...style
    } = this.props;
    return new VoxelLayer(style, this.getSubLayerProps({ id: 'volume' }), { volume });
  }

  override finalizeState(): void {
    this.state.lifecycle.opening?.abort();
    this.state.lifecycle.preloading?.abort();
    this.state.lifecycle.preloading = undefined;
    this.state.lifecycle.reading?.abort();
    this.state.lifecycle.reading = undefined;
    this.state.lifecycle.cache = undefined;
    this.state.lifecycle.reader = undefined;
  }
}
