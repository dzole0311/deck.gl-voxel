import { Deck, type Layer, MapView, type MapViewState, type Viewport } from '@deck.gl/core';
import type { ChunkInspectorView } from '@deck.gl-voxel/example-ui';
import { webgpuAdapter } from '@luma.gl/webgpu';
import { Matrix4 } from '@math.gl/core';
import { lngLatToWorld, unitsPerMeter } from '@math.gl/web-mercator';
import {
  type CellHit,
  CellLayer,
  pickCellCollection,
  type Vector3,
  type VoxelGeometry,
} from 'deck.gl-voxel';
import type { GeoZarrCellSource, GeoZarrCellTile } from 'deck.gl-voxel-zarr';
import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

/** Ground-relative exaggeration shared by volumes, context and camera focus. */
export const EXAGGERATION = 20;
/** Converts a displayed geographic point with the same latitude-dependent height units as the cell renderer. */
export function contextCommon(
  position: readonly [number, number, number],
): [number, number, number] {
  const xy = lngLatToWorld([position[0], position[1]]);
  return [xy[0] ?? 0, xy[1] ?? 0, position[2] * unitsPerMeter(position[1])];
}
function isPosition(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}
export const SOURCE_URL =
  import.meta.env.VITE_AEM_ZARR_URL ||
  'https://d3d0qchq1igql3.cloudfront.net/aem/dwr-2026-11-23-v4/aem.zarr/';
export const INITIAL_VIEW: MapViewState = {
  longitude: -119.55,
  latitude: 36.5,
  zoom: 10.8,
  pitch: 62,
  bearing: -25,
  position: [0, 0, -1300],
  minPitch: 0,
  maxPitch: 175,
  minZoom: 1,
  maxZoom: 18,
};

export type Hover = { readonly x: number; readonly y: number } & (
  { readonly hit: CellHit; readonly tile: GeoZarrCellTile } | { readonly text: string }
);

