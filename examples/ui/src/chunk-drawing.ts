import { Matrix4 } from '@math.gl/core';
import type { ZarrDebugChunk, ZarrDebugState } from 'deck.gl-voxel-zarr';

export const CHUNK_COLORS: Record<ZarrDebugChunk['status'], string> = {
  outside: '#737373',
  queued: '#a16207',
  loading: '#0369a1',
  ready: '#15803d',
  cached: '#7e22ce',
  cancelled: '#c2410c',
  error: '#b91c1c',
};
const EDGES = [
  [0, 1],
  [0, 2],
  [0, 4],
  [1, 3],
  [1, 5],
  [2, 3],
  [2, 6],
  [3, 7],
  [4, 5],
  [4, 6],
  [5, 7],
  [6, 7],
] as const;

function transform(matrix: readonly number[], point: readonly number[]): number[] {
  return [0, 1, 2, 3].map(
    (row) =>
      (matrix[row] ?? 0) * (point[0] ?? 0) +
      (matrix[row + 4] ?? 0) * (point[1] ?? 0) +
      (matrix[row + 8] ?? 0) * (point[2] ?? 0) +
      (matrix[row + 12] ?? 0) * (point[3] ?? 1),
  );
}

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
  options: { outlines: boolean; outside: boolean; selected: string },
): void {
  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }
  const ratio = Math.min(devicePixelRatio, 2);
  const width = window.innerWidth,
    height = window.innerHeight;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  if (!state || !matrix || !viewport || !options.outlines) {
    return;
  }
  context.save();
  context.beginPath();
  context.rect(viewport.x, viewport.y, viewport.width, viewport.height);
  context.clip();
  context.translate(viewport.x, viewport.y);
  for (const chunk of state.chunks) {
    if (!options.outside && !chunk.selected) {
      continue;
    }
    const corners: number[][] = [];
    for (const x of [chunk.min[0], chunk.max[0]]) {
      for (const y of [chunk.min[1], chunk.max[1]]) {
        for (const z of [chunk.min[2], chunk.max[2]]) {
          corners.push(transform(matrix, [x, y, z, 1]));
        }
      }
    }
    context.beginPath();
    for (const [a, b] of EDGES) {
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

/** Shows chunk footprints and the camera intersection with the grid's middle Z plane. */
export function drawChunkOverview(
  canvas: HTMLCanvasElement,
  state: ZarrDebugState | undefined,
  matrix: readonly number[] | undefined,
): void {
  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }
  const width = canvas.width,
    height = canvas.height;
  context.clearRect(0, 0, width, height);
  if (!state || !matrix) {
    return;
  }
  const pad = 16,
    w = width - pad * 2,
    h = height - pad * 2;
  context.strokeStyle = '#d4d4d4';
  context.strokeRect(pad, pad, w, h);
  for (const chunk of state.chunks) {
    if (chunk.min[2] > 0.5 || chunk.max[2] <= 0.5) {
      continue;
    }
    const x = pad + chunk.min[0] * w,
      y = pad + (1 - chunk.max[1]) * h;
    const cw = (chunk.max[0] - chunk.min[0]) * w,
      ch = (chunk.max[1] - chunk.min[1]) * h;
    context.fillStyle = CHUNK_COLORS[chunk.status];
    context.globalAlpha = chunk.selected ? 0.18 : 0.04;
    context.fillRect(x, y, cw, ch);
    context.globalAlpha = 1;
    context.strokeRect(x, y, cw, ch);
  }
  const inverse = new Matrix4(matrix).invert();
  context.save();
  context.beginPath();
  context.rect(0, 0, width, height);
  context.clip();
  context.beginPath();
  const points: [number, number][] = [];
  for (const point of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]) {
    const near = transform(inverse, [point[0] ?? 0, point[1] ?? 0, -1, 1]);
    const far = transform(inverse, [point[0] ?? 0, point[1] ?? 0, 1, 1]);
    const a = near.map((v) => v / (near[3] ?? 1)),
      b = far.map((v) => v / (far[3] ?? 1));
    const fraction = (0.5 - (a[2] ?? 0)) / ((b[2] ?? 0) - (a[2] ?? 0));
    points.push([
      pad + ((a[0] ?? 0) + ((b[0] ?? 0) - (a[0] ?? 0)) * fraction) * w,
      pad + (1 - ((a[1] ?? 0) + ((b[1] ?? 0) - (a[1] ?? 0)) * fraction)) * h,
    ]);
  }
  if (points.flat().every(Number.isFinite)) {
    for (const [index, point] of points.entries()) {
      if (index === 0) {
        context.moveTo(...point);
      } else {
        context.lineTo(...point);
      }
    }
    context.closePath();
    context.strokeStyle = '#a16207';
    context.lineWidth = 2;
    context.stroke();
  }
  context.restore();
}
