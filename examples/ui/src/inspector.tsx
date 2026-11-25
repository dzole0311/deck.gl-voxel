import type { ZarrDebugState } from 'deck.gl-voxel-zarr';
import { useEffect, useRef, useState } from 'react';
import { CAMERA_COLORS, drawCameraOverview } from './camera-drawing.js';
import { CHUNK_COLORS, drawChunkOutlines } from './chunk-drawing.js';
import { Button } from './components/button.js';
import { Card, CardContent, CardHeader, CardTitle } from './components/card.js';
import { Checkbox } from './components/checkbox.js';
import { Label } from './components/label.js';
import { NativeSelect, NativeSelectOption } from './components/native-select.js';
import { Separator } from './components/separator.js';
import type { ChunkInspectorView } from './types.js';

/** Mount to inspect an example. Unmounting releases polling, subscriptions and the outline canvas. */
export interface ChunkInspectorProps {
  readonly view: ChunkInspectorView;
  readonly onClose: () => void;
  readonly onReload?: () => void;
  readonly slowRequests?: {
    readonly enabled: boolean;
    readonly onChange: (enabled: boolean) => void;
  };
}

function signature(state: ZarrDebugState | undefined): string {
  return state
    ? `${state.frameIndex}:${state.volumeToClip.join(',')}:${state.cacheBytes}:${state.maxCacheBytes}:${state.reusedView}:${state.chunks.map((chunk) => `${chunk.id}:${chunk.status}:${chunk.priority.toFixed(3)}`).join(';')}`
    : '';
}

