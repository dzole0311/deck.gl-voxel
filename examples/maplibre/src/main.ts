import { Deck, MapView, type MapViewState } from '@deck.gl/core';
import { webgpuAdapter } from '@luma.gl/webgpu';
import { Matrix4 } from '@math.gl/core';
import type { VoxelData } from 'deck.gl-voxel';
import { ZarrVoxelLayer } from 'deck.gl-voxel-zarr';
import { Map as MapLibreMap, NavigationControl, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { datasets } from './datasets.js';
import { pickVolumeSample } from './volume-hover.js';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';

const HOUR_MS = 3_600_000;
const REQUEST_TIMEOUT_MS = 20_000;
const PLAYBACK_DELAY_MS = 700;
const FRAME_CACHE_BYTES = 128 * 1024 * 1024;
const STATUS_TEXT = { ready: '', loading: 'Loading…', buffering: 'Buffering…' };
const MAP_ANGLE = { pitch: 48, bearing: -12 };
const hourFormat = new Intl.DateTimeFormat('en', {
  timeZone: 'UTC',
  timeZoneName: 'short',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * Copies the MapLibre camera into deck.gl's flat map view.
 * @param map - MapLibre map that holds the current camera.
 * @returns The camera in deck.gl's MapView format.
 */
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

/**
 * Looks up a required element and checks its DOM type.
 * @param id - Element ID in index.html.
 * @param type - Expected browser element constructor.
 * @returns The matching DOM element.
 * @throws {Error} If the element is missing or has the wrong type.
 */
function getElement<T extends HTMLElement>(id: string, type: { new (): T }): T {
  const element = document.getElementById(id);

  if (!(element instanceof type)) {
    throw new Error(`Missing or invalid element: ${id}`);
  }

  return element;
}

/**
 * Shows a slider's formatted value next to it and to screen readers.
 * @param input - Slider with the numeric value.
 * @param output - Visible value next to the slider.
 * @param label - Formatted value with units when applicable.
 */
function showSliderValue(input: HTMLInputElement, output: HTMLOutputElement, label: string): void {
  output.value = label;
  input.setAttribute('aria-valuetext', label);
}

/**
 * Starts the basemap, WebGPU overlay, and dataset and time controls.
 * @throws {Error} If WebGPU is unavailable or a required control is missing.
 */
function start(): void {
  const canvas = getElement('volume', HTMLCanvasElement);
  const datasetPicker = getElement('dataset', HTMLSelectElement);
  const modePicker = getElement('render-mode', HTMLSelectElement);
  const isovalueControl = getElement('isovalue-control', HTMLDivElement);
  const isovalue = getElement('isovalue', HTMLInputElement);
  const isovalueValue = getElement('isovalue-value', HTMLOutputElement);
  const description = getElement('description', HTMLParagraphElement);
  const credit = getElement('credit', HTMLSpanElement);
  const source = getElement('source', HTMLAnchorElement);
  const slider = getElement('hour', HTMLInputElement);
  const play = getElement('play', HTMLButtonElement);
  const speed = getElement('speed', HTMLSelectElement);
  const density = getElement('density', HTMLInputElement);
  const densityValue = getElement('density-value', HTMLOutputElement);
  const exaggeration = getElement('exaggeration', HTMLInputElement);
  const exaggerationValue = getElement('exaggeration-value', HTMLOutputElement);
  const time = getElement('time', HTMLOutputElement);
  const tooltip = getElement('tooltip', HTMLDivElement);

  if (!('gpu' in navigator)) {
    throw new Error('Open this example in a browser with WebGPU enabled.');
  }

  setWorkerUrl(workerUrl);

  const lifetime = new AbortController();
  const listenerOptions = { signal: lifetime.signal };
  let dataset = datasets.helene;
  const map = new MapLibreMap({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/positron',
    center: dataset.center,
    zoom: dataset.zoom,
    ...MAP_ANGLE,
    renderWorldCopies: false,
    dragRotate: { around: 'center', movement: 'linear' },
  });

  map.addControl(new NavigationControl(), 'top-right');

  const deck = new Deck({
    canvas,
    views: new MapView({ repeat: false }),
    viewState: getViewState(map),
    controller: false,
    useDevicePixels: 1,
    deviceProps: {
      type: 'webgpu',
      adapters: [webgpuAdapter],
      createCanvasContext: { alphaMode: 'premultiplied' },
      onError: reportError,
    },
    onError: reportError,
  });
  let modelMatrix = new Matrix4();
  let frameCount = 0;
  let loading = true;
  let loadError: Error | undefined;
  let frame: VoxelData | undefined;
  let completeFrame: VoxelData | undefined;
  let playing = false;
  let playbackTimer: number | undefined;

  /**
   * Updates playback state and cancels any scheduled advance when paused.
   * @param enabled - Whether frames should advance automatically.
   */
  function setPlaying(enabled: boolean): void {
    playing = enabled;
    play.textContent = enabled ? 'Pause' : 'Play';

    if (!enabled) {
      window.clearTimeout(playbackTimer);
    }
  }

  /** Dismisses the current sample readout. */
  function hideTooltip(): void {
    tooltip.hidden = true;
  }

  /** Synchronizes the two canvases when the map camera or viewport changes. */
  function syncCamera(): void {
    hideTooltip();
    deck.setProps({ viewState: getViewState(map) });
  }

  map.on('move', syncCamera);
  map.on('resize', syncCamera);
  map.on('mouseout', hideTooltip);
  map.on('mousedown', hideTooltip);
  map.on('mousemove', ({ point, originalEvent }) => {
    if (
      !frame ||
      modePicker.value === 'isosurface' ||
      !deck.isInitialized ||
      originalEvent.buttons ||
      map.isMoving()
    ) {
      hideTooltip();
      return;
    }

    const viewport = deck.getViewports()[0];

    if (!viewport) {
      return;
    }

    const sample = pickVolumeSample(
      frame,
      viewport,
      [point.x, point.y],
      modelMatrix,
      dataset.transferFunction,
      dataset.valueRange,
      density.valueAsNumber,
    );

    if (!sample) {
      hideTooltip();
      return;
    }

    tooltip.textContent = `${dataset.valueLabel} ${dataset.formatValue(sample.value)} - ${(sample.altitudeMeters / 1000).toFixed(1)} km altitude`;
    tooltip.hidden = false;
    tooltip.style.left = `${Math.max(8, Math.min(point.x + 12, window.innerWidth - tooltip.offsetWidth - 8))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(point.y + 12, window.innerHeight - tooltip.offsetHeight - 8))}px`;
  });
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape') {
        hideTooltip();
      }
    },
    listenerOptions,
  );

  window.addEventListener(
    'pagehide',
    (event) => {
      if (!event.persisted) {
        setPlaying(false);
        lifetime.abort();
        deck.finalize();
        map.remove();
      }
    },
    listenerOptions,
  );

  /**
   * Stretches the volume vertically. Rendering and hover use the same stretch.
   * @param multiplier - Height scale on screen. A value of 20 means twenty times taller.
   */
  function setExaggeration(multiplier: number): void {
    exaggeration.valueAsNumber = multiplier;
    showSliderValue(exaggeration, exaggerationValue, `${multiplier}×`);
    modelMatrix = new Matrix4().scale([1, 1, multiplier]);
  }

  /**
   * Updates the density control and its accessible readout.
   * @param multiplier - How quickly volume opacity builds up. Zero hides the volume.
   */
  function setDensity(multiplier: number): void {
    density.valueAsNumber = multiplier;
    showSliderValue(density, densityValue, `${multiplier.toFixed(1)}×`);
  }

  /** Shows the surface threshold in the current dataset's units. */
  function showIsovalue(): void {
    showSliderValue(isovalue, isovalueValue, dataset.formatValue(isovalue.valueAsNumber));
  }

  /** Shows the controls that apply to the selected render mode. */
  function syncRenderControls(): void {
    const isosurface = modePicker.value === 'isosurface';
    isovalueControl.hidden = !isosurface;
    density.disabled = isosurface;
  }

  /** Selects the source and resets the controls; the layer opens and loads it. */
  function loadSelectedDataset(): void {
    dataset = datasetPicker.value === 'milton' ? datasets.milton : datasets.helene;
    setPlaying(false);
    frame = undefined;
    completeFrame = undefined;
    frameCount = 0;
    loading = true;
    loadError = undefined;
    setExaggeration(dataset.verticalExaggeration);
    setDensity(dataset.density);
    const [min, max] = dataset.valueRange;
    isovalue.min = String(min);
    isovalue.max = String(max);
    isovalue.step = String(dataset.isovalueStep);
    isovalue.valueAsNumber = (min + max) / 2;
    showIsovalue();
    syncRenderControls();
    slider.disabled = true;
    play.disabled = true;
    slider.max = String(dataset.initialFrame);
    slider.valueAsNumber = dataset.initialFrame;
    description.textContent = dataset.description;
    credit.textContent = dataset.credit;
    source.href = dataset.source;
    showHour();
    setStatus('loading');
    map.jumpTo({ center: dataset.center, zoom: dataset.zoom, ...MAP_ANGLE });
    redraw();
  }

  /** Updates the visible and accessible label for the selected hour. */
  function showHour(): void {
    const label = hourFormat.format(
      dataset.firstTime + slider.valueAsNumber * dataset.stepHours * HOUR_MS,
    );

    showSliderValue(slider, time, label);
  }

  /**
   * Moves the time control and starts loading the requested hour.
   * @param index - Zero-based frame index in the dataset.
   */
  function selectHour(index: number): void {
    slider.value = String(index);
    showHour();
    redraw();
  }

  /** Advances only after the layer has loaded the current frame and its playback buffer. */
  function scheduleNextHour(): void {
    window.clearTimeout(playbackTimer);
    if (playing && frameCount > 1 && !loading) {
      playbackTimer = window.setTimeout(
        () => selectHour((slider.valueAsNumber + 1) % frameCount),
        PLAYBACK_DELAY_MS / Number(speed.value),
      );
    }
  }

  /** Applies the selected source, time and render settings to the adapter layer. */
  function redraw(): void {
    const selected = dataset;
    deck.setProps({
      layers: [
        new ZarrVoxelLayer({
          id: selected.id,
          source: selected.volumeSource,
          ...(selected.sourceOptions && { sourceOptions: selected.sourceOptions }),
          frameIndex: slider.valueAsNumber,
          preload: playing,
          maxCacheBytes: FRAME_CACHE_BYTES,
          requestTimeout: REQUEST_TIMEOUT_MS,
          modelMatrix,
          renderMode: modePicker.value === 'isosurface' ? 'isosurface' : 'volume',
          isovalue: isovalue.valueAsNumber,
          colorBy: selected.colorBy,
          valueRange: selected.valueRange,
          transferFunction: selected.transferFunction,
          opacityUnitDistance: Math.abs(frame?.spacing?.[2] ?? 1),
          density: density.valueAsNumber,
          showBounds: true,
          onSourceLoad: (reader) => {
            if (dataset !== selected) {
              return;
            }
            frameCount = reader.frameCount;
            slider.max = String(frameCount - 1);
            if (slider.valueAsNumber >= frameCount) {
              selectHour(frameCount - 1);
            }
          },
          onVolumeProgress: (volume) => {
            if (dataset === selected) {
              frame = volume;
              redraw();
            }
          },
          onVolumeLoad: (volume) => {
            if (dataset !== selected) {
              return;
            }
            frame = volume;
            completeFrame = volume;
            slider.disabled = false;
            play.disabled = frameCount < 2;
            redraw();
          },
          onLoadStateChange: (busy) => {
            if (dataset !== selected) {
              return;
            }
            loading = busy;
            if (busy) {
              loadError = undefined;
            }
            if (loadError) {
              reportError(loadError);
            } else {
              setStatus(busy ? (frame ? 'buffering' : 'loading') : 'ready');
            }
            scheduleNextHour();
          },
          onError: (error) => {
            if (dataset === selected) {
              setPlaying(false);
              frame = completeFrame ?? frame;
              loadError = error;
              redraw();
              reportError(error);
            }
            return true;
          },
        }),
      ],
    });
    hideTooltip();
  }

  play.addEventListener(
    'click',
    () => {
      setPlaying(!playing);

      redraw();
      scheduleNextHour();
    },
    listenerOptions,
  );
  slider.addEventListener(
    'input',
    () => {
      setPlaying(false);
      showHour();
    },
    listenerOptions,
  );
  slider.addEventListener('change', redraw, listenerOptions);
  speed.addEventListener('change', scheduleNextHour, listenerOptions);
  modePicker.addEventListener(
    'change',
    () => {
      syncRenderControls();
      redraw();
    },
    listenerOptions,
  );
  isovalue.addEventListener(
    'input',
    () => {
      showIsovalue();
      redraw();
    },
    listenerOptions,
  );
  density.addEventListener(
    'input',
    () => {
      setDensity(density.valueAsNumber);
      redraw();
    },
    listenerOptions,
  );
  exaggeration.addEventListener(
    'input',
    () => {
      setExaggeration(exaggeration.valueAsNumber);
      redraw();
    },
    listenerOptions,
  );

  datasetPicker.addEventListener('change', loadSelectedDataset, listenerOptions);

  loadSelectedDataset();
}

/**
 * Sets the panel's loading state and its visible status message.
 * @param state - Controls which loading placeholders to show.
 * @param message - Optional text that replaces the state's default message.
 */
function setStatus(state: keyof typeof STATUS_TEXT, message = STATUS_TEXT[state]): void {
  getElement('controls', HTMLElement).dataset.state = state;
  getElement('status', HTMLSpanElement).textContent = message;
}

/**
 * Shows a data or renderer failure in the controls.
 * @param error - Error from the browser, GPU device, or dataset reader.
 */
function reportError(error: unknown): void {
  setStatus('ready', error instanceof Error ? error.message : String(error));
}

try {
  start();
} catch (error) {
  reportError(error);
}
