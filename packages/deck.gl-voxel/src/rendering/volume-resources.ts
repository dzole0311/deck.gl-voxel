import { Buffer, type Device, Texture } from '@luma.gl/core';
import { Model } from '@luma.gl/engine';
import type { RaymarchVoxelLayerProps, VoxelData } from '../types.js';
import { voxelShader } from './shaders/voxel.wgsl.js';
import { packVolume } from './volume-input.js';
import { VOXEL_UNIFORM_BYTES } from './volume-uniforms.js';

/** GPU objects owned by one VoxelLayer instance. */
export interface VoxelResources {
  /** luma.gl's draw object. It holds the shader and the GPU data the shader reads. */
  readonly model: Model;

  /** A uniform buffer holds settings that stay the same for every pixel in this draw. */
  readonly uniforms: Buffer;

  /** GPU array indexed by [x, y, z]. Each cell has a float32 value and a valid-data flag. */
  readonly volume: Texture;

  /** Reference to the caller's grid. A new object tells the layer to upload again. */
  readonly volumeData: VoxelData;

  /** GPU copy of transferData. Each horizontal pixel holds one RGBA group. */
  transfer: Texture;

  /** Reference to the last Uint8Array uploaded, so the layer can spot a new array. */
  transferData: Uint8Array;

  /** A dummy depth texture. WebGPU still expects something in that shader slot every draw. */
  readonly emptyDepth: Texture;
}

/**
 * Creates the GPU objects for drawing one volume and uploads its textures.
 * The model connects the shader to its inputs. The binding group and slot numbers
 * must match the `@group` and `@binding` declarations in the WGSL shader.
 * Frees any objects already created if a later step fails.
 *
 * @param device - The layer's WebGPU device.
 * @param props - Validated volume and layer identifier.
 * @param transferFunction - Flat Uint8Array with four bytes per color and opacity entry.
 * @returns Owned resources; release them with {@link destroyVoxelResources}.
 * @throws {Error} If a GPU object cannot be allocated or uploaded.
 */
export function createVoxelResources(
  device: Device,
  props: RaymarchVoxelLayerProps,
  transferFunction: Uint8Array,
): VoxelResources {
  const owned: { destroy(): void }[] = [];

  try {
    const [width, height, depth] = props.volume.dimensions;
    const volume = device.createTexture({
      id: `${props.id}-scalars`,
      dimension: '3d',
      width,
      height,
      depth,
      format: 'rg32float',
      usage: Texture.SAMPLE | Texture.COPY_DST,
    });

    owned.push(volume);
    volume.writeData(packVolume(props.volume), { width, height, depthOrArrayLayers: depth });

    const transfer = createTransferTexture(device, props.id, transferFunction);

    owned.push(transfer);

    const emptyDepth = device.createTexture({
      id: `${props.id}-empty-depth`,
      width: 1,
      height: 1,
      format: 'depth32float',
      usage: Texture.SAMPLE | Texture.RENDER,
    });

    owned.push(emptyDepth);

    const uniforms = device.createBuffer({
      id: `${props.id}-uniforms`,
      byteLength: VOXEL_UNIFORM_BYTES,
      usage: Buffer.UNIFORM | Buffer.COPY_DST,
    });

    owned.push(uniforms);

    const model = new Model(device, {
      id: props.id,
      source: voxelShader,
      vertexCount: 3,
      topology: 'triangle-list',
      bindings: { voxel: uniforms, scalars: volume, transfer, sceneDepth: emptyDepth },
      shaderLayout: {
        attributes: [],
        bindings: [
          { name: 'voxel', type: 'uniform', group: 0, location: 0 },
          {
            name: 'scalars',
            type: 'texture',
            group: 0,
            location: 1,
            viewDimension: '3d',
            sampleType: 'unfilterable-float',
          },
          { name: 'transfer', type: 'texture', group: 0, location: 2, sampleType: 'float' },
          { name: 'sceneDepth', type: 'texture', group: 0, location: 3, sampleType: 'depth' },
        ],
      },
    });

    return {
      model,
      uniforms,
      volume,
      volumeData: props.volume,
      transfer,
      transferData: transferFunction,
      emptyDepth,
    };
  } catch (error) {
    for (const resource of owned.reverse()) {
      resource.destroy();
    }

    throw error;
  }
}

/**
 * Copies new RGBA bytes from JavaScript to the GPU. If the array still has the
 * same number of groups of four bytes, overwrite the existing texture. A different
 * count needs a different texture width, so create a replacement.
 *
 * @param device - Device owning the resources.
 * @param resources - The layer's GPU objects, updated in place.
 * @param transferFunction - New Uint8Array of [red, green, blue, alpha] groups.
 * @param id - Label for the replacement texture if the entry count changes.
 * @throws {Error} If texture allocation or upload fails.
 */
export function updateTransferTexture(
  device: Device,
  resources: VoxelResources,
  transferFunction: Uint8Array,
  id: string,
): void {
  const width = transferFunction.length / 4;

  if (resources.transfer.width === width) {
    resources.transfer.writeData(transferFunction, { width, height: 1 });
    resources.transferData = transferFunction;
    return;
  }

  const replacement = createTransferTexture(device, id, transferFunction);

  try {
    resources.model.setBindings({ transfer: replacement });
  } catch (error) {
    replacement.destroy();
    throw error;
  }

  resources.transfer.destroy();
  resources.transfer = replacement;
  resources.transferData = transferFunction;
}

/**
 * Frees the GPU objects allocated for the layer. Callers still own their input arrays and depth.
 *
 * @param resources - Objects allocated by {@link createVoxelResources}.
 */
export function destroyVoxelResources(resources: VoxelResources): void {
  resources.model.destroy();
  resources.uniforms.destroy();
  resources.volume.destroy();
  resources.transfer.destroy();
  resources.emptyDepth.destroy();
}

/**
 * Copies RGBA groups into a 2D GPU texture with a height of one pixel.
 * With 256 entries the texture is 256 pixels wide and 1 pixel tall. The shader
 * reads a color by its X index and always uses Y = 0. The `rgba8unorm` format stores bytes
 * from 0 to 255 and gives the shader values from 0 to 1. Frees the texture if upload fails.
 *
 * @param device - WebGPU device receiving the texture.
 * @param id - Owning layer identifier.
 * @param values - Four bytes per pixel in red, green, blue and alpha order.
 * @returns The texture containing the uploaded bytes. The caller owns it.
 * @throws {Error} If allocation or upload fails.
 */
function createTransferTexture(device: Device, id: string, values: Uint8Array): Texture {
  const width = values.length / 4;
  const texture = device.createTexture({
    id: `${id}-transfer`,
    width,
    height: 1,
    format: 'rgba8unorm',
    usage: Texture.SAMPLE | Texture.COPY_DST,
  });

  try {
    texture.writeData(values, { width, height: 1 });
    return texture;
  } catch (error) {
    texture.destroy();
    throw error;
  }
}