/** Shared example inspector, positioned at the top right using the default light shadcn theme. */
export function ChunkInspector({ view, onClose, onReload, slowRequests }: ChunkInspectorProps) {
  const [state, setState] = useState<ZarrDebugState>();
  const [unsupportedReader, setUnsupportedReader] = useState(false);
  const [selectionPending, setSelectionPending] = useState(false);
  const [outlines, setOutlines] = useState(true);
  const [frozen, setFrozen] = useState(false);
  const [selected, setSelected] = useState('');
  const [cameraMode, setCameraMode] = useState<'2d' | '3d'>('3d');
  const canvas = useRef<HTMLCanvasElement>(null);
  const overview = useRef<HTMLCanvasElement>(null);
  const latest = useRef<ZarrDebugState>(undefined);
  const previous = useRef('');
  useEffect(() => {
    let drawRequest: number | undefined;
    const draw = (): void => {
      drawRequest = undefined;
      const snapshot = latest.current;
      const selection = snapshot?.chunks.some((chunk) => chunk.id === selected) ? selected : '';
      const matrix = snapshot ? view.getVolumeToClip(snapshot.geometry) : undefined;
      setSelectionPending(
        Boolean(snapshot && matrix?.some((value, index) => value !== snapshot.volumeToClip[index])),
      );
      if (canvas.current) {
        drawChunkOutlines(canvas.current, snapshot, matrix, view.getViewport(), {
          outlines,
          selected: selection,
        });
      }
      if (overview.current) {
        drawCameraOverview(
          overview.current,
          snapshot,
          matrix,
          snapshot ? view.getVolumeToCommon(snapshot.geometry) : undefined,
          cameraMode,
          selection,
        );
      }
    };
    const schedule = (): void => {
      drawRequest ??= requestAnimationFrame(draw);
    };
    const poll = (): void => {
      if (!frozen) {
        const reader = view.getReader();
        const unsupported = Boolean(reader && !reader.getDebugState);
        latest.current = reader?.getDebugState?.();
        if (selected && !latest.current?.chunks.some((chunk) => chunk.id === selected)) {
          setSelected('');
        }
        const next = `${unsupported}:${signature(latest.current)}`;
        if (next !== previous.current) {
          previous.current = next;
          setState(latest.current);
          setUnsupportedReader(unsupported);
          schedule();
        }
      }
    };
    poll();
    schedule();
    const timer = setInterval(poll, 100);
    const unsubscribe = view.subscribe(schedule);
    window.addEventListener('resize', schedule);
    return () => {
      clearInterval(timer);
      unsubscribe();
      window.removeEventListener('resize', schedule);
      if (drawRequest !== undefined) {
        cancelAnimationFrame(drawRequest);
      }
    };
  }, [view, outlines, frozen, selected, cameraMode]);
  const chunks = state?.chunks ?? [];
  const selectedChunk = chunks.find((chunk) => chunk.id === selected);
  const count = (status: string) => chunks.filter((chunk) => chunk.status === status).length;
  const selectedCount = chunks.filter((chunk) => chunk.selected).length;
  return (
    <>
      <canvas
        ref={canvas}
        id="chunk-outlines"
        aria-hidden="true"
        tabIndex={-1}
        className="pointer-events-none fixed inset-0 z-10 h-full w-full"
      />
      <Card
        id="chunk-inspector"
        data-selected={selectedCount}
        data-loading={count('loading')}
        data-queued={count('queued')}
        data-cached={count('cached')}
        className="fixed top-4 right-4 z-30 max-h-[calc(100dvh-2rem)] w-80 max-w-[calc(100vw-2rem)] gap-3 overflow-y-auto py-3"
        role="complementary"
        aria-labelledby="inspector-title"
      >
        <CardHeader className="flex flex-row items-center justify-between gap-2 border-b px-3 [.border-b]:pb-3">
          <CardTitle className="text-sm">
            <h2 id="inspector-title">Chunk inspector</h2>
          </CardTitle>
          <Button variant="ghost" size="xs" onClick={onClose} aria-label="Close chunk inspector">
            Close
          </Button>
        </CardHeader>
        <CardContent className="grid gap-3 px-3 text-sm">
          <figure className="grid gap-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-medium">Camera</h3>
              <fieldset aria-label="Camera overview" className="inline-flex border">
                {(['2d', '3d'] as const).map((mode) => (
                  <Button
                    key={mode}
                    variant={cameraMode === mode ? 'secondary' : 'ghost'}
                    size="xs"
                    className="rounded-none"
                    aria-label={`${mode.toUpperCase()} camera view`}
                    aria-pressed={cameraMode === mode}
                    onClick={() => setCameraMode(mode)}
                  >
                    {mode.toUpperCase()}
                  </Button>
                ))}
              </fieldset>
            </div>
            <canvas
              ref={overview}
              id="chunk-overview"
              width={640}
              height={480}
              role="img"
              aria-label={
                cameraMode === '3d'
                  ? '3D view of the camera and the volume entry and exit surfaces'
                  : 'Top view of the camera and the volume extent inside its view'
              }
              className="aspect-[4/3] w-full bg-neutral-50"
            />
            <figcaption className="grid gap-2 text-xs text-muted-foreground">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="w-10 shrink-0 font-medium text-foreground">View</span>
                {cameraMode === '3d' ? (
                  (['entry', 'exit'] as const).map((crossing) => (
                    <span key={crossing} className="inline-flex items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className="size-2 border"
                        style={{
                          borderColor: CAMERA_COLORS[crossing],
                          backgroundColor: `${CAMERA_COLORS[crossing]}30`,
                        }}
                      />
                      {crossing === 'entry' ? 'Entry' : 'Exit'}
                    </span>
                  ))
                ) : (
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="size-2 border"
                      style={{
                        borderColor: CAMERA_COLORS.entry,
                        backgroundColor: `${CAMERA_COLORS.entry}18`,
                      }}
                    />
                    In view
                  </span>
                )}
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden="true" className="size-2 border border-neutral-500" />
                  Volume
                </span>
              </div>
              <div className="flex items-start gap-3">
                <span className="w-10 shrink-0 font-medium text-foreground">Chunks</span>
                <ul className="flex flex-wrap gap-x-3 gap-y-1" aria-label="Chunk status key">
                  {(
                    [
                      'queued',
                      'loading',
                      'ready',
                      'cached',
                      'outside',
                      'cancelled',
                      'error',
                    ] as const
                  )
                    .filter(
                      (status) =>
                        (status !== 'cancelled' && status !== 'error') || count(status) > 0,
                    )
                    .map((status) => (
                      <li key={status} className="inline-flex items-center gap-1.5">
                        <span
                          aria-hidden="true"
                          className="size-2.5 shrink-0"
                          style={{ backgroundColor: CHUNK_COLORS[status] }}
                        />
                        {status === 'cached' ? 'reused' : status}
                      </li>
                    ))}
                </ul>
              </div>
            </figcaption>
          </figure>
          <Separator />
          <div className="flex h-4 items-center justify-between gap-2 text-xs">
            <h3 className="font-medium">Data</h3>
            <p role="status" className="min-w-0 truncate leading-4 text-muted-foreground">
              {state && frozen
                ? 'Chunk selection frozen'
                : state && selectionPending
                  ? 'Updating chunk selection…'
                  : state?.reusedView
                    ? 'Reused assembled view'
                    : ''}
            </p>
          </div>
          {state ? (
            <dl
              id="debug-counters"
              className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs tabular-nums"
            >
              <dt className="text-muted-foreground">Selected chunks</dt>
              <dd className="text-right">
                {selectedCount} / {chunks.length}
              </dd>
              <dt className="text-muted-foreground">Loading / queued</dt>
              <dd className="text-right">
                {count('loading')} / {count('queued')}
              </dd>
              <dt className="text-muted-foreground">Ready / reused</dt>
              <dd className="text-right">
                {count('ready')} / {count('cached')}
              </dd>
              <dt className="text-muted-foreground">CPU cache</dt>
              <dd className="text-right">
                {(state.cacheBytes / 1048576).toFixed(1)} /{' '}
                {(state.maxCacheBytes / 1048576).toFixed(0)} MB
              </dd>
            </dl>
          ) : (
            <p role="status" className="text-xs text-muted-foreground">
              {unsupportedReader
                ? 'This reader does not expose chunk diagnostics'
                : 'Waiting for chunks'}
            </p>
          )}
          <Separator />
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            <Label className="text-xs">
              <Checkbox
                id="debug-outlines"
                checked={outlines}
                onCheckedChange={(value) => setOutlines(value === true)}
              />
              Outlines
            </Label>
            <Label className="text-xs">
              <Checkbox
                id="debug-freeze"
                checked={frozen}
                onCheckedChange={(value) => setFrozen(value === true)}
              />
              Freeze inspector
            </Label>
            {slowRequests ? (
              <Label className="text-xs">
                <Checkbox
                  id="debug-slow"
                  checked={slowRequests.enabled}
                  onCheckedChange={(value) => slowRequests.onChange(value === true)}
                />
                Slow requests
              </Label>
            ) : null}
          </div>
          {state ? (
            <div className="grid gap-2 [&_[data-slot=native-select-wrapper]]:w-full">
              <Label htmlFor="debug-chunk" className="text-xs">
                Chunk
              </Label>
              <NativeSelect
                id="debug-chunk"
                value={selectedChunk ? selected : ''}
                onChange={(event) => setSelected(event.target.value)}
              >
                <NativeSelectOption value="">All chunks</NativeSelectOption>
                {chunks.map((chunk) => (
                  <NativeSelectOption key={chunk.id} value={chunk.id}>
                    {chunk.id}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              {selectedChunk ? (
                <p id="debug-details" className="text-xs text-muted-foreground">
                  {selectedChunk.status}
                  {selectedChunk.selected ? `, priority ${selectedChunk.priority.toFixed(2)}` : ''}
                </p>
              ) : null}
            </div>
          ) : null}
          {onReload ? (
            <Button
              id="debug-reload"
              variant="outline"
              size="sm"
              className="shadow-none"
              onClick={onReload}
            >
              Clear cache and reload
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}