/** Owns a WebGPU camera and a faint map backdrop; source scheduling stays in the Zarr package. */
export class AemViewer implements ChunkInspectorView {
  readonly deck: Deck<MapView>;
  private readonly map: MapLibreMap;
  private readonly listeners = new Set<() => void>();
  private source: GeoZarrCellSource | undefined;
  private unsubscribe: (() => void) | undefined;
  private view: MapViewState = INITIAL_VIEW;
  private palette: Uint8Array = new Uint8Array();
  private visibleBins = 1023;
  private fields = new Set<string>();
  private frameRequest: number | undefined;
  private disposed = false;
  private contextLayers: readonly Layer[] = [];
  private contextVisible = true;
  private mapCamera = '';
  private depth = 70;
  private readonly lifetime = new AbortController();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onHover: (value: Hover | undefined) => void,
    private readonly onError: (error: Error) => void,
  ) {
    setWorkerUrl(workerUrl);
    this.map = new MapLibreMap({
      container: 'map',
      style: 'https://tiles.openfreemap.org/styles/positron',
      center: [INITIAL_VIEW.longitude, INITIAL_VIEW.latitude],
      zoom: INITIAL_VIEW.zoom,
      pitch: INITIAL_VIEW.pitch ?? 0,
      maxPitch: 85,
      bearing: INITIAL_VIEW.bearing ?? 0,
      centerClampedToGround: false,
      interactive: false,
      attributionControl: { compact: true },
      renderWorldCopies: false,
    });
    this.map.setCenterElevation(INITIAL_VIEW.position?.[2] ?? 0);
    this.map.on('error', (event) => this.onError(new Error(event.error.message)));
    this.deck = new Deck({
      canvas,
      views: new MapView({ repeat: false, nearZMultiplier: 0.02, farZMultiplier: 4 }),
      viewState: this.view,
      controller: { keyboard: true },
      useDevicePixels: 1,
      deviceProps: {
        type: 'webgpu',
        adapters: [webgpuAdapter],
        createCanvasContext: { alphaMode: 'premultiplied' },
        onError,
      },
      onError,
      onViewStateChange: ({ viewState }) => {
        this.setView(viewState as MapViewState);
      },
      onLoad: () => this.schedule(),
      onHover: ({ x, y, object }) => {
        if (document.elementFromPoint(x, y) !== this.canvas) {
          this.onHover(undefined);
          return;
        }
        const hit = this.pick(x, y);
        if (
          object &&
          typeof object === 'object' &&
          'tooltip' in object &&
          typeof object.tooltip === 'string' &&
          'source' in object &&
          'target' in object &&
          isPosition(object.source) &&
          isPosition(object.target) &&
          this.contextInFront(object.source, object.target, [x, y], hit?.hit)
        ) {
          onHover({ x, y, text: object.tooltip });
          return;
        }
        onHover(hit ? { x, y, ...hit } : undefined);
      },
    });
    window.addEventListener('resize', this.schedule, { signal: this.lifetime.signal });
  }
  /** Connects a prepared source without recreating the camera or graphics device. */
  setSource(source: GeoZarrCellSource, palette: Uint8Array): void {
    this.unsubscribe?.();
    this.source = source;
    this.palette = palette;
    this.fields = new Set(source.fields.map((f) => f.path));
    this.unsubscribe = source.subscribe(() => {
      this.render();
      this.notify();
    });
    this.schedule();
  }
  /** Category changes only update GPU visibility; pending source reads remain useful. */
  setCategories(mask: number): void {
    this.onHover(undefined);
    this.visibleBins = mask;
    this.render();
  }
  /** Applies the selected field set, recomputing deterministic native overlap ownership. */
  setFields(fields: ReadonlySet<string>): void {
    this.onHover(undefined);
    this.fields = new Set(fields);
    this.schedule();
  }
  /** Changes the physical focus depth below the local ground at the map center. */
  setDepth(depth: number): void {
    this.depth = depth;
    this.focusDepth();
    this.setView(this.view);
  }
  /** Controls backdrop visibility. It remains a low-opacity backdrop, without an opaque depth plane. */
  setContextVisible(visible: boolean): void {
    this.contextVisible = visible;
    this.syncBackdrop();
  }
  /** Supplies already prepared context. Context uses the same opaque renderer and physical elevations. */
  setContextLayers(layers: readonly Layer[]): void {
    this.contextLayers = layers;
    this.render();
  }
  /** Samples local ground for context assets that publish horizontal positions only. */
  groundAt(longitude: number, latitude: number): number | undefined {
    return this.groundSampler()(longitude, latitude);
  }
  /** Captures immutable loaded grids once for a batch of context positions. */
  groundSampler(): (longitude: number, latitude: number) => number | undefined {
    const tiles = this.source?.getTiles() ?? [];
    return (longitude, latitude) => {
      const point = lngLatToWorld([longitude, latitude]);
      for (const tile of tiles) {
        const g = tile.mesh.grid,
          x = Math.floor(((point[0] ?? 0) - g.origin[0]) / g.spacing[0]),
          y = Math.floor(((point[1] ?? 0) - g.origin[1]) / g.spacing[1]);
        if (x >= 0 && y >= 0 && x < g.dimensions[0] && y < g.dimensions[1]) {
          const ground = g.ground[x + g.dimensions[0] * y];
          if (ground !== undefined && Number.isFinite(ground)) {
            return ground;
          }
        }
      }
      return undefined;
    };
  }
  /** Current camera, also used by browser verification. */
  getView(): MapViewState {
    return this.view;
  }
  /** Sets an explicit geographic view, supporting positions below ground and pitches past the horizon. */
  setView(view: MapViewState): void {
    this.onHover(undefined);
    this.view = { ...view };
    this.deck.setProps({ viewState: this.view });
    this.syncBackdrop();
    this.schedule();
    this.notify();
  }
  private focusDepth(): void {
    const ground = this.groundAt(this.view.longitude, this.view.latitude) ?? 0;
    this.view = { ...this.view, position: [0, 0, ground - EXAGGERATION * this.depth] };
  }
  private readonly schedule = (): void => {
    if (this.frameRequest !== undefined || this.disposed) {
      return;
    }
    this.frameRequest = requestAnimationFrame(() => {
      this.frameRequest = undefined;
      const viewport = this.viewport();
      if (viewport) {
        this.syncBackdrop();
        this.source?.update(viewport, EXAGGERATION, this.fields);
      }
    });
  };
  private syncBackdrop(): void {
    const aboveDatum = (this.viewport()?.cameraPosition[2] ?? 1) > 0;
    const visible = this.contextVisible && (this.view.pitch ?? 0) < 85 && aboveDatum;
    this.map.getContainer().style.opacity = visible ? '0.28' : '0';
    if (!visible) {
      return;
    }
    const view = this.view,
      key = [
        view.longitude,
        view.latitude,
        view.zoom,
        view.bearing,
        view.pitch,
        view.position?.[2],
      ].join(',');
    if (key === this.mapCamera) {
      return;
    }
    this.mapCamera = key;
    this.map.jumpTo({
      center: [view.longitude, view.latitude],
      zoom: view.zoom,
      bearing: view.bearing ?? 0,
      pitch: view.pitch ?? 0,
      elevation: view.position?.[2] ?? 0,
    });
  }
  private render(): void {
    if (this.disposed) {
      return;
    }
    this.onHover(undefined);
    this.deck.setProps({
      layers: [
        ...(this.source?.getTiles() ?? [])
          .filter((tile) => tile.mesh.count > 0)
          .map(
            (tile) =>
              new CellLayer({
                id: tile.id,
                mesh: tile.mesh,
                palette: this.palette,
                exaggeration: EXAGGERATION,
                visibleBins: this.visibleBins,
              }),
          ),
        ...this.contextLayers,
      ],
    });
  }
  /** Finds the same native column and stored value that the opaque renderer displays. */
  pick(x: number, y: number): { hit: CellHit; tile: GeoZarrCellTile } | undefined {
    const viewport = this.viewport();
    if (!viewport) {
      return undefined;
    }
    const inverse = new Matrix4(viewport.viewProjectionMatrix).invert();
    const p = inverse.transformAsPoint([
      (x / viewport.width) * 2 - 1,
      1 - (y / viewport.height) * 2,
      -1,
    ]);
    const q = inverse.transformAsPoint([
      (x / viewport.width) * 2 - 1,
      1 - (y / viewport.height) * 2,
      1,
    ]);
    const origin: Vector3 = [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0],
      direction: Vector3 = [
        (q[0] ?? 0) - origin[0],
        (q[1] ?? 0) - origin[1],
        (q[2] ?? 0) - origin[2],
      ];
    const nearest = pickCellCollection(
      this.source?.getTiles() ?? [],
      { origin, direction },
      EXAGGERATION,
      this.visibleBins,
    );
    return nearest ? { hit: nearest.hit, tile: nearest.item } : undefined;
  }
  private viewport(): Viewport | undefined {
    return this.deck.isInitialized ? this.deck.getViewports()[0] : undefined;
  }
  private contextInFront(
    source: [number, number, number],
    target: [number, number, number],
    point: readonly [number, number],
    hit: CellHit | undefined,
  ): boolean {
    const viewport = this.viewport();
    if (!hit || !viewport) {
      return true;
    }
    const matrix = new Matrix4(viewport.viewProjectionMatrix),
      a = matrix.transformAsPoint(contextCommon(source)),
      b = matrix.transformAsPoint(contextCommon(target));
    const sx = (((a[0] ?? 0) + 1) * viewport.width) / 2,
      sy = ((1 - (a[1] ?? 0)) * viewport.height) / 2;
    const dx = (((b[0] ?? 0) - (a[0] ?? 0)) * viewport.width) / 2,
      dy = (((a[1] ?? 0) - (b[1] ?? 0)) * viewport.height) / 2;
    const fraction = Math.max(
      0,
      Math.min(1, ((point[0] - sx) * dx + (point[1] - sy) * dy) / (dx * dx + dy * dy || 1)),
    );
    const depth = (a[2] ?? 0) + fraction * ((b[2] ?? 0) - (a[2] ?? 0)),
      opaque = matrix.transformAsPoint(hit.position);
    return depth <= (opaque[2] ?? 0) + 1e-7;
  }
  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
  getReader(): GeoZarrCellSource | undefined {
    return this.source;
  }
  getVolumeToCommon(geometry: VoxelGeometry): readonly number[] {
    return new Matrix4()
      .translate(geometry.origin ?? [0, 0, 0])
      .scale((geometry.spacing ?? [1, 1, 1]).map((v, i) => v * (geometry.dimensions[i] ?? 1)));
  }
  getVolumeToClip(geometry: VoxelGeometry): readonly number[] | undefined {
    const viewport = this.viewport();
    return viewport
      ? new Matrix4(viewport.viewProjectionMatrix).multiplyRight(this.getVolumeToCommon(geometry))
      : undefined;
  }
  getViewport() {
    const viewport = this.viewport(),
      bounds = this.canvas.getBoundingClientRect();
    return viewport
      ? { x: bounds.left, y: bounds.top, width: viewport.width, height: viewport.height }
      : undefined;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Releases maps, device resources and subscriptions. Source ownership stays with the caller. */
  dispose(): void {
    this.disposed = true;
    this.lifetime.abort();
    this.unsubscribe?.();
    if (this.frameRequest !== undefined) {
      cancelAnimationFrame(this.frameRequest);
    }
    this.listeners.clear();
    this.deck.finalize();
    this.map.remove();
  }
}
