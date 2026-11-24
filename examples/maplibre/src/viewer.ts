import { Deck, MapView, type MapViewState } from '@deck.gl/core';
import type { ChunkInspectorView } from '@deck.gl-voxel/example-ui';
import { webgpuAdapter } from '@luma.gl/webgpu';
import { Matrix4 } from '@math.gl/core';
import { getVoxelVolumeToCommon, type VoxelData, type VoxelGeometry } from 'deck.gl-voxel';
import { type ZarrVolume, ZarrVoxelLayer } from 'deck.gl-voxel-zarr';
import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { Dataset } from './datasets.js';
import { pickVolumeSample } from './volume-hover.js';

const MAP_ANGLE = { pitch: 48, bearing: -12 };

/** Rendering and loading settings controlled by the example UI. */
export interface ViewerSettings {
  readonly dataset: Dataset;
  readonly frameIndex: number;
  readonly renderMode: 'volume' | 'isosurface';
  readonly isovalue: number;
  readonly density: number;
  readonly exaggeration: number;
  readonly playing: boolean;
  readonly revision: number;
  readonly slowRequests: boolean;
}

/** A sample under the map pointer, placed in browser CSS pixels. */
export interface HoverSample {
  readonly text: string;
  readonly x: number;
  readonly y: number;
}

interface ViewerCallbacks {
  readonly onSource: (frameCount: number) => void;
  readonly onLoad: () => void;
  readonly onLoading: (loading: boolean) => void;
  readonly onError: (error: Error) => void;
  readonly onHover: (sample: HoverSample | undefined) => void;
}

function getViewState(map: MapLibreMap): MapViewState {
  const { lng, lat } = map.getCenter();
  return {
    longitude: lng,
    latitude: lat,
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    bearing: map.getBearing(),
  };
}

/** Owns one map and deck instance. Settings updates retain them; dispose releases listeners, reads and GPU resources. */
export class ExampleViewer implements ChunkInspectorView {
  private readonly map: MapLibreMap;
  private readonly deck: Deck<MapView>;
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<() => void>();
  private settings: ViewerSettings | undefined;
  private matrix = new Matrix4();
  private reader: ZarrVolume | undefined;
  private frame: VoxelData | undefined;
  private completeFrame: VoxelData | undefined;
  private epoch = 0;
  private disposed = false;

