import type { VoxelData } from 'deck.gl-voxel';
import { ChunkCache } from './chunk-cache.js';
import type { ZarrVolume } from './zarr-volume.js';

/** Keeps decoded frames for readers that do not support viewport reads. */
export class FrameCache {
  private readonly cache: ChunkCache<number, VoxelData>;

  constructor(
    private readonly reader: ZarrVolume,
    maxBytes: number,
  ) {
    this.cache = new ChunkCache({
      maxBytes,
      load: (index, signal) => reader.readFrame(index, signal),
      byteLength: (volume) => volume.values.buffer.byteLength,
    });
  }

  /** Number of frames in the dataset. */
  get frameCount(): number {
    return this.reader.frameCount;
  }

  /** Whether every frame is ready to play from memory. */
  get isComplete(): boolean {
    return this.cache.size === this.frameCount;
  }

  /** Whether a frame can be drawn without fetching it. */
  has(index: number): boolean {
    return this.cache.has(index);
  }

  /** Shares a frame read without transferring cancellation ownership between callers. */
  read(index: number, signal: AbortSignal): Promise<VoxelData> {
    return this.cache.read(index, signal);
  }
}
