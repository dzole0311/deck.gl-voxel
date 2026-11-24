import type { Vector3, VoxelGeometry } from 'deck.gl-voxel';

/** State of one logical chunk for the most recent foreground view. These are not HTTP request counts. */
export interface ZarrDebugChunk {
  readonly id: string;
  /** Contribution bounds in normalized output-grid coordinates, before the interpolation halo. */
  readonly min: Vector3;
  readonly max: Vector3;
  readonly selected: boolean;
  readonly priority: number;
  readonly status: 'outside' | 'queued' | 'loading' | 'ready' | 'cached' | 'cancelled' | 'error';
}

/** Read-only loading diagnostics. Cache bytes exclude displayed grids, GPU resources and in-flight decoding. */
export interface ZarrDebugState {
  readonly frameIndex: number;
  readonly geometry: VoxelGeometry;
  readonly chunks: readonly ZarrDebugChunk[];
  readonly cacheBytes: number;
  readonly maxCacheBytes: number;
  readonly reusedView: boolean;
}
