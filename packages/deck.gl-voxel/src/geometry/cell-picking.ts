import type { Viewport } from '@deck.gl/core';
import { Matrix4 } from '@math.gl/core';
import { cellValue } from '../data/cell-grid.js';
import type { CellMesh } from '../data/cell-mesh.js';
import type { Vector3 } from '../types.js';
import type { CellClipBounds } from './cell-bounds.js';
import { displayElevation, physicalElevation } from './coordinates.js';

/** A line in displayed common coordinates, starting at the camera's near plane. */
export interface CellPickingRay {
  readonly origin: Vector3;
  /** Vector from the near plane to the far plane. Its length is not normalized. */
  readonly direction: Vector3;
}

/**
 * Converts a pointer position into the ray used by cell picking.
 * Pass CSS pixels relative to the viewport's upper-left corner, not the page or drawing buffer.
 * The result uses displayed common XYZ, including any ground-relative height stretch.
 * @returns A ray for cell picking, or undefined for an empty view or nonfinite coordinates.
 */
export function getCellPickingRay(
  viewport: Viewport,
  pixel: readonly [number, number],
): CellPickingRay | undefined {
  if (viewport.width <= 0 || viewport.height <= 0 || !pixel.every(Number.isFinite)) {
    return undefined;
  }
  const inverse = new Matrix4(viewport.viewProjectionMatrix).invert();
  const x = (pixel[0] / viewport.width) * 2 - 1;
  const y = 1 - (pixel[1] / viewport.height) * 2;
  const near = inverse.transformAsPoint([x, y, -1]);
  const far = inverse.transformAsPoint([x, y, 1]);
  const origin: Vector3 = [near[0] ?? 0, near[1] ?? 0, near[2] ?? 0];
  const direction: Vector3 = [
    (far[0] ?? 0) - origin[0],
    (far[1] ?? 0) - origin[1],
    (far[2] ?? 0) - origin[2],
  ];
  return [...origin, ...direction].every(Number.isFinite) ? { origin, direction } : undefined;
}

/**
 * Picks disjoint chunks front to back, skipping meshes whose displayed bounds cannot contain a nearer hit.
 * Bounds must use the same exaggeration and common coordinates as the supplied ray.
 */
export function pickCellCollection<
  T extends {
    readonly mesh: CellMesh;
    readonly bounds: readonly [number, number, number, number, number, number];
  },
