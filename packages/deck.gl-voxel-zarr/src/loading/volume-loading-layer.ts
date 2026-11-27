import { CompositeLayer, type DefaultProps, type UpdateParameters } from '@deck.gl/core';
import { Matrix4 } from '@math.gl/core';
import {
  getVoxelVolumeToCommon,
  type RaymarchVoxelLayerProps,
  type VoxelData,
  VoxelLayer,
} from 'deck.gl-voxel';
import { FrameCache } from '../cache/frame-cache.js';
import { BACKGROUND_PRIORITY } from '../cache/request-priority.js';
import { DEFAULT_MAX_CELLS } from '../readers/volume-limits.js';
import type { ZarrViewOptions } from '../readers/volume-view-reader.js';
import { openZarrVolume, type ZarrVolume, type ZarrVolumeOptions } from '../readers/zarr-volume.js';
import type { ZarrStoreInput } from '../storage/zarr-store.js';
import type { ZarrFetch, ZarrLoadOptions, ZarrSourceContext } from '../types.js';
import { equalOptions } from './prop-comparison.js';
import { createZarrTransport, fetchZarrRequest } from './request.js';

/** Options for {@link openZarrVolume}; the layer owns cancellation of metadata and frame reads. */
export type ZarrVolumeSourceOptions = Omit<
  ZarrVolumeOptions,
  'signal' | 'fetch' | 'maxCacheBytes' | 'maxRequests'
>;

/** Render settings for a URL-backed volume. Equivalent sourceOptions preserve the opened reader. */
export type VolumeLoadingLayerProps = Omit<
  RaymarchVoxelLayerProps,
  'volume' | 'fetch' | 'loadOptions'
> & {
  /**
   * HTTP(S) store root or a function that opens a custom field
   * The layer supplies a cancellation signal and cache limits
   */
  source:
    | ZarrStoreInput
    | ((signal: AbortSignal, context: ZarrSourceContext) => Promise<ZarrStoreInput | ZarrVolume>);
  /**
   * URL-source selection passed to {@link openZarrVolume}, defaulting to the root field
   * Custom openers receive only its maxCells fallback through their context
   */
  sourceOptions?: ZarrVolumeSourceOptions;
  /**
   * Maximum cells per grid, also passed to custom openers
   * Takes precedence over sourceOptions.maxCells when supplied
   * Grid copies, readiness flags and cached chunks use additional memory
   * @default sourceOptions.maxCells or DEFAULT_MAX_CELLS
   */
  maxCells?: number;
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
   * Preload the next two frames for the current view
   * Without camera reads, also preload the remaining frames
   * Reads share the cache and turning this off cancels background work
   * @default false
   */
  preload?: boolean;
  /**
   * Byte limit for cached decoded data
   * Displayed grids, pending reads and GPU resources are outside this limit
   * Removes the least recently used chunks, or whole frames when camera reads are unavailable
   * @default 67108864
   */
  maxCacheBytes?: number;
  /**
   * Timeout in milliseconds for opening or reading a frame; zero disables the timeout.
   * @default 0
   */
  requestTimeout?: number;
  /**
   * Maximum number of chunk or whole-frame reads running at once
   * Custom openers receive this limit in their context
   * @default 6
   */
  maxRequests?: number;
  /**
   * Wait this many milliseconds after camera movement before starting a read
   * Frame changes load immediately
   * @default 80
   */
  debounceTime?: number;
  /**
   * Receives partial grids while loading is true
   * Unloaded cells are NaN
   * The reader may cache this grid, so treat its values as read-only
   */
  onVolumeProgress?: (volume: VoxelData) => void;
  /** Reports metadata readiness; the layer retains ownership of pending reads. */
  onSourceLoad?: (reader: ZarrVolume) => void;
  /**
   * Receives a completed view or frame
   * Camera changes can call this again for the same frame
   * The reader may cache this grid, so treat its values as read-only
   */
  onVolumeLoad?: (volume: VoxelData) => void;
  /** Reports current-frame loading and initial playback buffering, including failures returning to idle. */
  onLoadStateChange?: (loading: boolean) => void;
};

const DEFAULT_MAX_CACHE_BYTES = 64 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT = 0;

/**
 * Loads visible Zarr chunks and draws them as they arrive with {@link VoxelLayer}
 * Readers without camera support load whole frames
 * Keep the same layer ID to reuse the reader across frame and style changes
 * Source changes cancel old reads and cancelled reads cannot publish results
 * Previous data stays visible until replacement data arrives
 * A failed read restores the last complete volume or clears the layer if none exists
 * Removing the layer cancels reads and disposes the reader
 * The child VoxelLayer releases GPU resources when its volume changes or the child is removed
 */
