import type { LayerProps } from '@deck.gl/core';
import type { Texture } from '@luma.gl/core';

import type { VoxelLayer } from './voxel-layer.js';

/** Three coordinates in X, Y, Z order. */
export type Vector3 = readonly [number, number, number];

/** Kept lower and upper XYZ fractions in grid-index direction from the origin, between 0 and 1. */
export type NormalizedClipBounds = readonly [number, number, number, number, number, number];

/**
 * A 3D grid with one number per cell for {@link VoxelLayer}.
 * Pass a new grid object when the values or geometry change.
 * The origin is an outside corner. On each axis the first cell center is half a cell
 * in from that corner. The formula is `origin + (index + 0.5) * spacing`.
 */
export interface VoxelData {
  /**
   * Store one X row after another, then one XY plane after another along Z.
   * The flat index for cell (x, y, z) is `x + width * (y + height * z)`.
   */
  readonly values: Float32Array;

  /** Number of cells on the X, Y and Z axes. Each count is a positive integer. */
  readonly dimensions: Vector3;

  /**
   * The starting corner of the grid in layer coordinates. Cell [0, 0, 0] touches it.
   * @default [0, 0, 0]
   */
  readonly origin?: Vector3;

  /**
   * Distance between cell centers on each axis, in layer units. For example, [2, 2, 5]
   * makes cells taller than they are wide. This is called anisotropic spacing.
   * A negative number reverses that axis.
   * Each distance must be nonzero.
   * @default [1, 1, 1]
   */
  readonly spacing?: Vector3;

  /** A value such as -9999 that marks missing data. NaN and infinity always count as missing. */
  readonly noDataValue?: number;
}

/** Grid bounds without scalar values, used for camera transforms and chunk selection */
export type VoxelGeometry = Pick<VoxelData, 'dimensions' | 'origin' | 'spacing'>;

/** Provides the depth of opaque objects drawn with the same GPU device and camera. */
export interface VoxelDepthSource {
  /**
   * Gets the full-canvas depth texture for this view. The source still owns it.
   * Each pixel stores how close the nearest opaque object is, in the camera's depth units.
   * Use the depth convention of deck.gl 9.3's scene shaders.
   *
   * @param viewportId - deck.gl viewport identifier.
   * @returns A depth32float texture the shader can read, or undefined before a capture is ready.
   */
  getDepthTexture(viewportId: string): Texture | undefined;
}

/** Options for drawing one volume. */
export type RaymarchVoxelLayerProps = LayerProps & {
  /** Grid values and geometry. The caller loads the data and owns the input array. */
  volume: VoxelData;

  /**
   * For each pixel, the shader follows a line from the camera through the grid.
   * Volume blends the colors it finds along that line. Isosurface draws the first spot
   * where values cross the chosen threshold. Set Layer.opacity for the surface opacity.
   * @default 'volume'
   */
  renderMode?: 'volume' | 'isosurface';

  /**
   * The isosurface threshold in the data's units, such as m/s. A surface needs valid samples
   * on both sides of this value. Clipping and missing data just limit where the shader looks.
   * @default 0.5
   */
  isovalue?: number;

  /**
   * Data values that map to the first and last RGBA entries in transferFunction.
   * With [0, 60] for wind speed, 30 m/s uses the middle of the color ramp. Values
   * outside the range use the nearest end.
   * @default [0, 1]
   */
  valueRange?: readonly [number, number];

  /**
   * A flat list of [red, green, blue, alpha] groups. Each number is a byte from 0 to 255.
   * The first group is for the low end of valueRange and the last is for the high end.
   * The shader blends neighboring groups for values in between. Supply RGB as usual
   * and let the shader multiply it by alpha when drawing. Alpha gives the opacity for one
   * {@link VoxelLayerProps.opacityUnitDistance}. Pass a new Uint8Array to update the colors.
   * @default A 256-entry blue-to-orange ramp with increasing alpha
   * @example
   * // Low values are transparent blue and high values are about half-opaque orange.
   * new Uint8Array([0, 0, 255, 0, 255, 80, 0, 128]);
   */
  transferFunction?: Uint8Array;

  /**
   * Pick colors by data value or by position along an axis. Axis colors run from one
   * edge of the full grid to the other. Opacity still comes from the data value.
   * @default 'value'
   */
  colorBy?: 'value' | 'x' | 'y' | 'z';

  /**
   * Distance between samples measured in cells. A value of 0.5 means half a cell.
   * Must be positive.
   * @default 0.5
   */
  stepSize?: number;

  /**
   * Maximum samples per ray, from 1 to 4096. Long rays may space samples farther apart.
   * @default 2048
   */
  maxSteps?: number;

  /**
   * Distance over which one alpha value from transferFunction applies, in layer units
   * after modelMatrix. Model scaling changes absorption; map projection and camera zoom do not.
   * If alpha is 0.5 over 2 meters, each 2-meter segment lets half the light through.
   * A 4-meter segment lets a quarter through. Defaults to the smallest cell size.
   */
  opacityUnitDistance?: number;

  /**
   * Controls how quickly opacity builds up in volume mode. Zero hides the volume.
   * The multiplier must be nonnegative.
   * @default 1
   */
  density?: number;

  /**
   * Draw the full grid's bounding box, even when clipBounds shows only part of the grid.
   * Rear edges are dashed and drawn beneath the volume. Front edges are solid.
   * @default false
   */
  showBounds?: boolean;

  /**
   * Box to keep, in [minX, minY, minZ, maxX, maxY, maxZ] order.
   * These are fractions of the grid size along each axis. Zero is the starting edge,
   * 0.5 is halfway across and 1 is the far edge. For example, setting maxZ to 0.5
   * keeps only the first half of the grid along Z. Use valueRange for the data values.
   * @default [0, 0, 0, 1, 1, 1]
   */
  clipBounds?: readonly [number, number, number, number, number, number];

  /**
   * Use the nearest cell or blend nearby cells. Linear sampling skips missing cells
   * and adjusts the remaining weights to add up to 1.
   * @default 'linear'
   */
  sampling?: 'linear' | 'nearest';

  /**
   * Limit on GPU texture memory in bytes, including the missing-data flags and color table.
   * @default 268435456
   */
  maxTextureBytes?: number;

  /** Optional depth from opaque deck.gl layers, used to hide the volume behind those objects. */
  depthSource?: VoxelDepthSource;
};

/** Settings for the existing dense volume renderer. */
export type VoxelLayerProps = RaymarchVoxelLayerProps;
