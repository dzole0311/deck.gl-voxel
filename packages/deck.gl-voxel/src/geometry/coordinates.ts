import type { LayerProps, Viewport } from '@deck.gl/core';
import { Matrix4 } from '@math.gl/core';
import type { Vector3, VoxelData, VoxelGeometry } from '../types.js';

/** Physical elevation to display elevation. Local ground remains fixed. */
export function displayElevation(physical: number, ground: number, exaggeration = 1): number {
  return ground + exaggeration * (physical - ground);
}

/** Inverse of {@link displayElevation}; useful for physical-value tooltips. */
export function physicalElevation(display: number, ground: number, exaggeration = 1): number {
  return ground + (display - ground) / exaggeration;
}

/**
 * Multiplies cell counts by spacing to get the full grid size along each axis.
 *
 * @param volume - Grid with optional signed spacing.
 * @returns X, Y and Z distances in layer units, with the sign preserved for flipped axes.
 */
export function getExtent(volume: Pick<VoxelData, 'dimensions' | 'spacing'>): Vector3 {
  const spacing = volume.spacing ?? [1, 1, 1];

  return [
    volume.dimensions[0] * spacing[0],
    volume.dimensions[1] * spacing[1],
    volume.dimensions[2] * spacing[2],
  ];
}

/**
 * Converts positions inside the grid to the same 3D coordinates other deck.gl layers use.
 * The shader expresses each position as a fraction of the grid along X, Y and Z.
 * For example, if X starts at 100 m and spans 20 m, X = 0 means 100 m, X = 0.5
 * means 110 m and X = 1 means 120 m before any display or map transforms.
 * For meter offsets on a map, use the scale at coordinateOrigin for the whole grid.
 *
 * @param props - Grid origin, cell spacing and any placement or display transform.
 * @param viewport - Active view, used to project the map anchor and measure its scale.
 * @returns A matrix that maps the grid box into the same space as other deck.gl layers.
 * @throws {Error} If the coordinate system is unsupported.
 * @see https://deck.gl/docs/developer-guide/coordinate-systems#common-space
 */
export function getVoxelVolumeToCommon(
  props: Pick<LayerProps, 'coordinateSystem' | 'coordinateOrigin' | 'modelMatrix'> & {
    volume: VoxelGeometry;
  },
  viewport: Viewport,
): Matrix4 {
  if (viewport.resolution !== undefined) {
    throw new Error('VoxelLayer does not support GlobeView.');
  }

  const matrix = new Matrix4();
  const coordinateOrigin = props.coordinateOrigin ?? [0, 0, 0];
  const coordinateSystem = props.coordinateSystem ?? 'cartesian';

  if (coordinateSystem === 'meter-offsets') {
    if (!viewport.isGeospatial) {
      throw new Error('Meter-offset coordinates require a geospatial viewport.');
    }

    const anchor = viewport.projectPosition(coordinateOrigin);
    const distanceScales = viewport.getDistanceScales(coordinateOrigin);

    matrix.translate(anchor).scale(distanceScales.unitsPerMeter);
  } else if (
    coordinateSystem === 'cartesian' ||
    (!viewport.isGeospatial && coordinateSystem === 'default')
  ) {
    if (viewport.isGeospatial) {
      matrix.translate(coordinateOrigin);
    }
  } else {
    throw new Error('VoxelLayer supports cartesian and meter-offsets coordinates.');
  }

  if (props.modelMatrix) {
    matrix.multiplyRight(props.modelMatrix);
  }

  matrix.translate(props.volume.origin ?? [0, 0, 0]).scale(getExtent(props.volume));

  return matrix;
}