  constructor(
    container: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly callbacks: ViewerCallbacks,
  ) {
    setWorkerUrl(workerUrl);
    this.map = new MapLibreMap({
      container,
      style: 'https://tiles.openfreemap.org/styles/positron',
      center: [-81, 31],
      zoom: 3.5,
      ...MAP_ANGLE,
      renderWorldCopies: false,
      dragRotate: { around: 'center', movement: 'linear' },
    });
    try {
      this.deck = new Deck({
        canvas,
        views: new MapView({ repeat: false }),
        viewState: getViewState(this.map),
        controller: false,
        useDevicePixels: 1,
        deviceProps: {
          type: 'webgpu',
          adapters: [webgpuAdapter],
          createCanvasContext: { alphaMode: 'premultiplied' },
          onError: (error) => this.reportError(error),
        },
        onError: (error) => this.reportError(error),
      });
    } catch (error) {
      this.lifetime.abort();
      this.map.remove();
      throw error;
    }
    this.map.on('move', this.syncCamera);
    this.map.on('resize', this.syncCamera);
    this.map.on('mouseout', this.hideTooltip);
    this.map.on('mousedown', this.hideTooltip);
    this.map.on('mousemove', ({ point, originalEvent }) => {
      const settings = this.settings;
      if (
        !settings ||
        !this.frame ||
        settings.renderMode === 'isosurface' ||
        !this.deck.isInitialized ||
        originalEvent.buttons ||
        this.map.isMoving()
      ) {
        this.hideTooltip();
        return;
      }
      const viewport = this.deck.getViewports()[0];
      if (!viewport) {
        return;
      }
      const sample = pickVolumeSample(
        this.frame,
        viewport,
        [point.x, point.y],
        this.matrix,
        settings.dataset.transferFunction,
        settings.dataset.valueRange,
        settings.density,
      );
      this.callbacks.onHover(
        sample
          ? {
              text: `${settings.dataset.valueLabel} ${settings.dataset.formatValue(sample.value)} - ${(sample.altitudeMeters / 1000).toFixed(1)} km altitude`,
              x: point.x,
              y: point.y,
            }
          : undefined,
      );
    });
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape') {
          this.hideTooltip();
        }
      },
      { signal: this.lifetime.signal },
    );
  }

  /** Applies controls without rebuilding the map or reopening equivalent sources. */
  update(settings: ViewerSettings): void {
    if (this.disposed) {
      return;
    }
    const previous = this.settings;
    const sourceChanged =
      !previous || previous.dataset !== settings.dataset || previous.revision !== settings.revision;
    this.settings = settings;
    if (!previous || previous.exaggeration !== settings.exaggeration) {
      this.matrix = new Matrix4().scale([1, 1, settings.exaggeration]);
    }
    if (sourceChanged) {
      this.epoch++;
      this.reader = undefined;
      this.frame = undefined;
      this.completeFrame = undefined;
      if (!previous || previous.dataset !== settings.dataset) {
        this.map.jumpTo({
          center: settings.dataset.center,
          zoom: settings.dataset.zoom,
          ...MAP_ANGLE,
        });
      }
    }
    this.render();
    this.notify();
  }

  private readonly fetch = async (
    url: string,
    options: { request?: Request; signal?: AbortSignal },
  ): Promise<Response> => {
    const request =
      options.request ?? new Request(url, options.signal ? { signal: options.signal } : {});
    if (
      this.settings?.slowRequests &&
      /\/c\/|\/\d+(?:\.\d+)+$/.test(new URL(request.url).pathname)
    ) {
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => {
          clearTimeout(timer);
          reject(request.signal.reason);
        };
        const timer = setTimeout(() => {
          request.signal.removeEventListener('abort', abort);
          resolve();
        }, 600);
        request.signal.addEventListener('abort', abort, { once: true });
        if (request.signal.aborted) {
          abort();
        }
      });
    }
    return globalThis.fetch(request);
  };

  private render(): void {
    const settings = this.settings;
    if (!settings || this.disposed) {
      return;
    }
    const { dataset } = settings;
    const epoch = this.epoch;
    const active = (): boolean => !this.disposed && this.epoch === epoch;
    this.deck.setProps({
      layers: [
        new ZarrVoxelLayer({
          id: `${dataset.id}-${epoch}`,
          source: dataset.volumeSource,
          ...(dataset.sourceOptions && { sourceOptions: dataset.sourceOptions }),
          fetch: this.fetch,
          frameIndex: settings.frameIndex,
          preload: settings.playing,
          maxCacheBytes: 128 * 1024 * 1024,
          maxRequests: settings.slowRequests && typeof dataset.volumeSource === 'string' ? 2 : 6,
          requestTimeout: settings.slowRequests ? 60_000 : 20_000,
          modelMatrix: this.matrix,
          renderMode: settings.renderMode,
          isovalue: settings.isovalue,
          density: settings.density,
          colorBy: dataset.colorBy,
          valueRange: dataset.valueRange,
          transferFunction: dataset.transferFunction,
          opacityUnitDistance: Math.abs(this.frame?.spacing?.[2] ?? 1),
          showBounds: true,
          onSourceLoad: (reader) => {
            if (active()) {
              this.reader = reader;
              this.callbacks.onSource(reader.frameCount);
              this.notify();
            }
          },
          onVolumeProgress: (volume) => {
            if (active()) {
              this.frame = volume;
              this.render();
            }
          },
          onVolumeLoad: (volume) => {
            if (active()) {
              this.frame = volume;
              this.completeFrame = volume;
              this.callbacks.onLoad();
              this.render();
            }
          },
          onLoadStateChange: (loading) => {
            if (active()) {
              this.callbacks.onLoading(loading);
            }
          },
          onError: (error) => {
            if (active()) {
              this.frame = this.completeFrame ?? this.frame;
              this.callbacks.onError(error);
              this.render();
            }
            return true;
          },
        }),
      ],
    });
    this.hideTooltip();
  }

  private readonly syncCamera = (): void => {
    this.hideTooltip();
    this.deck.setProps({ viewState: getViewState(this.map) });
    this.notify();
  };
  private readonly hideTooltip = (): void => {
    if (!this.disposed) {
      this.callbacks.onHover(undefined);
    }
  };
  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
  private reportError(error: Error): void {
    if (!this.disposed) {
      this.callbacks.onError(error);
    }
  }

  /** Current reader, including its optional read-only chunk diagnostics. */
  getReader(): ZarrVolume | undefined {
    return this.reader;
  }
  /** Uses the renderer's camera, geometry and display transform for outlines. */
  getVolumeToClip(geometry: VoxelGeometry): readonly number[] | undefined {
    const viewport = this.deck.isInitialized ? this.deck.getViewports()[0] : undefined;
    return viewport
      ? new Matrix4(viewport.viewProjectionMatrix).multiplyRight(
          getVoxelVolumeToCommon({ volume: geometry, modelMatrix: this.matrix }, viewport),
        )
      : undefined;
  }
  /** View bounds in browser CSS pixels, including the canvas offset. */
  getViewport() {
    const viewport = this.deck.isInitialized ? this.deck.getViewports()[0] : undefined;
    const bounds = this.canvas.getBoundingClientRect();
    return viewport
      ? {
          x: bounds.left + viewport.x,
          y: bounds.top + viewport.y,
          width: viewport.width,
          height: viewport.height,
        }
      : undefined;
  }
  /** Returns an unsubscribe function; inspector instances never attach duplicate map listeners. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Moves the map one zoom step. */
  zoom(delta: number): void {
    this.map.zoomTo(this.map.getZoom() + delta);
  }
  /** Restores north-up bearing while preserving the current extent. */
  resetBearing(): void {
    this.map.rotateTo(0);
  }
  /** Cancels active reads and releases the map, deck and example event listeners. Safe to call twice. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.lifetime.abort();
    this.listeners.clear();
    this.deck.finalize();
    this.map.remove();
    this.reader = undefined;
    this.frame = undefined;
    this.completeFrame = undefined;
  }
}
