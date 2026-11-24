import { Badge } from '@deck.gl-voxel/example-ui/components/badge';
import { Button } from '@deck.gl-voxel/example-ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@deck.gl-voxel/example-ui/components/card';
import { Checkbox } from '@deck.gl-voxel/example-ui/components/checkbox';
import { Label } from '@deck.gl-voxel/example-ui/components/label';
import {
  NativeSelect,
  NativeSelectOption,
} from '@deck.gl-voxel/example-ui/components/native-select';
import { Separator } from '@deck.gl-voxel/example-ui/components/separator';
import { Slider } from '@deck.gl-voxel/example-ui/components/slider';
import { Spinner } from '@deck.gl-voxel/example-ui/components/spinner';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { type DatasetId, datasets } from './datasets.js';
import { ExampleViewer, type HoverSample } from './viewer.js';
import 'maplibre-gl/dist/maplibre-gl.css';
import '@deck.gl-voxel/example-ui/styles.css';
import './style.css';

const ChunkInspector = lazy(() =>
  import('@deck.gl-voxel/example-ui/inspector').then((module) => ({
    default: module.ChunkInspector,
  })),
);
const params = new URLSearchParams(location.search);
const requested = params.get('dataset');
const initialId: DatasetId =
  requested === 'milton' ||
  requested === 'helene' ||
  (import.meta.env.DEV && requested === 'chunks')
    ? requested
    : import.meta.env.DEV && params.get('debug') === '1'
      ? 'chunks'
      : 'helene';
