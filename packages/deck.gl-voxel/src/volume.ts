import type { Vector3, VoxelData, VoxelLayerProps } from './types.js';

/** The layer can keep up to 256 MiB of textures on the GPU by default. */
export const DEFAULT_MAX_TEXTURE_BYTES = 256 * 1024 * 1024;

/** One float32 for the value and one for the valid-data flag. Each takes four bytes. */
const BYTES_PER_CELL = 2 * Float32Array.BYTES_PER_ELEMENT;

/** A one-pixel depth32float texture fills the shader's depth slot when there's no scene depth. */
const EMPTY_DEPTH_BYTES = Float32Array.BYTES_PER_ELEMENT;

/** Default Uint8Array of RGBA groups. Higher values get warmer colors and more opacity. */
export const DEFAULT_TRANSFER_FUNCTION = createDefaultTransferFunction();

/**
 * Checks the grid geometry and texture memory before creating anything on the GPU.
 *
 * @param volume - Grid supplied by the caller.
 * @param maxDimension - Largest cell count the GPU allows on any one texture axis.
 * @param maxBytes - GPU texture memory allowed for this layer, in bytes.
 * @param transferBytes - Size in bytes of the transferFunction typed array.
 * @throws {Error} If the grid is malformed or exceeds an allocation limit.
 */
export function validateVolume(
  volume: VoxelData,
  maxDimension: number,
  maxBytes: number,
  transferBytes: number,
): void {
  if (!(volume?.values instanceof Float32Array)) {
    throw new Error('VoxelLayer requires Float32Array scalar values.');
  }

  const { dimensions, origin = [0, 0, 0], spacing = [1, 1, 1] } = volume;

  if (
    !Array.isArray(dimensions) ||
    dimensions.length !== 3 ||
    !dimensions.every((size) => Number.isInteger(size) && size > 0 && size <= maxDimension)
  ) {
    throw new Error(
      `Voxel dimensions must be positive integers no greater than ${maxDimension} on this device.`,
    );
  }

  const cellCount = dimensions[0] * dimensions[1] * dimensions[2];

  if (!Number.isSafeInteger(cellCount) || volume.values.length !== cellCount) {
    throw new Error('Voxel values length must equal width * height * depth.');
  }

  if (
    origin.length !== 3 ||
    !origin.every(Number.isFinite) ||
    spacing.length !== 3 ||
    !spacing.every((size) => Number.isFinite(Math.fround(size)) && Math.fround(size) !== 0)
  ) {
    throw new Error('Voxel origin must be finite and spacing must be finite and nonzero.');
  }

  if (!getExtent(volume).every((size) => Number.isFinite(Math.fround(size)))) {
    throw new Error('Voxel extent exceeds float32 precision.');
  }

  const textureBytes = cellCount * BYTES_PER_CELL + transferBytes + EMPTY_DEPTH_BYTES;

  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || textureBytes > maxBytes) {
    throw new Error(
      `Voxel textures require ${textureBytes} bytes; maxTextureBytes is ${maxBytes}.`,
    );
  }
}

/**
 * Checks that layer settings can be sent to the shader as float32 values.
 *
 * @param props - Layer options, including sampling and color settings.
 * @throws {Error} If an option is invalid or requests an unsupported feature.
 */
export function validateStyle(props: VoxelLayerProps): void {
  if (
    props.renderMode !== undefined &&
    props.renderMode !== 'volume' &&
    props.renderMode !== 'isosurface'
  ) {
    throw new Error('renderMode must be volume or isosurface.');
  }

  if (!Number.isFinite(Math.fround(props.isovalue ?? 0.5))) {
    throw new Error('isovalue must be finite and representable as float32.');
  }

  const valueRange = props.valueRange ?? [0, 1];
  const [minimum, maximum] = valueRange;

  if (
    valueRange.length !== 2 ||
    !valueRange.every((value) => Number.isFinite(Math.fround(value))) ||
    Math.fround(minimum) >= Math.fround(maximum) ||
    !Number.isFinite(Math.fround(maximum - minimum))
  ) {
    throw new Error('valueRange must contain two increasing values representable as float32.');
  }

  const bounds = props.clipBounds ?? [0, 0, 0, 1, 1, 1];

  if (
    bounds.length !== 6 ||
    !bounds.every((value) => Number.isFinite(value) && value >= 0 && value <= 1) ||
    bounds[0] > bounds[3] ||
    bounds[1] > bounds[4] ||
    bounds[2] > bounds[5]
  ) {
    throw new Error('clipBounds must be ordered normalized bounds within [0, 1].');
  }

  assertPositiveFloat(props.stepSize ?? 0.5, 'stepSize');

  const maxSteps = props.maxSteps ?? 2048;

  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 4096) {
    throw new Error('maxSteps must be an integer between 1 and 4096.');
  }

  const density = props.density ?? 1;

  if (!Number.isFinite(Math.fround(density)) || density < 0) {
    throw new Error('density must be finite and nonnegative.');
  }

  if (props.opacityUnitDistance !== undefined) {
    assertPositiveFloat(props.opacityUnitDistance, 'opacityUnitDistance');
  }

  if (props.sampling !== undefined && props.sampling !== 'linear' && props.sampling !== 'nearest') {
    throw new Error('sampling must be linear or nearest.');
  }

  if (props.pickable || props.extensions?.length) {
    throw new Error('Voxel picking and layer extensions are not supported yet.');
  }

  const transferFunction = props.transferFunction ?? DEFAULT_TRANSFER_FUNCTION;

  if (props.colorBy !== undefined && !['value', 'x', 'y', 'z'].includes(props.colorBy)) {
    throw new Error('colorBy must be value, x, y, or z.');
  }

  if (
    !(transferFunction instanceof Uint8Array) ||
    transferFunction.length < 8 ||
    transferFunction.length % 4 !== 0
  ) {
    throw new Error('transferFunction must contain at least two RGBA8 entries.');
  }
}

/**
 * Copies each value and a valid-data flag into the array WebGPU will upload.
 * Missing cells become [0, 0]. Valid cells become [value, 1].
 *
 * @param volume - Validated grid in X-fastest order.
 * @returns A flat Float32Array ready to upload. The shader reads each pair as two numbers
 * from the texture's red and green slots.
 */
export function packVolume(volume: VoxelData): Float32Array {
  const packed = new Float32Array(volume.values.length * 2);

  for (let index = 0; index < volume.values.length; index++) {
    const value = volume.values[index];

    if (value !== undefined && Number.isFinite(value) && value !== volume.noDataValue) {
      packed[index * 2] = value;
      packed[index * 2 + 1] = 1;
    }
  }

  return packed;
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
 * Checks that a positive number stays positive and finite after conversion to float32.
 *
 * @param value - Number to send to the GPU.
 * @param name - Property name used in the error message.
 * @throws {Error} If the float32 conversion is not positive and finite.
 */
function assertPositiveFloat(value: number, name: string): void {
  const shaderValue = Math.fround(value);

  if (!Number.isFinite(shaderValue) || shaderValue <= 0) {
    throw new Error(`${name} must be positive and finite in float32.`);
  }
}

/**
 * Builds the default color ramp once so layers can share the same Uint8Array.
 *
 * @returns A Uint8Array with 256 RGBA groups of four bytes each.
 */
function createDefaultTransferFunction(): Uint8Array {
  const table = new Uint8Array(256 * 4);

  for (let index = 0; index < 256; index++) {
    table.set([index, Math.round(index * 0.65), 255 - index, Math.round(index * 0.12)], index * 4);
  }

  return table;
}
