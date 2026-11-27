import { Buffer, type Device } from '@luma.gl/core';
import { Model } from '@luma.gl/engine';
import { voxelBoundsShader } from './shaders/voxel-bounds.wgsl.js';
import { BOUNDS_UNIFORM_BYTES } from './volume-uniforms.js';

/** GPU objects owned by one VoxelLayer instance while its bounds are visible. */
export interface VoxelBoundsResources {
  /** Draws the twelve line segments that join the grid's eight corners. */
  readonly model: Model;

  /** Settings for solid edges that are drawn after the volume. */
  readonly front: Buffer;

  /** Settings for dashed edges that are drawn before the volume. */
  readonly rear: Buffer;
}

/**
 * Creates the line model and two settings buffers. Both draws are submitted together,
 * so the front and rear draws each need a buffer with their own pass flag.
 * Frees any buffers already created if a later allocation fails.
 * @param device - The layer's WebGPU device.
 * @param id - Owning layer identifier.
 * @returns Owned resources. Release them with {@link destroyVoxelBounds}.
 * @throws {Error} If a GPU object cannot be allocated.
 */
export function createVoxelBounds(device: Device, id: string): VoxelBoundsResources {
  const bufferProps = {
    byteLength: BOUNDS_UNIFORM_BYTES,
    usage: Buffer.UNIFORM | Buffer.COPY_DST,
  };
  const front = device.createBuffer({ ...bufferProps, id: `${id}-bounds-front` });
  let rear: Buffer | undefined;

  try {
    rear = device.createBuffer({ ...bufferProps, id: `${id}-bounds-rear` });
    const model = new Model(device, {
      id: `${id}-bounds`,
      source: voxelBoundsShader,
      topology: 'line-list',
      vertexCount: 24,
      shaderLayout: {
        attributes: [],
        bindings: [{ name: 'outline', type: 'uniform', group: 0, location: 0 }],
      },
    });

    return { model, front, rear };
  } catch (error) {
    front.destroy();
    rear?.destroy();
    throw error;
  }
}

/**
 * Frees the GPU objects used to draw the grid's bounds.
 * @param resources - Objects allocated by {@link createVoxelBounds}.
 */
export function destroyVoxelBounds(resources: VoxelBoundsResources): void {
  resources.model.destroy();
  resources.front.destroy();
  resources.rear.destroy();
}
