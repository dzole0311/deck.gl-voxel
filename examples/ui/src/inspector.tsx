import type { ZarrDebugState } from 'deck.gl-voxel-zarr';
import { useEffect, useRef, useState } from 'react';
import { CHUNK_COLORS, drawChunkOutlines, drawChunkOverview } from './chunk-drawing.js';
import { Badge } from './components/badge.js';
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
    ? `${state.frameIndex}:${state.cacheBytes}:${state.reusedView}:${state.chunks.map((chunk) => `${chunk.id}:${chunk.status}:${chunk.priority.toFixed(3)}`).join(';')}`
    : '';
}

/** Shared example inspector, positioned at the top right using the default light shadcn theme. */
export function ChunkInspector({ view, onClose, onReload, slowRequests }: ChunkInspectorProps) {
  const [state, setState] = useState<ZarrDebugState>();
  const [outlines, setOutlines] = useState(true);
  const [outside, setOutside] = useState(true);
  const [frozen, setFrozen] = useState(false);
  const [selected, setSelected] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const overview = useRef<HTMLCanvasElement>(null);
  const latest = useRef<ZarrDebugState>(undefined);
  const previous = useRef('');
  useEffect(() => {
    let drawRequest: number | undefined;
    const draw = (): void => {
      drawRequest = undefined;
      const snapshot = latest.current;
      const matrix = snapshot ? view.getVolumeToClip(snapshot.geometry) : undefined;
      if (canvas.current) {
        drawChunkOutlines(canvas.current, snapshot, matrix, view.getViewport(), {
          outlines,
          outside,
          selected,
        });
      }
      if (overview.current) {
        drawChunkOverview(overview.current, snapshot, matrix);
      }
    };
    const schedule = (): void => {
      drawRequest ??= requestAnimationFrame(draw);
    };
    const poll = (): void => {
      if (!frozen) {
        latest.current = view.getReader()?.getDebugState?.();
        const next = signature(latest.current);
        if (next !== previous.current) {
          previous.current = next;
          setState(latest.current);
        }
      }
      schedule();
    };
    poll();
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
  }, [view, outlines, outside, frozen, selected]);
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
        className="fixed top-4 right-4 z-30 max-h-[calc(100dvh-2rem)] w-80 max-w-[calc(100vw-2rem)] gap-4 overflow-y-auto py-4"
        role="complementary"
        aria-labelledby="inspector-title"
      >
        <CardHeader className="flex flex-row items-center justify-between gap-2 px-4">
          <CardTitle>
            <h2 id="inspector-title">Chunk inspector</h2>
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close chunk inspector">
            Close
          </Button>
        </CardHeader>
        <CardContent className="grid gap-4 px-4 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <Label>
              <Checkbox
                id="debug-outlines"
                checked={outlines}
                onCheckedChange={(value) => setOutlines(value === true)}
              />
              Outlines
            </Label>
            <Label>
              <Checkbox
                id="debug-outside"
                checked={outside}
                onCheckedChange={(value) => setOutside(value === true)}
              />
              Outside view
            </Label>
            <Label>
              <Checkbox
                id="debug-freeze"
                checked={frozen}
                onCheckedChange={(value) => setFrozen(value === true)}
              />
              Freeze inspector
            </Label>
            {slowRequests ? (
              <Label>
                <Checkbox
                  id="debug-slow"
                  checked={slowRequests.enabled}
                  onCheckedChange={(value) => slowRequests.onChange(value === true)}
                />
                Slow requests
              </Label>
            ) : null}
          </div>
          {onReload ? (
            <Button id="debug-reload" variant="outline" onClick={onReload}>
              Clear cache and reload
            </Button>
          ) : null}
          <Separator />
          {state ? (
            <>
              <dl id="debug-counters" className="grid grid-cols-2 gap-x-3 gap-y-2 tabular-nums">
                <dt className="text-muted-foreground">Selected</dt>
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
              <div className="flex flex-wrap gap-1.5">
                {(
                  ['queued', 'loading', 'ready', 'cached', 'outside', 'cancelled', 'error'] as const
                ).map((status) => (
                  <Badge key={status} variant="outline" style={{ color: CHUNK_COLORS[status] }}>
                    {status === 'cached' ? 'reused' : status}
                  </Badge>
                ))}
              </div>
              <figure className="space-y-1">
                <canvas
                  ref={overview}
                  id="chunk-overview"
                  width={560}
                  height={250}
                  role="img"
                  aria-label="Chunk footprints and camera view at the grid's middle height"
                  className="w-full rounded-md border"
                />
                <figcaption className="text-xs text-muted-foreground">
                  Camera view at mid-height
                </figcaption>
              </figure>
              <div className="grid gap-2 [&_[data-slot=native-select-wrapper]]:w-full">
                <Label htmlFor="debug-chunk">Chunk</Label>
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
              </div>
              {selectedChunk ? (
                <p id="debug-details" className="text-xs text-muted-foreground">
                  {selectedChunk.status}
                  {selectedChunk.selected ? `, priority ${selectedChunk.priority.toFixed(2)}` : ''}
                </p>
              ) : null}
              {state.reusedView ? (
                <p className="text-xs text-muted-foreground">Reused assembled view</p>
              ) : null}
            </>
          ) : (
            <p role="status" className="text-muted-foreground">
              {view.getReader() && !view.getReader()?.getDebugState
                ? 'This reader does not expose chunk diagnostics'
                : 'Waiting for chunks'}
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
