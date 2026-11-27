import type { ZarrDebugState } from 'deck.gl-voxel-zarr';
import { BOX_EDGES, getCameraOverviewGeometry, projectOverviewPoint } from './camera-geometry.js';
import { clearCanvas } from './canvas.js';
import { CHUNK_COLORS } from './chunk-drawing.js';

type Point = readonly [number, number, number];
/** Shared entry and exit colors for the diagram and its key. */
export const CAMERA_COLORS = { entry: '#2563eb', exit: '#d97706' };
const CAMERA_COLOR = CAMERA_COLORS.entry;
const BOX_FACES = [
  [0, 4, 6, 2],
  [1, 3, 7, 5],
  [0, 1, 5, 4],
  [2, 6, 7, 3],
  [0, 2, 3, 1],
  [4, 5, 7, 6],
] as const;

/** Draws a separate view of the live camera and chunk grid without fetching data or allocating GPU resources. */
export function drawCameraOverview(
  canvas: HTMLCanvasElement,
  state: ZarrDebugState | undefined,
  volumeToClip: readonly number[] | undefined,
  volumeToCommon: readonly number[] | undefined,
  mode: '2d' | '3d',
  selected: string,
): void {
  const width = canvas.clientWidth,
    height = canvas.clientHeight;
  const context = clearCanvas(canvas, width, height);
  if (!context) {
    return;
  }
  if (!state || !volumeToClip || !volumeToCommon) {
    return;
  }
  const geometry = getCameraOverviewGeometry(volumeToClip, volumeToCommon);
  if (!geometry) {
    return;
  }
  const raw = (point: Point): [number, number] => projectOverviewPoint(point, mode);
  const points = [...geometry.volume, geometry.origin].map(raw);
  const minX = Math.min(...points.map((p) => p[0])),
    maxX = Math.max(...points.map((p) => p[0]));
  const minY = Math.min(...points.map((p) => p[1])),
    maxY = Math.max(...points.map((p) => p[1]));
  const padding = 30;
  const scale = Math.min(
    (width - padding * 2) / Math.max(0.1, maxX - minX),
    (height - padding * 2) / Math.max(0.1, maxY - minY),
  );
  const project = (point: Point): [number, number] => {
    const [x, y] = raw(point);
    return [
      width / 2 + (x - (minX + maxX) / 2) * scale,
      height / 2 + (y - (minY + maxY) / 2) * scale,
    ];
  };
  const line = (a: Point, b: Point): void => {
    context.moveTo(...project(a));
    context.lineTo(...project(b));
  };
  const polygon = (vertices: readonly Point[], fill: string, stroke?: string): void => {
    if (vertices.length < 3) {
      return;
    }
    context.beginPath();
    vertices.forEach((point, index) => {
      if (index === 0) {
        context.moveTo(...project(point));
      } else {
        context.lineTo(...project(point));
      }
    });
    context.closePath();
    context.fillStyle = fill;
    context.fill();
    if (stroke) {
      context.strokeStyle = stroke;
      context.stroke();
    }
  };
  const box = (corners: readonly Point[], color: string): void => {
    context.beginPath();
    for (const [a, b] of BOX_EDGES) {
      const first = corners[a],
        last = corners[b];
      if (first && last) {
        line(first, last);
      }
    }
    context.strokeStyle = color;
    context.stroke();
  };

  const bottom = (geometry.volume[0]?.[2] ?? 0) > (geometry.volume[1]?.[2] ?? 0) ? 1 : 0;
  const ground = [0, 4, 6, 2]
    .map((index) => geometry.volume[index + bottom])
    .filter((p) => p !== undefined);
  context.lineWidth = 1;
  polygon(ground, '#f5f5f5', '#d4d4d4');
  for (const chunk of state.chunks) {
    if (chunk.empty) {
      continue;
    }
    if (mode === '2d' && (chunk.min[2] > 0.5 || chunk.max[2] <= 0.5)) {
      continue;
    }
    const corners: Point[] = [];
    for (const x of [chunk.min[0], chunk.max[0]]) {
      for (const y of [chunk.min[1], chunk.max[1]]) {
        for (const z of [chunk.min[2], chunk.max[2]]) {
          corners.push(geometry.toOverview([x, y, z]));
        }
      }
    }
    const color = CHUNK_COLORS[chunk.status];
    const projectedCorners = corners.map(project);
    context.globalAlpha =
      chunk.id === selected
        ? 0.22
        : selected
          ? 0.025
          : !chunk.selected
            ? 0.03
            : mode === '2d'
              ? 0.18
              : 0.1;
    for (const indices of BOX_FACES) {
      const face = indices.map((index) => corners[index]).filter((point) => point !== undefined);
      const projected = indices
        .map((index) => projectedCorners[index])
        .filter((point) => point !== undefined);
      const area = projected.reduce((sum, point, index) => {
        const next = projected[(index + 1) % projected.length];
        return next ? sum + point[0] * next[1] - next[0] * point[1] : sum;
      }, 0);
      // Fill one side of the box only, so front/back faces do not double its opacity.
      if (area > 0) {
        polygon(face, color);
      }
    }
    context.globalAlpha =
      chunk.id === selected ? 0.9 : selected ? 0.1 : chunk.selected ? 0.38 : 0.12;
    context.lineWidth = selected === chunk.id ? 2 : 0.7;
    box(corners, color);
  }
  context.globalAlpha = 1;
  context.lineWidth = 1;
  box(geometry.volume, '#737373');

  if (mode === '2d') {
    polygon(geometry.footprint, `${CAMERA_COLOR}18`, CAMERA_COLOR);
  } else {
    for (const face of geometry.visibleFaces) {
      if (!geometry.entryFaces.includes(face) && !geometry.exitFaces.includes(face)) {
        polygon(face, '#64748b06', '#64748b44');
      }
    }
    for (const face of geometry.exitFaces) {
      polygon(face, `${CAMERA_COLORS.exit}20`, `${CAMERA_COLORS.exit}cc`);
    }
    for (const face of geometry.entryFaces) {
      polygon(face, `${CAMERA_COLOR}30`, `${CAMERA_COLOR}cc`);
    }
    for (const ray of geometry.rays) {
      context.beginPath();
      line(geometry.eye ?? ray.start, ray.entry);
      context.strokeStyle = `${CAMERA_COLOR}66`;
      context.stroke();
      context.beginPath();
      line(ray.entry, ray.exit);
      context.strokeStyle = '#64748b80';
      context.stroke();
      context.beginPath();
      context.arc(...project(ray.entry), 1.25, 0, Math.PI * 2);
      context.fillStyle = CAMERA_COLOR;
      context.fill();
      context.beginPath();
      context.arc(...project(ray.exit), 1.25, 0, Math.PI * 2);
      context.fillStyle = CAMERA_COLORS.exit;
      context.fill();
    }
  }

  const camera = geometry.origin;
  const target: Point = [
    camera[0] + geometry.direction[0],
    camera[1] + geometry.direction[1],
    camera[2] + geometry.direction[2],
  ];
  const [cx, cy] = project(camera),
    [tx, ty] = project(target);
  const angle = Math.atan2(ty - cy, tx - cx);
  context.save();
  context.translate(cx, cy);
  context.rotate(angle);
  context.beginPath();
  if (Math.hypot(tx - cx, ty - cy) < 1) {
    context.arc(0, 0, 4, 0, Math.PI * 2);
  } else {
    context.moveTo(8, 0);
    context.lineTo(-5, -5);
    context.lineTo(-3, 0);
    context.lineTo(-5, 5);
    context.closePath();
  }
  context.fillStyle = CAMERA_COLOR;
  context.fill();
  context.restore();
  context.font = '11px system-ui, sans-serif';
  context.fillStyle = CAMERA_COLOR;
  context.textAlign = 'center';
  context.fillText(geometry.eye ? 'Camera' : 'View plane', cx, cy - 12);
  context.fillStyle = '#737373';
  context.textAlign = 'left';
  const [nx, ny] = raw([0, 1, 0]);
  const nLength = Math.hypot(nx, ny);
  context.beginPath();
  context.moveTo(20, height - 20);
  context.lineTo(20 + (nx / nLength) * 15, height - 20 + (ny / nLength) * 15);
  context.strokeStyle = '#737373';
  context.stroke();
  context.fillText('N', 16 + (nx / nLength) * 25, height - 16 + (ny / nLength) * 25);
}
