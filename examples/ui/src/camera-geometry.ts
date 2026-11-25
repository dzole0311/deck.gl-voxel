import { Matrix4 } from '@math.gl/core';
import {
  classifyViewFace,
  getVisibleVolumeFaces,
  intersectVolumeRay,
} from './volume-intersection.js';

type Point = [number, number, number];
const OVERVIEW_VIEW = new Matrix4().lookAt({ eye: [-2, 3, 2], center: [0, 0, 0], up: [0, 0, 1] });

/** Projects the inset from above the Z-up scene; 2D keeps north at the top. */
export function projectOverviewPoint(
  point: readonly [number, number, number],
  mode: '2d' | '3d',
): [number, number] {
  if (mode === '2d') {
    return [point[0], -point[1]];
  }
  const position = OVERVIEW_VIEW.transformAsPoint(point);
  return [position[0] ?? 0, -(position[1] ?? 0)];
}

/** Camera and volume coordinates share a centered, uniformly scaled rendering space. */
export interface CameraOverviewGeometry {
  readonly volume: readonly Point[];
  /** Perspective eye or orthographic near-plane center, used to place the camera marker. */
  readonly origin: Point;
  readonly direction: Point;
  readonly eye: Point | undefined;
  /** Geometric view-volume intersection; opacity and scene occlusion are not considered. */
  readonly visibleFaces: readonly (readonly Point[])[];
  readonly entryFaces: readonly (readonly Point[])[];
  readonly exitFaces: readonly (readonly Point[])[];
  readonly rays: readonly { start: Point; entry: Point; exit: Point }[];
  readonly footprint: readonly Point[];
  readonly toOverview: (point: readonly number[]) => Point;
}

/** Box edges for corners ordered by nested X, Y, then Z loops. */
export const BOX_EDGES = [
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
const CLIP_CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
] as const;

function project(matrix: Matrix4, point: readonly number[]): Point | undefined {
  const result = matrix.transform([point[0] ?? 0, point[1] ?? 0, point[2] ?? 0, point[3] ?? 1]);
  const divisor = result[3] ?? 0;
  if (divisor === 0 || !Number.isFinite(divisor)) {
    return undefined;
  }
  const position: Point = [
    (result[0] ?? 0) / divisor,
    (result[1] ?? 0) / divisor,
    (result[2] ?? 0) / divisor,
  ];
  return position.every(Number.isFinite) ? position : undefined;
}

function subtract(a: Point, b: Point): Point {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
// The visible region is convex, so its top-down projection is the hull of its vertices.
function footprint(faces: readonly (readonly Point[])[], height: number): Point[] {
  const points = faces
    .flat()
    .map<Point>((point) => [point[0], point[1], height])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const unique = points.filter(
    (p, index) => !index || p[0] !== points[index - 1]?.[0] || p[1] !== points[index - 1]?.[1],
  );
  const turn = (a: Point, b: Point, c: Point): number =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const half = (ordered: Point[]): Point[] => {
    const hull: Point[] = [];
    for (const point of ordered) {
      let a = hull.at(-2),
        b = hull.at(-1);
      while (a && b && turn(a, b, point) <= 0) {
        hull.pop();
        a = hull.at(-2);
        b = hull.at(-1);
      }
      hull.push(point);
    }
    return hull.slice(0, -1);
  };
  return [...half(unique), ...half([...unique].reverse())];
}

/**
 * Intersects the volume with the renderer's view, preserving displayed proportions and finite ray entry/exit points.
 * Singular transforms return undefined; orthographic views have parallel rays and no eye point.
 */
export function getCameraOverviewGeometry(
  volumeToClip: readonly number[],
  volumeToCommon: readonly number[],
): CameraOverviewGeometry | undefined {
  if (
    volumeToClip.length !== 16 ||
    volumeToCommon.length !== 16 ||
    ![...volumeToClip, ...volumeToCommon].every(Number.isFinite)
  ) {
    return undefined;
  }
  const clip = new Matrix4(volumeToClip);
  const determinant = clip.determinant();
  const placement = new Matrix4(volumeToCommon);
  const placementDeterminant = placement.determinant();
  if (
    !Number.isFinite(determinant) ||
    determinant === 0 ||
    !Number.isFinite(placementDeterminant) ||
    placementDeterminant === 0
  ) {
    return undefined;
  }
  const inverse = clip.invert();
  const center = project(placement, [0.5, 0.5, 0.5]);
  const scale = Math.max(
    ...[0, 4, 8].map((offset) =>
      Math.hypot(
        volumeToCommon[offset] ?? 0,
        volumeToCommon[offset + 1] ?? 0,
        volumeToCommon[offset + 2] ?? 0,
      ),
    ),
  );
  if (!center || !Number.isFinite(scale) || scale <= 0) {
    return undefined;
  }
  const toOverview = (point: readonly number[]): Point => {
    const common = project(placement, point);
    return common
      ? [
          (common[0] - center[0]) / scale,
          (common[1] - center[1]) / scale,
          (common[2] - center[2]) / scale,
        ]
      : [NaN, NaN, NaN];
  };
  const nearInVolume = project(inverse, [0, 0, -1]);
  const farInVolume = project(inverse, [0, 0, 1]);
  if (!nearInVolume || !farInVolume) {
    return undefined;
  }
  const nearCenter = toOverview(nearInVolume),
    farCenter = toOverview(farInVolume);
  const delta = subtract(farCenter, nearCenter),
    length = Math.hypot(...delta);
  if (!Number.isFinite(length) || length <= 0) {
    return undefined;
  }
  const direction: Point = [delta[0] / length, delta[1] / length, delta[2] / length];
  const volume: Point[] = [];
  for (const x of [0, 1]) {
    for (const y of [0, 1]) {
      for (const z of [0, 1]) {
        volume.push(toOverview([x, y, z]));
      }
    }
  }
  const eyeInVolume = project(inverse, [0, 0, 1, 0]);
  const eye = eyeInVolume ? toOverview(eyeInVolume) : undefined;
  if (![...volume, nearCenter, ...(eye ? [eye] : [])].flat().every(Number.isFinite)) {
    return undefined;
  }
  const unitFaces = getVisibleVolumeFaces(volumeToClip);
  const visibleFaces = unitFaces.map((face) => face.map(toOverview));
  const towardCamera = subtract(nearInVolume, farInVolume);
  const crossings = unitFaces.map((face) => classifyViewFace(face, eyeInVolume, towardCamera));
  const entryFaces = visibleFaces.filter((_, index) => crossings[index] === 'entry');
  const exitFaces = visibleFaces.filter((_, index) => crossings[index] === 'exit');
  const rays: { start: Point; entry: Point; exit: Point }[] = [];
  for (const [x, y] of [[0, 0], ...CLIP_CORNERS]) {
    const start = project(inverse, [x ?? 0, y ?? 0, -1]);
    const end = project(inverse, [x ?? 0, y ?? 0, 1]);
    const intersection = start && end ? intersectVolumeRay(start, end) : undefined;
    if (start && intersection) {
      rays.push({
        start: toOverview(start),
        entry: toOverview(intersection[0]),
        exit: toOverview(intersection[1]),
      });
    }
  }
  return {
    volume,
    origin: eye ?? nearCenter,
    direction,
    eye,
    visibleFaces,
    entryFaces,
    exitFaces,
    rays,
    footprint: footprint(visibleFaces, Math.min(...volume.map((p) => p[2]))),
    toOverview,
  };
}
