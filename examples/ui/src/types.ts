import type { VoxelGeometry } from 'deck.gl-voxel';
import type { ZarrVolume } from 'deck.gl-voxel-zarr';

/** Connects an example's current camera and reader to the shared inspector without owning either. */
export interface ChunkInspectorView {
  getReader(): ZarrVolume | undefined;
  /** Uses exactly the placement and camera transforms supplied to the renderer. */
  getVolumeToClip(geometry: VoxelGeometry): readonly number[] | undefined;
  /** Display placement in the renderer's common space, including vertical exaggeration. */
  getVolumeToCommon(geometry: VoxelGeometry): readonly number[] | undefined;
  getViewport(): { x: number; y: number; width: number; height: number } | undefined;
  /** Subscribes to camera, placement and source changes; the returned function removes the listener. */
  subscribe(listener: () => void): () => void;
}