>(
  items: readonly T[],
  ray: { origin: Vector3; direction: Vector3 },
  exaggeration: number,
  visibleBins = 0xffffffff,
  clipBounds?: CellClipBounds,
): { item: T; hit: CellHit } | undefined {
  const candidates: { item: T; distance: number }[] = [];
  for (const item of items) {
    let enter = 0,
      exit = Infinity;
    for (const axis of [0, 1, 2] as const) {
      const low = item.bounds[axis],
        high = item.bounds[axis + 3] ?? low,
        direction = ray.direction[axis],
        origin = ray.origin[axis];
      if (Math.abs(direction) < 1e-15) {
        if (origin < low || origin > high) {
          exit = -1;
          break;
        }
      } else {
        const a = (low - origin) / direction,
          b = (high - origin) / direction;
        enter = Math.max(enter, Math.min(a, b));
        exit = Math.min(exit, Math.max(a, b));
      }
    }
    if (enter <= exit && exit >= 0) {
      candidates.push({ item, distance: enter });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);
  let nearest: { item: T; hit: CellHit } | undefined;
  for (const candidate of candidates) {
    if (nearest && candidate.distance >= nearest.hit.distance) {
      break;
    }
    const hit = pickCellMesh(candidate.item.mesh, ray, exaggeration, visibleBins, clipBounds);
    if (hit && (!nearest || hit.distance < nearest.hit.distance)) {
      nearest = { item: candidate.item, hit };
    }
  }
  return nearest;
}

/** Nearest displayed opaque hit, in the same common coordinates as the camera ray. */
export interface CellHit {
  /** Ray parameter t in origin + t * direction; this is a length only when direction is normalized. */
  readonly distance: number;
  readonly value: number;
  readonly physicalZ: number;
  readonly groundZ: number;
  readonly position: Vector3;
  readonly index: Vector3;
}

/**
 * Picks the nearest cuboid surface using the renderer's bins, ground transform and native mask.
 * A ray starting inside a kept cuboid hits its exit face; the camera's near plane does not add a surface.
 * @param ray - Origin and direction in displayed common XYZ; the direction need not be normalized.
 * A hit on a slice boundary samples just inside the kept cell, so it never reports a removed sample.
 * @param clipBounds - The same common-XY, physical-meter-Z bounds supplied to VoxelLayer.physicalClipBounds.
 */
export function pickCellMesh(
  mesh: CellMesh,
  ray: { origin: Vector3; direction: Vector3 },
  exaggeration: number,
  visibleBins = 0xffffffff,
  clipBounds?: CellClipBounds,
): CellHit | undefined {
  const { grid, instances } = mesh;
  let best = Number.POSITIVE_INFINITY,
    hit: CellHit | undefined;
  for (let i = 0; i < instances.length; i += 8) {
    const x = instances[i] ?? 0,
      y = instances[i + 1] ?? 0,
      ground = instances[i + 4] ?? 0;
    if (!(visibleBins & (1 << (instances[i + 5] ?? 0)))) {
      continue;
    }
    const scale = instances[i + 6] ?? 1;
    const z0 = displayElevation(instances[i + 2] ?? 0, ground, exaggeration) * scale;
    const z1 = displayElevation(instances[i + 3] ?? 0, ground, exaggeration) * scale;
    const a: Vector3 = [grid.origin[0] + x, grid.origin[1] + y, z0];
    const b: Vector3 = [a[0] + grid.spacing[0], a[1] + grid.spacing[1], z1];
    let enter = 0,
      exit = Infinity,
      inside = true;
    for (const axis of [0, 1, 2] as const) {
      const clipLow =
        axis === 2 && clipBounds
          ? displayElevation(clipBounds[2], ground, exaggeration) * scale
          : (clipBounds?.[axis] ?? -Infinity);
      const clipHigh =
        axis === 2 && clipBounds
          ? displayElevation(clipBounds[5], ground, exaggeration) * scale
          : (clipBounds?.[axis + 3] ?? Infinity);
      const low = Math.max(Math.min(a[axis], b[axis]), clipLow),
        high = Math.min(Math.max(a[axis], b[axis]), clipHigh);
      if (low >= high) {
        exit = -1;
        break;
      }
      const origin = ray.origin[axis],
        direction = ray.direction[axis];
      inside &&= origin > low && origin < high;
      if (Math.abs(direction) < 1e-15) {
        if (origin < low || origin > high) {
          exit = -1;
          break;
        }
      } else {
        const first = (low - origin) / direction,
          last = (high - origin) / direction;
        enter = Math.max(enter, Math.min(first, last));
        exit = Math.min(exit, Math.max(first, last));
      }
    }
    const distance = inside ? exit : enter;
    if (enter > exit || exit < 0 || distance >= best) {
      continue;
    }
    best = distance;
    const position: Vector3 = [
      ray.origin[0] + best * ray.direction[0],
      ray.origin[1] + best * ray.direction[1],
      ray.origin[2] + best * ray.direction[2],
    ];
    const physicalZ = physicalElevation(position[2] / scale, ground, exaggeration);
    const ix = Math.round(x / grid.spacing[0]),
      iy = Math.round(y / grid.spacing[1]);
    const physicalLow = Math.max(
        Math.min(instances[i + 2] ?? 0, instances[i + 3] ?? 0),
        clipBounds?.[2] ?? -Infinity,
      ),
      physicalHigh = Math.min(
        Math.max(instances[i + 2] ?? 0, instances[i + 3] ?? 0),
        clipBounds?.[5] ?? Infinity,
      );
    const inset = Math.min(Math.abs(grid.spacing[2]) * 1e-7, (physicalHigh - physicalLow) / 4);
    const insideZ = Math.max(
      physicalLow + inset,
      Math.min(
        physicalHigh - inset,
        physicalZ + Math.sign(ray.direction[2]) * (inside ? -inset : inset),
      ),
    );
    const iz = Math.max(
      0,
      Math.min(grid.dimensions[2] - 1, Math.floor((insideZ - grid.origin[2]) / grid.spacing[2])),
    );
    hit = {
      distance: best,
      value: cellValue(grid, ix, iy, iz),
      physicalZ,
      groundZ: ground,
      position,
      index: [ix, iy, iz],
    };
  }
  return hit;
}
