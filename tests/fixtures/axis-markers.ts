import type { VoxelData } from 'deck.gl-voxel';

/** Creates unequal grid axes with separate scalar markers near positive X, Y and Z. */
export function createAxisMarkerVolume(): VoxelData {
  const dimensions = [48, 32, 24] as const;
  const values = new Float32Array(dimensions[0] * dimensions[1] * dimensions[2]);

  for (let z = 0; z < dimensions[2]; z++) {
    for (let y = 0; y < dimensions[1]; y++) {
      for (let x = 0; x < dimensions[0]; x++) {
        const u = (x + 0.5) / dimensions[0];
        const v = (y + 0.5) / dimensions[1];
        const w = (z + 0.5) / dimensions[2];

        values[x + dimensions[0] * (y + dimensions[1] * z)] =
          u > 0.75 && v < 0.25 && w < 0.25
            ? 0
            : v > 0.75 && u < 0.25 && w < 0.25
              ? 0.5
              : w > 0.75 && u < 0.25 && v < 0.25
                ? 1
                : Number.NaN;
      }
    }
  }

  return {
    values,
    dimensions,
    origin: [-24, -20, -18],
    spacing: [1, 1.25, 1.5],
  };
}

/** Maps the X, Y and Z marker values to opaque red, green and blue. */
export function createAxisMarkerPalette(): Uint8Array {
  const table = new Uint8Array(256 * 4);

  for (let index = 0; index < 256; index++) {
    const value = index / 255;
    const color =
      value < 0.25 ? [255, 40, 40, 255] : value < 0.75 ? [40, 255, 80, 255] : [40, 100, 255, 255];
    table.set(color, index * 4);
  }

  return table;
}