const initial = datasets[initialId];
const hourFormat = new Intl.DateTimeFormat('en', {
  timeZone: 'UTC',
  timeZoneName: 'short',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** React controls own example state; the viewer owns the map, reader and GPU lifetimes. */
function App() {
  const map = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState<ExampleViewer>();
  const [datasetId, setDatasetId] = useState<DatasetId>(initialId);
  const [frameIndex, setFrameIndex] = useState(initial.initialFrame);
  const [draftFrame, setDraftFrame] = useState<number>();
  const [frameCount, setFrameCount] = useState(0);
  const [ready, setReady] = useState(false),
    [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error>();
  const [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(1);
  const [renderMode, setRenderMode] = useState<'volume' | 'isosurface'>('volume');
  const [isovalue, setIsovalue] = useState((initial.valueRange[0] + initial.valueRange[1]) / 2);
  const [density, setDensity] = useState(initial.density),
    [exaggeration, setExaggeration] = useState(initial.verticalExaggeration);
  const [revision, setRevision] = useState(0);
  const [inspector, setInspector] = useState(params.get('debug') === '1');
  const [slowRequests, setSlowRequests] = useState(params.get('slow') === '1');
  const [hover, setHover] = useState<HoverSample>();
  const dataset = datasets[datasetId];
  const callbacks = useMemo(
    () => ({
      onSource: (count: number) => {
        setFrameCount(count);
        setFrameIndex((index) => Math.min(index, count - 1));
      },
      onLoad: () => setReady(true),
      onLoading: (busy: boolean) => {
        setLoading(busy);
        if (busy) {
          setError(undefined);
        }
      },
      onError: (failure: Error) => {
        setError(failure);
        setPlaying(false);
        setLoading(false);
      },
      onHover: setHover,
    }),
    [],
  );
  useEffect(() => {
    const mapElement = map.current,
      volumeCanvas = canvas.current;
    if (!mapElement || !volumeCanvas) {
      return;
    }
    if (!('gpu' in navigator)) {
      setError(new Error('Open this example in a browser with WebGPU enabled'));
      setLoading(false);
      return;
    }
    let instance: ExampleViewer;
    try {
      instance = new ExampleViewer(mapElement, volumeCanvas, callbacks);
    } catch (failure) {
      setError(failure instanceof Error ? failure : new Error(String(failure)));
      setLoading(false);
      return;
    }
    setView(instance);
    return () => instance.dispose();
  }, [callbacks]);
  const settings = useMemo(
    () => ({
      dataset,
      frameIndex,
      renderMode,
      isovalue,
      density,
      exaggeration,
      playing,
      revision,
      slowRequests,
    }),
    [
      dataset,
      frameIndex,
      renderMode,
      isovalue,
      density,
      exaggeration,
      playing,
      revision,
      slowRequests,
    ],
  );
  useEffect(() => {
    view?.update(settings);
  }, [view, settings]);
  useEffect(() => {
    if (!playing || loading || frameCount < 2) {
      return;
    }
    const timer = setTimeout(() => {
      setLoading(true);
      setFrameIndex((frameIndex + 1) % frameCount);
    }, 700 / speed);
    return () => clearTimeout(timer);
  }, [playing, loading, frameCount, speed, frameIndex]);
  function selectDataset(id: DatasetId): void {
    const next = datasets[id];
    setPlaying(false);
    setReady(false);
    setLoading(true);
    setError(undefined);
    setHover(undefined);
    setDraftFrame(undefined);
    setFrameCount(0);
    setDatasetId(id);
    setFrameIndex(next.initialFrame);
    setDensity(next.density);
    setExaggeration(next.verticalExaggeration);
    setIsovalue((next.valueRange[0] + next.valueRange[1]) / 2);
  }
  function seek(index: number): void {
    setDraftFrame(undefined);
    if (index !== frameIndex) {
      setLoading(true);
      setFrameIndex(index);
    }
  }
  function reload(): void {
    setPlaying(false);
    setLoading(true);
    setError(undefined);
    setRevision((value) => value + 1);
  }
  function closeInspector(): void {
    setInspector(false);
    requestAnimationFrame(() => document.getElementById('show-inspector')?.focus());
  }
  const shownFrame = draftFrame ?? frameIndex;
  const time = hourFormat.format(dataset.firstTime + shownFrame * dataset.stepHours * 3_600_000);
  const sourceKey = `${datasetId}-${revision}`;
  return (
    <main>
      <section ref={map} id="map" aria-label="Weather map" />
      <canvas ref={canvas} id="volume" aria-label="Weather volume" />
      <Card
        id="controls"
        data-state={loading ? 'loading' : 'ready'}
        className={`fixed top-4 left-4 z-20 max-h-[calc(100dvh-2rem)] w-80 max-w-[calc(100vw-2rem)] gap-4 overflow-y-auto py-4 ${inspector ? 'max-sm:hidden' : ''}`}
        role="region"
        aria-labelledby="title"
      >
        <CardHeader className="gap-1 px-4">
          <CardTitle>
            <h1 id="title">Weather volumes</h1>
          </CardTitle>
          <CardDescription id="description">{dataset.description}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 px-4">
          <div className="grid gap-2 [&_[data-slot=native-select-wrapper]]:w-full">
            <Label htmlFor="dataset">Dataset</Label>
            <NativeSelect
              id="dataset"
              value={datasetId}
              onChange={(event) => {
                const id = event.target.value;
                if (
                  id === 'helene' ||
                  id === 'milton' ||
                  (import.meta.env.DEV && id === 'chunks')
                ) {
                  selectDataset(id);
                }
              }}
            >
              <NativeSelectOption value="helene">Helene cloud cover</NativeSelectOption>
              <NativeSelectOption value="milton">US wind (Milton forecast)</NativeSelectOption>
              {import.meta.env.DEV ? (
                <NativeSelectOption value="chunks">Chunk demo</NativeSelectOption>
              ) : null}
            </NativeSelect>
          </div>
          <Separator />
          <div className="grid gap-2 [&_[data-slot=native-select-wrapper]]:w-full">
            <Label htmlFor="render-mode">Render mode</Label>
            <NativeSelect
              id="render-mode"
              value={renderMode}
              onChange={(event) =>
                setRenderMode(event.target.value === 'isosurface' ? 'isosurface' : 'volume')
              }
            >
              <NativeSelectOption value="volume">Volume</NativeSelectOption>
              <NativeSelectOption value="isosurface">Isosurface</NativeSelectOption>
            </NativeSelect>
          </div>
          {renderMode === 'isosurface' ? (
            <div id="isovalue-control" className="grid gap-3">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="isovalue">Isovalue</Label>
                <output id="isovalue-value" className="text-sm tabular-nums">
                  {dataset.formatValue(isovalue)}
                </output>
              </div>
              <Slider
                id="isovalue"
                aria-label="Isovalue"
                value={[isovalue]}
                min={dataset.valueRange[0]}
                max={dataset.valueRange[1]}
                step={dataset.isovalueStep}
                onValueChange={(values) => {
                  const value = values[0];
                  if (value !== undefined) {
                    setIsovalue(value);
                  }
                }}
              />
            </div>
          ) : null}
          <div className="grid gap-3">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="hour">Time</Label>
              <output id="time" className="text-xs tabular-nums">
                {time}
              </output>
            </div>
            <Slider
              id="hour"
              aria-label="Time"
              aria-valuetext={time}
              value={[Math.min(shownFrame, Math.max(0, frameCount - 1))]}
              min={0}
              max={Math.max(0, frameCount - 1)}
              step={1}
              disabled={!ready}
              onValueChange={(values) => {
                const value = values[0];
                if (value !== undefined) {
                  setPlaying(false);
                  setDraftFrame(value);
                }
              }}
              onValueCommit={(values) => {
                const value = values[0];
                if (value !== undefined) {
                  seek(value);
                }
              }}
            />
            <div className="flex items-center gap-2">
              <Button
                id="play"
                size="sm"
                disabled={!ready || frameCount < 2}
                onClick={() => setPlaying((value) => !value)}
              >
                {playing ? 'Pause' : 'Play'}
              </Button>
              <div className="ml-auto flex items-center gap-2">
                <Label htmlFor="speed">Speed</Label>
                <NativeSelect
                  id="speed"
                  size="sm"
                  value={speed}
                  onChange={(event) => setSpeed(Number(event.target.value))}
                >
                  <NativeSelectOption value="0.5">0.5×</NativeSelectOption>
                  <NativeSelectOption value="1">1×</NativeSelectOption>
                  <NativeSelectOption value="2">2×</NativeSelectOption>
                </NativeSelect>
              </div>
            </div>
          </div>
          <div className="grid gap-3">
            <div className="flex items-center justify-between">
              <Label htmlFor="density">Density</Label>
              <output id="density-value" className="text-sm tabular-nums">
                {density.toFixed(1)}×
              </output>
            </div>
            <Slider
              id="density"
              aria-label="Density"
              min={0}
              max={4}
              step={0.1}
              value={[density]}
              disabled={renderMode === 'isosurface'}
              onValueChange={(values) => {
                const value = values[0];
                if (value !== undefined) {
                  setDensity(value);
                }
              }}
            />
          </div>
          <div className="grid gap-3">
            <div className="flex items-center justify-between">
              <Label htmlFor="exaggeration">Exaggeration</Label>
              <output id="exaggeration-value" className="text-sm tabular-nums">
                {exaggeration}×
              </output>
            </div>
            <Slider
              id="exaggeration"
              aria-label="Exaggeration"
              min={1}
              max={100}
              step={1}
              value={[exaggeration]}
              onValueChange={(values) => {
                const value = values[0];
                if (value !== undefined) {
                  setExaggeration(value);
                }
              }}
            />
          </div>
          <Separator />
          <Label>
            <Checkbox
              id="show-inspector"
              checked={inspector}
              onCheckedChange={(value) => setInspector(value === true)}
            />
            Chunk inspector
          </Label>
          <p
            id="status"
            role="status"
            className={`flex min-h-4 items-center gap-2 text-xs ${error ? 'text-destructive' : 'text-muted-foreground'}`}
          >
            {loading ? <Spinner aria-hidden="true" /> : null}
            {error?.message ?? (loading ? 'Loading…' : '')}
          </p>
        </CardContent>
        <CardFooter className="block space-y-1 px-4 text-xs text-muted-foreground">
          <p id="credit">{dataset.credit}</p>
          <Button variant="link" size="sm" asChild className="h-auto p-0 text-xs">
            <a id="source" href={dataset.source}>
              Dataset source
            </a>
          </Button>
        </CardFooter>
      </Card>
      {inspector && view ? (
        <Suspense
          fallback={
            <Badge className="fixed top-4 right-4 z-30" variant="secondary">
              Loading inspector…
            </Badge>
          }
        >
          <ChunkInspector
            key={sourceKey}
            view={view}
            onClose={closeInspector}
            onReload={reload}
            {...(typeof dataset.volumeSource === 'string'
              ? {
                  slowRequests: {
                    enabled: slowRequests,
                    onChange: (enabled: boolean) => {
                      setSlowRequests(enabled);
                      reload();
                    },
                  },
                }
              : {})}
          />
        </Suspense>
      ) : null}
      <div className="fixed right-4 bottom-8 z-20 grid gap-1">
        <Button variant="outline" size="icon" aria-label="Zoom in" onClick={() => view?.zoom(1)}>
          +
        </Button>
        <Button variant="outline" size="icon" aria-label="Zoom out" onClick={() => view?.zoom(-1)}>
          −
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label="Reset bearing"
          onClick={() => view?.resetBearing()}
        >
          N
        </Button>
      </div>
      {hover ? (
        <Card
          id="tooltip"
          role="tooltip"
          className="pointer-events-none fixed z-40 max-w-64 gap-0 px-3 py-2 text-xs"
          style={{
            left: Math.max(8, Math.min(hover.x + 12, window.innerWidth - 272)),
            top: Math.max(8, Math.min(hover.y + 12, window.innerHeight - 70)),
          }}
        >
          {hover.text}
        </Card>
      ) : null}
    </main>
  );
}

const element = document.getElementById('root');
if (!element) {
  throw new Error('Missing example root');
}
const root = createRoot(element);
root.render(<App />);
const pagehide = (event: PageTransitionEvent): void => {
  if (!event.persisted) {
    root.unmount();
  }
};
window.addEventListener('pagehide', pagehide);
import.meta.hot?.dispose(() => {
  window.removeEventListener('pagehide', pagehide);
  root.unmount();
});
