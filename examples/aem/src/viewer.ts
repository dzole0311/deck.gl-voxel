import { Deck, type Layer, MapView, type MapViewState, type Viewport } from '@deck.gl/core';
import type { ChunkInspectorView } from '@deck.gl-voxel/example-ui';
import { webgpuAdapter } from '@luma.gl/webgpu';
import { Matrix4, Vector4 } from '@math.gl/core';
import { lngLatToWorld, unitsPerMeter } from '@math.gl/web-mercator';
import {
  type CellClipBounds,
  type CellHit,
  displayElevation,
  getCellPickingRay,
  pickCellCollection,
  type VoxelGeometry,
} from 'deck.gl-voxel';
import {
  type GeoZarrCollection,
  type GeoZarrCollectionTile,
  ZarrVoxelLayer,
} from 'deck.gl-voxel-zarr';
import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { BoreholeLog } from './borehole.js';

/** Ground-relative exaggeration shared by volumes, context and camera focus. */
export const EXAGGERATION = 20;
/** CSS-pixel hit radii give mouse and touch wider targets while keeping the drawn lines thin. */
const BOREHOLE_PICK_RADIUS = { mouse: 12, touch: 22 } as const;
/** Converts a displayed geographic point with the same latitude-dependent height units as the cell renderer. */
function contextCommon(position: readonly [number, number, number]): [number, number, number] {
  const xy = lngLatToWorld([position[0], position[1]]);
  return [xy[0] ?? 0, xy[1] ?? 0, position[2] * unitsPerMeter(position[1])];
}
function isPosition(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

type ScreenPoint = readonly [number, number, number];

/**
 * Clips before the perspective divide so lines behind the camera cannot create false click targets.
 * Keeps all four clip coordinates until clipping is complete, then returns CSS XY and camera depth in [-1, 1].
 */
function projectContextSegment(
  source: readonly [number, number, number],
  target: readonly [number, number, number],
  matrix: Matrix4,
  viewport: Viewport,
): readonly [ScreenPoint, ScreenPoint] | undefined {
  const a = new Vector4(...contextCommon(source), 1);
  const b = new Vector4(...contextCommon(target), 1);
  matrix.transform(a, a);
  matrix.transform(b, b);
  if (![...a, ...b].every(Number.isFinite)) {
    return undefined;
  }
  const planes: readonly (readonly [number, number])[] = [
    [a.w + a.x, b.w + b.x],
    [a.w - a.x, b.w - b.x],
    [a.w + a.y, b.w + b.y],
    [a.w - a.y, b.w - b.y],
    [a.w + a.z, b.w + b.z],
    [a.w - a.z, b.w - b.z],
  ];
  let start = 0;
  let end = 1;
  const clipTolerance = Number.EPSILON * 8 * Math.max(1, Math.abs(a.w), Math.abs(b.w));
  for (const [rawFrom, rawTo] of planes) {
    const from = Math.abs(rawFrom) <= clipTolerance ? 0 : rawFrom;
    const to = Math.abs(rawTo) <= clipTolerance ? 0 : rawTo;
    if (from < 0 && to < 0) {
      return undefined;
    }
    if (from < 0) {
      start = Math.max(start, from / (from - to));
    } else if (to < 0) {
      end = Math.min(end, from / (from - to));
    }
  }
  if (start > end) {
    return undefined;
  }
  const project = (fraction: number): ScreenPoint | undefined => {
    const point = new Vector4(a).lerp(b, fraction);
    return point.w > 0
      ? [
          ((point.x / point.w + 1) * viewport.width) / 2,
          ((1 - point.y / point.w) * viewport.height) / 2,
          point.z / point.w,
        ]
      : undefined;
  };
  const first = project(start);
  const last = project(end);
  return first && last ? [first, last] : undefined;
}
export const SOURCE_URL: string | undefined = import.meta.env.VITE_AEM_ZARR_URL;
export const INITIAL_VIEW: MapViewState = {
  longitude: -119.55,
  latitude: 36.5,
  zoom: 10.8,
  pitch: 62,
  bearing: -25,
  position: [0, 0, 0],
  minPitch: 0,
  maxPitch: 175,
  minZoom: 1,
  maxZoom: 18,
};

export type Hover = { readonly x: number; readonly y: number } & (
  { readonly hit: CellHit; readonly tile: GeoZarrCollectionTile } | { readonly text: string }
);

interface AemViewerOptions {
  readonly source: string;
  readonly palette: Uint8Array;
  readonly onHover: (value: Hover | undefined) => void;
  readonly onError: (error: Error) => void;
  readonly onBoreholeClick: (borehole: BoreholeLog) => void;
  readonly onSourceLoad: (source: GeoZarrCollection) => void;
  readonly onSourceUpdate: (source: GeoZarrCollection) => void;
}

/** Owns the WebGPU camera and light basemap; its Zarr layer owns loading and cached data. */
export class AemViewer implements ChunkInspectorView {
  readonly deck: Deck<MapView>;
  private readonly map: MapLibreMap;
  private readonly listeners = new Set<() => void>();
  private source: GeoZarrCollection | undefined;
  private view: MapViewState = INITIAL_VIEW;
  private visibleBins = 1023;
  private hoveredCell: { readonly x: number; readonly y: number } | undefined;
  private volumeVisible = true;
  private clipBounds: CellClipBounds | undefined;
  private readonly inspectorReader = {
    getDebugState: () => this.source?.getDebugState(this.clipBounds),
  };
  private fields: ReadonlySet<string> | undefined;
  private disposed = false;
  private contextLayers: readonly Layer[] = [];
  private boreholes = new Map<string, BoreholeLog>();
  private contextVisible = true;
  private mapCamera = '';
  private depth = 0;
  private readonly lifetime = new AbortController();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly options: AemViewerOptions,
  ) {
    const { onHover, onError } = options;
    setWorkerUrl(workerUrl);
    this.map = new MapLibreMap({
      container: 'map',
      style: 'https://tiles.openfreemap.org/styles/positron',
      center: [INITIAL_VIEW.longitude, INITIAL_VIEW.latitude],
      zoom: INITIAL_VIEW.zoom,
      pitch: INITIAL_VIEW.pitch ?? 0,
      maxPitch: 175,
      transformCameraUpdate: this.basemapCameraUpdate,
      bearing: INITIAL_VIEW.bearing ?? 0,
      centerClampedToGround: false,
      interactive: false,
      attributionControl: { compact: true },
      renderWorldCopies: false,
    });
    this.map.setCenterElevation(INITIAL_VIEW.position?.[2] ?? 0);
    this.map.on('error', (event) => this.options.onError(new Error(event.error.message)));
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
      onLoad: () => {
        this.syncBackdrop();
        this.render();
      },
      onHover: ({ x, y, object }) => {
        if (document.elementFromPoint(x, y) !== this.canvas) {
          this.clearHover();
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
          this.hoveredCell = undefined;
          onHover({ x, y, text: object.tooltip });
          return;
        }
        this.hoveredCell = hit ? { x, y } : undefined;
        onHover(hit ? { x, y, ...hit } : undefined);
      },
      onClick: ({ x, y }, event) => {
        if (document.elementFromPoint(x, y) !== this.canvas) {
          return;
        }
        const radius =
          event.pointerType === 'touch' ? BOREHOLE_PICK_RADIUS.touch : BOREHOLE_PICK_RADIUS.mouse;
        const borehole = this.pickBorehole(x, y, radius);
        if (borehole) {
          this.clearHover();
          this.options.onBoreholeClick(borehole);
        }
      },
    });
    canvas.addEventListener('contextmenu', (event) => event.preventDefault(), {
      signal: this.lifetime.signal,
    });
    canvas.addEventListener('pointerleave', this.clearHover, { signal: this.lifetime.signal });
  }
  /** Borrows layer-owned metadata for the UI; the layer retains cancellation and disposal. */
  private readonly sourceLoaded = (source: GeoZarrCollection): void => {
    if (this.disposed) {
      return;
    }
    this.source = source;
    this.options.onSourceLoad(source);
  };
  /** Refreshes picking and inspector context after the layer publishes changed tiles or loading state. */
  private readonly sourceUpdated = (source: GeoZarrCollection): void => {
    if (this.disposed) {
      return;
    }
    this.source = source;
    this.options.onSourceUpdate(source);
    if (!this.hoveredCell) {
      this.options.onHover(undefined);
    }
    this.refreshCellHover();
    this.notify();
  };
  /** Changes displayed categories without invalidating useful pending source reads. */
  setCategories(mask: number): void {
    this.visibleBins = mask;
    this.render();
  }
  /** Pauses tile reads while hiding volume drawing and picking; cached tiles and context layers remain available. */
  setVolumeVisible(visible: boolean): void {
    this.volumeVisible = visible;
    this.render();
  }
  /** Applies shared common-XY, physical-meter-Z slicing bounds to drawing, picking and inspector outlines. */
  setClipBounds(bounds: CellClipBounds | undefined): void {
    if (
      bounds &&
      (bounds.some(Number.isNaN) ||
        bounds[0] > bounds[3] ||
        bounds[1] > bounds[4] ||
        bounds[2] > bounds[5])
    ) {
      throw new Error(
        'Cell clip bounds require ordered common XY and physical Z bounds without NaN.',
      );
    }
    this.clipBounds = bounds ? [...bounds] : undefined;
    this.render();
    this.notify();
  }
  /** Applies the selected field set, recomputing deterministic native overlap ownership. */
  setFields(fields: ReadonlySet<string>): void {
    this.options.onHover(undefined);
    this.fields = new Set(fields);
    this.render();
  }
  /** Changes the physical focus depth below the local ground at the map center. */
  setDepth(depth: number): void {
    this.depth = depth;
    this.focusDepth();
    this.setView(this.view);
  }
  /** Shows or hides the light basemap behind the volume without adding a depth plane. */
  setContextVisible(visible: boolean): void {
    this.contextVisible = visible;
    this.syncBackdrop();
  }
  /** Replaces optional flight and borehole layers without changing the volume data. */
  setContextLayers(layers: readonly Layer[], boreholes: readonly BoreholeLog[] = []): void {
    this.contextLayers = layers;
    this.boreholes = new Map(boreholes.map((borehole) => [borehole.id, borehole]));
    this.render();
  }
  /** Captures loaded ground elevations for geographic context points without requesting data. */
  groundSampler(): (longitude: number, latitude: number) => number | undefined {
    return this.source?.createGroundSampler() ?? (() => undefined);
  }
  /** Current camera, also used by browser verification. */
  getView(): MapViewState {
    return this.view;
  }
  /** Sets an explicit geographic view, supporting positions below ground and pitches past the horizon. */
  setView(view: MapViewState): void {
    this.clearHover();
    this.view = { ...view };
    this.deck.setProps({ viewState: this.view });
    this.syncBackdrop();
    this.notify();
  }
  private focusDepth(): void {
    const ground = this.groundSampler()(this.view.longitude, this.view.latitude) ?? 0;
    this.view = { ...this.view, position: [0, 0, ground - EXAGGERATION * this.depth] };
  }
  /**
   * Keeps both cameras aligned when exploring below the map surface.
   * MapLibre normally raises an underground camera. Restore the requested angles and zoom through its
   * public callback, without returning elevation, which would apply that ground check a second time.
   */
  private readonly basemapCameraUpdate = () => ({
    zoom: this.view.zoom,
    pitch: this.view.pitch ?? 0,
    bearing: this.view.bearing ?? 0,
  });
  /** Leaves the light basemap behind the opaque volume, including its native underground labels. */
  private syncBackdrop(): void {
    this.map.getContainer().style.opacity = this.contextVisible ? '1' : '0';
    if (!this.contextVisible) {
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
    if (!this.hoveredCell) {
      this.options.onHover(undefined);
    }
    this.deck.setProps({
      layers: [
        new ZarrVoxelLayer({
          id: 'aem-cells',
          renderMode: 'cells',
          source: this.options.source,
          sourceOptions: {
            field: 'coarse_fraction',
            verticalCoordinates: 'z',
            groundElevation: 'ground_elevation',
            validity: 'validity',
          },
          palette: this.options.palette,
          valueRange: [0, 1],
          exaggeration: EXAGGERATION,
          visibleBins: this.visibleBins,
          ...(this.clipBounds ? { physicalClipBounds: this.clipBounds } : {}),
          ...(this.fields ? { selectedFields: this.fields } : {}),
          visible: this.volumeVisible,
          onSourceLoad: this.sourceLoaded,
          onSourceUpdate: this.sourceUpdated,
          onError: this.options.onError,
        }),
        ...this.contextLayers,
      ],
    });
    this.refreshCellHover();
  }
  private readonly clearHover = (): void => {
    this.hoveredCell = undefined;
    this.options.onHover(undefined);
  };
  /** Rechecks the current tile after refinement while keeping a stationary pointer tooltip visible. */
  private refreshCellHover(): void {
    const point = this.hoveredCell;
    if (!point) {
      return;
    }
    if (document.elementFromPoint(point.x, point.y) !== this.canvas) {
      this.clearHover();
      return;
    }
    const hit = this.pick(point.x, point.y);
    this.options.onHover(hit ? { ...point, ...hit } : undefined);
  }
  /** Finds the same native column and stored value that the opaque renderer displays. */
  pick(x: number, y: number): { hit: CellHit; tile: GeoZarrCollectionTile } | undefined {
    if (!this.volumeVisible) {
      return undefined;
    }
    const viewport = this.viewport();
    if (!viewport) {
      return undefined;
    }
    const ray = getCellPickingRay(viewport, [x, y]);
    if (!ray) {
      return undefined;
    }
    const nearest = pickCellCollection(
      this.source?.getTiles() ?? [],
      ray,
      EXAGGERATION,
      this.visibleBins,
      this.clipBounds,
    );
    return nearest ? { hit: nearest.hit, tile: nearest.item } : undefined;
  }
  private viewport(): Viewport | undefined {
    return this.deck.isInitialized ? this.deck.getViewports()[0] : undefined;
  }
  /** Selects nearby visible intervals without widening their lines or relying on an exact GPU hit. */
  private pickBorehole(x: number, y: number, radius: number): BoreholeLog | undefined {
    const viewport = this.viewport();
    if (!viewport || !this.boreholes.size) {
      return undefined;
    }
    const matrix = new Matrix4(viewport.viewProjectionMatrix);
    const candidates: { borehole: BoreholeLog; point: ScreenPoint; distanceSquared: number }[] = [];
    for (const borehole of this.boreholes.values()) {
      const position = (depth: number): [number, number, number] => [
        borehole.longitude,
        borehole.latitude,
        displayElevation(borehole.groundElevation - depth, borehole.groundElevation, EXAGGERATION),
      ];
      for (const interval of borehole.intervals) {
        const segment = projectContextSegment(
          position(interval.top),
          position(interval.bottom),
          matrix,
          viewport,
        );
        if (!segment) {
          continue;
        }
        const [a, b] = segment;
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const lengthSquared = dx * dx + dy * dy;
        const fraction = lengthSquared
          ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / lengthSquared))
          : a[2] <= b[2]
            ? 0
            : 1;
        const point: ScreenPoint = [
          a[0] + fraction * dx,
          a[1] + fraction * dy,
          a[2] + fraction * (b[2] - a[2]),
        ];
        const distanceSquared = (x - point[0]) ** 2 + (y - point[1]) ** 2;
        if (distanceSquared <= radius * radius) {
          candidates.push({ borehole, point, distanceSquared });
        }
      }
    }
    candidates.sort((a, b) => a.distanceSquared - b.distanceSquared || a.point[2] - b.point[2]);
    for (const { borehole, point } of candidates) {
      const hit = this.pick(point[0], point[1])?.hit;
      const opaque = hit ? matrix.transformAsPoint(hit.position) : undefined;
      if (!opaque || point[2] <= (opaque[2] ?? 0) + 1e-7) {
        return borehole;
      }
    }
    return undefined;
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
  /** Exposes source diagnostics with the same physical clipping as the displayed cells. */
  getReader(): Pick<GeoZarrCollection, 'getDebugState'> | undefined {
    return this.source ? this.inspectorReader : undefined;
  }
  /** Maps the inspector's normalized cube into its already displayed common XYZ bounds. */
  getVolumeToCommon(geometry: VoxelGeometry): readonly number[] {
    return new Matrix4()
      .translate(geometry.origin ?? [0, 0, 0])
      .scale((geometry.spacing ?? [1, 1, 1]).map((v, i) => v * (geometry.dimensions[i] ?? 1)));
  }
  /** Projects the inspector bounds through the current camera without applying another height stretch. */
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
  /** Subscribes to view or source changes; the returned function removes the listener. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Finalizes the Deck layers and their readers, then releases the basemap and UI subscriptions. */
  dispose(): void {
    this.disposed = true;
    this.lifetime.abort();
    this.listeners.clear();
    this.boreholes.clear();
    this.deck.finalize();
    this.source = undefined;
    this.map.remove();
  }
}
