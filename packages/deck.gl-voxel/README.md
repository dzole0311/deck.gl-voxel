`deck.gl-voxel` renders translucent volumes and isosurfaces by ray marching or opaque cells with stock deck.gl meshes.

```ts
import { VoxelLayer } from 'deck.gl-voxel';

const layer = new VoxelLayer({
  id: 'density',
  renderMode: 'volume',
  volume: {
    values: new Float32Array(8).fill(0.5),
    dimensions: [2, 2, 2],
  },
});
```