export class VolumeLoadingLayer extends CompositeLayer<VolumeLoadingLayerProps> {
  static override layerName = 'ZarrVolumeLayer';
  static override defaultProps: DefaultProps<VolumeLoadingLayerProps> = {
    coordinateSystem: 'cartesian',
    renderMode: 'volume',
    source: '',
    sourceOptions: { type: 'object', value: { field: '.' }, equal: equalOptions },
    fetch: { type: 'function', value: fetchZarrRequest, compare: true },
    loadOptions: { type: 'object', value: {}, equal: equalOptions },
    frameIndex: 0,
    preload: false,
    maxRequests: 6,
    debounceTime: 80,
    maxCacheBytes: DEFAULT_MAX_CACHE_BYTES,
    requestTimeout: DEFAULT_REQUEST_TIMEOUT,
  };

  declare state: {
    volume: VoxelData | undefined;
    completeVolume: VoxelData | undefined;
    loading: boolean;
    buffering: boolean;
    lifecycle: {
      reader: Promise<FrameCache> | undefined;
      volumeReader: ZarrVolume | undefined;
      timer: ReturnType<typeof setTimeout> | undefined;
      cache: FrameCache | undefined;
      opening: AbortController | undefined;
      reading: AbortController | undefined;
      preloading: AbortController | undefined;
    };
  };

  private get current(): VolumeLoadingLayer {
    const layer = this.getCurrentLayer();
    return layer instanceof VolumeLoadingLayer ? layer : this;
  }

