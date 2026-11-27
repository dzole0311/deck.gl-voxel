import type { VoxelData } from 'deck.gl-voxel';
import type { ZarrVolume } from '../zarr-volume.js';
import { ChunkCache } from './chunk-cache.js';

/** Caches whole frames when camera reads are unavailable */
export class FrameCache {
  private readonly cache: ChunkCache<number, VoxelData>;

  constructor(
    private readonly reader: ZarrVolume,
    maxBytes: number,
    maxRequests = 6,
  ) {
    this.cache = new ChunkCache({
      maxBytes,
      maxRequests,
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

  /** Whether the frame is already in the cache */
  has(index: number): boolean {
    return this.cache.has(index);
  }

  /** Shares a frame read while allowing each caller to cancel its own wait */
  read(index: number, signal: AbortSignal): Promise<VoxelData> {
    return this.cache.read(index, signal);
  }
}
