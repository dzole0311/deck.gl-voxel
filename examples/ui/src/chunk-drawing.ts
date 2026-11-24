import { Matrix4 } from '@math.gl/core';
import type { ZarrDebugChunk, ZarrDebugState } from 'deck.gl-voxel-zarr';
import { BOX_EDGES } from './camera-geometry.js';
import { clearCanvas } from './canvas.js';

export const CHUNK_COLORS: Record<ZarrDebugChunk['status'], string> = {
  outside: '#737373',
  queued: '#a16207',
  loading: '#0369a1',
  ready: '#15803d',
  cached: '#7e22ce',
  cancelled: '#c2410c',
  error: '#b91c1c',
};

// Clip homogeneous segments before dividing by w, including boxes crossing the camera's near plane.
function segment(
  context: CanvasRenderingContext2D,
  a: readonly number[],
  b: readonly number[],
  width: number,
  height: number,
): void {
  let low = 0,
    high = 1;
  for (const axis of [0, 1, 2]) {
    for (const sign of [-1, 1]) {
      const first = (a[3] ?? 0) - sign * (a[axis] ?? 0);
      const last = (b[3] ?? 0) - sign * (b[axis] ?? 0);
      if (first < 0 && last < 0) {
        return;
      }
      if (first < 0) {
        low = Math.max(low, first / (first - last));
      }
      if (last < 0) {
        high = Math.min(high, first / (first - last));
      }
    }
  }
  if (low > high) {
    return;
  }
  const project = (fraction: number): [number, number] => {
    const p = a.map((v, index) => v + ((b[index] ?? 0) - v) * fraction);
    const w = p[3] ?? 1;
    return [(((p[0] ?? 0) / w + 1) * width) / 2, ((1 - (p[1] ?? 0) / w) * height) / 2];
  };
  const start = project(low),
    end = project(high);
  if (![...start, ...end].every(Number.isFinite)) {
    return;
  }
  context.moveTo(...start);
  context.lineTo(...end);
}

/** Draws chunk contribution bounds over a viewport in browser CSS pixels; it owns no renderer resources. */
export function drawChunkOutlines(
  canvas: HTMLCanvasElement,
  state: ZarrDebugState | undefined,
  matrix: readonly number[] | undefined,
  viewport: { x: number; y: number; width: number; height: number } | undefined,
  options: { outlines: boolean; selected: string },
): void {
  const width = window.innerWidth,
    height = window.innerHeight;
  const context = clearCanvas(canvas, width, height);
  if (!context) {
    return;
  }
  if (!state || !matrix || !viewport || !options.outlines) {
    return;
  }
  const projection = new Matrix4(matrix);
  context.save();
  context.beginPath();
  context.rect(viewport.x, viewport.y, viewport.width, viewport.height);
  context.clip();
  context.translate(viewport.x, viewport.y);
  for (const chunk of state.chunks) {
    const corners: number[][] = [];
    for (const x of [chunk.min[0], chunk.max[0]]) {
      for (const y of [chunk.min[1], chunk.max[1]]) {
        for (const z of [chunk.min[2], chunk.max[2]]) {
          corners.push(Array.from(projection.transform([x, y, z, 1])));
        }
      }
    }
    context.beginPath();
    for (const [a, b] of BOX_EDGES) {
      const first = corners[a],
        last = corners[b];
      if (first && last) {
        segment(context, first, last, viewport.width, viewport.height);
      }
    }
    context.strokeStyle = CHUNK_COLORS[chunk.status];
    context.lineWidth = chunk.id === options.selected ? 3 : chunk.selected ? 1.2 : 0.7;
    context.globalAlpha =
      options.selected && options.selected !== chunk.id ? 0.15 : chunk.selected ? 0.9 : 0.35;
    context.setLineDash(
      chunk.status === 'queued' ? [4, 4] : chunk.status === 'loading' ? [8, 4] : [],
    );
    context.stroke();
  }
  context.restore();
}
