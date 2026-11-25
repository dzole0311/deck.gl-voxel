type Point = [number, number, number];
const EPSILON = 1e-9;
const BOX_FACES = [
  [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
  ],
  [
    [0, 0, 1],
    [0, 1, 1],
    [1, 1, 1],
    [1, 0, 1],
  ],
  [
    [0, 0, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 0, 0],
  ],
  [
    [0, 1, 0],
    [1, 1, 0],
    [1, 1, 1],
    [0, 1, 1],
  ],
  [
    [0, 0, 0],
    [0, 1, 0],
    [0, 1, 1],
    [0, 0, 1],
  ],
  [
    [1, 0, 0],
    [1, 0, 1],
    [1, 1, 1],
    [1, 1, 0],
  ],
] as const;

function interpolate(a: readonly number[], b: readonly number[], fraction: number): Point {
  const at = (axis: number): number =>
    (a[axis] ?? 0) + ((b[axis] ?? 0) - (a[axis] ?? 0)) * fraction;
  return [at(0), at(1), at(2)];
}

function dot(a: readonly number[], b: readonly number[]): number {
  return (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
}
function cross(a: readonly number[], b: readonly number[]): Point {
  const [x = 0, y = 0, z = 0] = a,
    [u = 0, v = 0, w = 0] = b;
  return [y * w - z * v, z * u - x * w, x * v - y * u];
}

/** Classifies an inward-wound intersection face using a perspective eye or an orthographic direction toward the camera. */
export function classifyViewFace(
  face: readonly Point[],
  eye: Point | undefined,
  towardCamera: Point,
): 'entry' | 'exit' | 'side' {
  const origin = face[0];
  if (!origin) {
    return 'side';
  }
  const direction = eye ? eye.map((value, axis) => value - (origin[axis] ?? 0)) : towardCamera;
  for (let index = 1; index < face.length - 1; index++) {
    const a = face[index],
      b = face[index + 1];
    if (!a || !b) {
      continue;
    }
    const edgeA = a.map((value, axis) => value - (origin[axis] ?? 0));
    const edgeB = b.map((value, axis) => value - (origin[axis] ?? 0));
    const lengthA = Math.hypot(...edgeA),
      lengthB = Math.hypot(...edgeB);
    if (!lengthA || !lengthB) {
      continue;
    }
    // Collinearity depends on the angle, not the clipped face's area at the current zoom.
    const normal = cross(
      edgeA.map((value) => value / lengthA),
      edgeB.map((value) => value / lengthB),
    );
    const length = Math.hypot(...normal);
    if (length > EPSILON) {
      const facing = dot(normal, direction);
      if (Math.abs(facing) <= EPSILON * length * Math.hypot(...direction)) {
        return 'side';
      }
      return facing < 0 ? 'entry' : 'exit';
    }
  }
  return 'side';
}

function capPolygon(points: Point[], normal: readonly number[]): Point[] {
  const unique = points.filter(
    (point, index) =>
      !points
        .slice(0, index)
        .some(
          (other) =>
            Math.hypot(point[0] - other[0], point[1] - other[1], point[2] - other[2]) < EPSILON,
        ),
  );
  const center = unique.reduce<Point>(
    (sum, p) => [
      sum[0] + p[0] / unique.length,
      sum[1] + p[1] / unique.length,
      sum[2] + p[2] / unique.length,
    ],
    [0, 0, 0],
  );
  const u = cross(normal, Math.abs(normal[0] ?? 0) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
  const v = cross(normal, u);
  const angle = (point: Point): number => {
    const relative = point.map((value, axis) => value - (center[axis] ?? 0));
    return Math.atan2(dot(relative, v), dot(relative, u));
  };
  return unique.sort((a, b) => angle(a) - angle(b));
}

/** Clips the unit volume to a finite, invertible renderer transform; faces wind toward the retained interior. */
export function getVisibleVolumeFaces(volumeToClip: readonly number[]): Point[][] {
  if (volumeToClip.length !== 16 || !volumeToClip.every(Number.isFinite)) {
    return [];
  }
  let faces: Point[][] = BOX_FACES.map((face) => face.map(([x, y, z]) => [x, y, z]));
  for (const axis of [0, 1, 2]) {
    for (const sign of [-1, 1]) {
      const plane = [0, 4, 8, 12].map(
        (offset) => (volumeToClip[offset + 3] ?? 0) + sign * (volumeToClip[offset + axis] ?? 0),
      );
      const length = Math.hypot(plane[0] ?? 0, plane[1] ?? 0, plane[2] ?? 0);
      if (!length) {
        if ((plane[3] ?? 0) < 0) {
          return [];
        }
        continue;
      }
      const normal = plane.map((value) => value / length);
      const distance = (point: Point): number => dot(normal, point) + (normal[3] ?? 0);
      const clipped: Point[][] = [],
        intersections: Point[] = [];
      for (const face of faces) {
        const polygon: Point[] = [];
        let previous = face.at(-1);
        if (!previous) {
          continue;
        }
        let previousDistance = distance(previous);
        for (const point of face) {
          const currentDistance = distance(point);
          const wasInside = previousDistance >= -EPSILON;
          const isInside = currentDistance >= -EPSILON;
          if (wasInside !== isInside) {
            const intersection = interpolate(
              previous,
              point,
              Math.max(0, Math.min(1, previousDistance / (previousDistance - currentDistance))),
            );
            polygon.push(intersection);
            intersections.push(intersection);
          }
          if (isInside) {
            polygon.push(point);
          }
          previous = point;
          previousDistance = currentDistance;
        }
        if (polygon.length >= 3) {
          clipped.push(polygon);
        }
      }
      const cap = capPolygon(intersections, normal);
      if (cap.length >= 3) {
        clipped.push(cap);
      }
      faces = clipped;
      if (!faces.length) {
        return [];
      }
    }
  }
  return faces;
}

/** Returns where a finite camera ray enters and leaves the unit volume, or undefined when it misses. */
export function intersectVolumeRay(
  start: readonly number[],
  end: readonly number[],
): [Point, Point] | undefined {
  let enter = 0,
    exit = 1;
  for (const axis of [0, 1, 2]) {
    const origin = start[axis] ?? NaN,
      delta = (end[axis] ?? NaN) - origin;
    if (!Number.isFinite(origin) || !Number.isFinite(delta)) {
      return undefined;
    }
    if (delta === 0) {
      if (origin < 0 || origin > 1) {
        return undefined;
      }
    } else {
      const a = -origin / delta,
        b = (1 - origin) / delta;
      enter = Math.max(enter, Math.min(a, b));
      exit = Math.min(exit, Math.max(a, b));
      if (enter > exit) {
        return undefined;
      }
    }
  }
  return [interpolate(start, end, enter), interpolate(start, end, exit)];
}