  override initializeState(): void {
    this.setState({
      volume: undefined,
      completeVolume: undefined,
      loading: false,
      buffering: false,
      lifecycle: {
        reader: undefined,
        volumeReader: undefined,
        timer: undefined,
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

  override shouldUpdateState(params: UpdateParameters<this>): boolean {
    return super.shouldUpdateState(params) || Boolean(params.changeFlags.viewportChanged);
  }

  /** Starts opening in a promise so validation and I/O failures share the same error path. */
  override updateState({ props, oldProps, changeFlags }: UpdateParameters<this>): void {
    const lifecycle = this.state.lifecycle;
    const sourceChanged =
      !lifecycle.reader ||
      props.source !== oldProps.source ||
      !equalOptions(props.sourceOptions, oldProps.sourceOptions) ||
      props.fetch !== oldProps.fetch ||
      !equalOptions(props.loadOptions, oldProps.loadOptions) ||
      props.maxCells !== oldProps.maxCells ||
      props.maxCacheBytes !== oldProps.maxCacheBytes ||
      props.maxRequests !== oldProps.maxRequests ||
      props.requestTimeout !== oldProps.requestTimeout;

    if (sourceChanged) {
      clearTimeout(lifecycle.timer);
      lifecycle.timer = undefined;
      lifecycle.volumeReader?.dispose?.();
      lifecycle.volumeReader = undefined;
      lifecycle.opening?.abort();
      lifecycle.reading?.abort();
      this.cancelPreload();
      lifecycle.cache = undefined;
      const request = new AbortController();
      lifecycle.opening = request;
      lifecycle.reader = Promise.resolve()
        .then(async () => {
          request.signal.throwIfAborted();
          const maxCells = props.maxCells ?? props.sourceOptions?.maxCells ?? DEFAULT_MAX_CELLS;
          const maxBytes = props.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
          const timeout = props.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
          const maxRequests = props.maxRequests ?? 6;
          if (
            !Number.isSafeInteger(maxBytes) ||
            maxBytes < 0 ||
            !Number.isSafeInteger(timeout) ||
            timeout < 0
          ) {
            throw new Error('maxCacheBytes and requestTimeout must be nonnegative safe integers.');
          }
          if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) {
            throw new Error('maxRequests must be a positive safe integer.');
          }
          if (!Number.isSafeInteger(maxCells) || maxCells < 1) {
            throw new Error('maxCells must be a positive safe integer.');
          }
          const signal = this.requestSignal(request);
          const input =
            typeof props.source === 'function'
              ? await props.source(signal, { maxCells, maxCacheBytes: maxBytes, maxRequests })
              : props.source;
          if (signal.aborted) {
            if (isVolumeReader(input)) {
              input.dispose?.();
            }
            signal.throwIfAborted();
          }
          const reader = isVolumeReader(input)
            ? input
            : await openZarrVolume(input, {
                field: '.',
                ...props.sourceOptions,
                signal,
                ...(typeof input === 'string'
                  ? {
                      fetch: createZarrTransport(
                        this.parent ?? this,
                        props.fetch,
                        this.getLoadOptions(),
                      ),
                    }
                  : {}),
                maxCells,
                maxCacheBytes: maxBytes,
                maxRequests,
              });
          if (signal.aborted) {
            reader.dispose?.();
            signal.throwIfAborted();
          }
          return reader;
        })
        .then((reader) => {
          if (request.signal.aborted) {
            reader.dispose?.();
          }
          request.signal.throwIfAborted();
          lifecycle.volumeReader = reader;
          this.current.props.onSourceLoad?.(reader);
          const cache = new FrameCache(
            reader,
            props.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES,
            props.maxRequests ?? 6,
          );
          lifecycle.cache = cache;
          return cache;
        });
    }

    if (sourceChanged || props.frameIndex !== oldProps.frameIndex) {
      clearTimeout(lifecycle.timer);
      lifecycle.timer = undefined;
      void this.readFrame();
    } else if (
      lifecycle.volumeReader?.readView &&
      lifecycle.volumeReader.geometry &&
      (changeFlags?.viewportChanged ||
        props.modelMatrix !== oldProps.modelMatrix ||
        props.coordinateSystem !== oldProps.coordinateSystem ||
        !equalOptions(props.coordinateOrigin, oldProps.coordinateOrigin) ||
        !equalOptions(props.clipBounds, oldProps.clipBounds))
    ) {
      this.cancelPreload();
      clearTimeout(lifecycle.timer);
      this.setActivity('loading', true);
      lifecycle.timer = setTimeout(() => {
        lifecycle.timer = undefined;
        void this.current.readFrame();
      }, props.debounceTime ?? 80);
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

  private viewOptions(signal: AbortSignal): ZarrViewOptions | undefined {
    const current = this.current;
    const reader = current.state.lifecycle.volumeReader;
    const viewport = current.context?.viewport;
    if (!reader?.readView || !reader.geometry || !viewport) {
      return undefined;
    }
    const volumeToClip = new Matrix4(viewport.viewProjectionMatrix).multiplyRight(
      getVoxelVolumeToCommon({ ...current.props, volume: reader.geometry }, viewport),
    );
    return {
      volumeToClip,
      signal,
      ...(current.props.clipBounds && { clipBounds: current.props.clipBounds }),
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
    if (!this.props.preload || lifecycle.preloading || cache.frameCount < 2) {
      return;
    }
    const request = new AbortController();
    const start = this.props.frameIndex ?? 0;
    const count = Math.min(2, cache.frameCount - 1);
    const reader = lifecycle.volumeReader;
    const view = this.viewOptions(request.signal);
    if (!view && cache.isComplete) {
      return;
    }
    lifecycle.preloading = request;
    this.setActivity(
      'buffering',
      Boolean(view) ||
        Array.from({ length: count }, (_, offset) =>
          cache.has((start + offset + 1) % cache.frameCount),
        ).includes(false),
    );
    void (async () => {
      try {
        for (let offset = 1; offset <= (view ? count : cache.frameCount); offset++) {
          const signal = this.requestSignal(request);
          if (view && reader?.readView) {
            await reader.readView((start + offset) % cache.frameCount, {
              ...view,
              signal,
              priority: BACKGROUND_PRIORITY,
            });
          } else {
            await cache.read((start + offset) % cache.frameCount, signal);
          }
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

  /** Debounced view changes let useful reads finish before replacing them with the next view. */
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
      const reader = lifecycle.volumeReader;
      const view = this.viewOptions(signal);
      const volume =
        view && reader?.readView
          ? await reader.readView(index, {
              ...view,
              onProgress: (partial) => {
                if (!signal.aborted) {
                  const current = this.current;
                  current.setState({ volume: partial });
                  current.props.onVolumeProgress?.(partial);
                }
              },
            })
          : await cache.read(index, signal);
      signal.throwIfAborted();
      request.signal.throwIfAborted();
      const current = this.current;
      current.setState({ volume, completeVolume: volume });
      current.props.onVolumeLoad?.(volume);
      current.startPreload(cache);
    } catch (error: unknown) {
      if (!request.signal.aborted) {
        this.current.setState({ volume: this.current.state.completeVolume });
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
      maxCells: _maxCells,
      maxRequests: _maxRequests,
      debounceTime: _debounceTime,
      onVolumeProgress: _onVolumeProgress,
      maxCacheBytes: _maxCacheBytes,
      requestTimeout: _requestTimeout,
      onSourceLoad: _onSourceLoad,
      onVolumeLoad: _onVolumeLoad,
      onLoadStateChange: _onLoadStateChange,
      ...style
    } = this.props;
    return new VoxelLayer({ ...style, ...this.getSubLayerProps({ id: 'volume' }), volume });
  }

  override finalizeState(): void {
    clearTimeout(this.state.lifecycle.timer);
    this.state.lifecycle.timer = undefined;
    this.state.lifecycle.volumeReader?.dispose?.();
    this.state.lifecycle.volumeReader = undefined;
    this.state.lifecycle.opening?.abort();
    this.state.lifecycle.preloading?.abort();
    this.state.lifecycle.preloading = undefined;
    this.state.lifecycle.reading?.abort();
    this.state.lifecycle.reading = undefined;
    this.state.lifecycle.cache = undefined;
    this.state.lifecycle.reader = undefined;
  }
}

/** Distinguishes a custom frame reader from a URL or a byte-addressable Zarr store. */
function isVolumeReader(input: ZarrStoreInput | ZarrVolume): input is ZarrVolume {
  return typeof input === 'object' && 'readFrame' in input;
}
