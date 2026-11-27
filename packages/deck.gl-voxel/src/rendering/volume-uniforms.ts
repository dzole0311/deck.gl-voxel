import type { Viewport } from '@deck.gl/core';
import { Matrix4 } from '@math.gl/core';
import { getExtent, getVoxelVolumeToCommon } from '../geometry/coordinates.js';
import type { RaymarchVoxelLayerProps } from '../types.js';

/**
 * Where to write each group of settings in the Float32Array. Each index steps four bytes.
 * WGSL can leave gaps between fields to keep them aligned in GPU memory. Match the indices
 * to the VoxelUniforms struct so the shader reads each setting from the right place.
 * @see https://www.w3.org/TR/WGSL/#alignment-and-size
 */
const OFFSETS = {
  clipToVolume: 0,
  viewport: 16,
  dimensions: 20,
  extent: 24,
  clipMin: 28,
  clipMax: 32,
  valueRange: 36,
  stepSize: 40,
  renderMode: 44,
  volumeToView: 48,
  normalToView: 64,
  volumeToOpacity: 80,
} as const;

/** Codes for coloring by data value (0) or position on X, Y or Z (1 to 3). */
const COLOR_COORDINATES = { value: 0, x: 1, y: 2, z: 3 } as const;

/** The numbers the pixel shader uses to select a render mode. */
const RENDER_MODES = { volume: 0, isosurface: 1 } as const;

/** Buffer size in bytes for four 64-byte matrices and eight 16-byte groups. Includes padding. */
export const VOXEL_UNIFORM_BYTES = (4 * 16 + 8 * 4) * Float32Array.BYTES_PER_ELEMENT;

/** Float32 offsets for the fields in OutlineUniforms in WGSL. */
export const BOUNDS_OFFSETS = {
  volumeToClip: 0,
  camera: 16,
  rearPass: 20,
  pixelRatio: 21,
  viewportSize: 22,
} as const;

/** Buffer size in bytes for a matrix, a four-number camera and four draw settings. */
export const BOUNDS_UNIFORM_BYTES = (16 + 4 + 4) * Float32Array.BYTES_PER_ELEMENT;

/**
 * Writes camera, sampling and style settings into the array the shader reads.
 * The camera applies two steps. The view matrix makes positions relative to the camera.
 * The projection matrix then takes those positions toward the screen. With perspective,
 * it makes farther objects appear smaller.
 * Invert the combined transform so the shader can work backward from a screen pixel
 * to the near and far points of a line through the grid.
 * For lighting, invert the volume-to-view matrix and swap its rows and columns
 * (the inverse transpose). This keeps the surface normal perpendicular to the surface
 * even when the grid or display is stretched more along one axis than another.
 * The outline uses the same projection as the volume, in the forward direction.
 * Its camera setting holds either a point (w = 1) or a direction (w = 0) in grid coordinates.
 * Absorption follows model scale and shear; map projection and zoom do not change its reference distance.
 *
 * @param props - Validated layer options.
 * @param viewport - Active deck.gl viewport.
 * @param canvasSize - Width and height of the canvas's drawing buffer, in actual pixels it draws.
 * @param pixelRatio - Drawing pixels per CSS pixel. At 2, a 400 CSS-pixel view draws 800 pixels across.
 * @param hasDepth - Whether a texture with the depth of opaque objects is available to the shader.
 * @returns Volume settings and, when enabled, wireframe settings for the same transform.
 * @throws {Error} If the camera transform can't be inverted or the settings overflow float32.
 * @see https://pbr-book.org/4ed/Geometry_and_Transformations/Applying_Transformations#Normals
 */
export function createVoxelUniforms(
  props: RaymarchVoxelLayerProps,
  viewport: Viewport,
  canvasSize: readonly [number, number],
  pixelRatio: number,
  hasDepth: boolean,
): { volume: Float32Array; bounds: Float32Array | undefined } {
  const values = new Float32Array(VOXEL_UNIFORM_BYTES / Float32Array.BYTES_PER_ELEMENT);
  const spacing = props.volume.spacing ?? [1, 1, 1];
  const clip = props.clipBounds ?? [0, 0, 0, 1, 1, 1];
  const opacityUnitDistance = props.opacityUnitDistance ?? Math.min(...spacing.map(Math.abs));

  const volumeToView = new Matrix4(viewport.viewMatrix).multiplyRight(
    getVoxelVolumeToCommon(props, viewport),
  );
  const volumeToClip = new Matrix4(viewport.projectionMatrix).multiplyRight(volumeToView);
  const determinant = volumeToClip.determinant();

  if (!Number.isFinite(determinant) || determinant === 0) {
    throw new Error('Voxel transform must be finite and invertible.');
  }

  const viewToVolume = volumeToView.clone().invert();
  let bounds: Float32Array | undefined;

  if (props.showBounds) {
    bounds = new Float32Array(BOUNDS_UNIFORM_BYTES / Float32Array.BYTES_PER_ELEMENT);
    bounds.set(volumeToClip, BOUNDS_OFFSETS.volumeToClip);
    /** Perspective clip W is minus view Z; orthographic clip W remains one. */
    const perspective = viewport.projectionMatrix[15] === 0;
    const camera = perspective
      ? viewToVolume.transformAsPoint([0, 0, 0])
      : viewToVolume.transformAsVector([0, 0, 1]);

    bounds.set([...camera, perspective ? 1 : 0], BOUNDS_OFFSETS.camera);
    bounds[BOUNDS_OFFSETS.pixelRatio] = pixelRatio;
    bounds.set(
      [viewport.width * pixelRatio, viewport.height * pixelRatio],
      BOUNDS_OFFSETS.viewportSize,
    );
  }

  values.set(volumeToClip.invert(), OFFSETS.clipToVolume);
  values.set(volumeToView, OFFSETS.volumeToView);
  values.set(viewToVolume.transpose(), OFFSETS.normalToView);
  values.set(
    new Matrix4(props.modelMatrix ?? undefined)
      .setColumn(3, [0, 0, 0, 1])
      .scale(getExtent(props.volume)),
    OFFSETS.volumeToOpacity,
  );
  values.set(
    [
      viewport.x * pixelRatio,
      canvasSize[1] - (viewport.y + viewport.height) * pixelRatio,
      viewport.width * pixelRatio,
      viewport.height * pixelRatio,
    ],
    OFFSETS.viewport,
  );

  values.set([...props.volume.dimensions, props.maxSteps ?? 2048], OFFSETS.dimensions);
  values.set([...getExtent(props.volume), opacityUnitDistance], OFFSETS.extent);
  values.set([clip[0], clip[1], clip[2], 0], OFFSETS.clipMin);
  values.set([clip[3], clip[4], clip[5], 0], OFFSETS.clipMax);

  values.set(
    [...(props.valueRange ?? [0, 1]), props.density ?? 1, props.opacity ?? 1],
    OFFSETS.valueRange,
  );
  values.set(
    [
      props.stepSize ?? 0.5,
      props.sampling === 'nearest' ? 1 : 0,
      hasDepth ? 1 : 0,
      COLOR_COORDINATES[props.colorBy ?? 'value'],
    ],
    OFFSETS.stepSize,
  );
  values.set(
    [RENDER_MODES[props.renderMode ?? 'volume'], props.isovalue ?? 0.5],
    OFFSETS.renderMode,
  );

  if (!values.every(Number.isFinite) || (bounds && !bounds.every(Number.isFinite))) {
    throw new Error('Voxel camera and style uniforms must be representable as float32.');
  }

  return { volume: values, bounds };
}
