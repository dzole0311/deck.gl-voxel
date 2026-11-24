import { Deck, MapView, OrbitView } from '@deck.gl/core';
import { webgpuAdapter } from '@luma.gl/webgpu';
import { VoxelDepthEffect, VoxelLayer } from 'deck.gl-voxel';

import { ZarrVoxelLayer } from '../../packages/deck.gl-voxel-zarr/src/index.js';

import { createFixture, createLut } from './fixtures.js';
import { ObstacleLayer } from './obstacle-layer.js';

const depth = new VoxelDepthEffect({ getLayerFilter: (layer) => layer.id === 'obstacle' });
const errors: string[] = [];
const canvas = document.querySelector('canvas');

if (!canvas) {
  throw new Error('The WebGPU test canvas is missing.');
}

const deck = new Deck({
  canvas,
  deviceProps: { type: 'webgpu', adapters: [webgpuAdapter] },
  views: new OrbitView({ orbitAxis: 'Z' }),
  initialViewState: { target: [0, 0, 0], rotationX: 0, rotationOrbit: 0, zoom: 2.5 },
  effects: [depth],
  onError: (error) => {
    errors.push(error.message);
  },
});

Object.assign(window, {
  voxelFixture: {
    deck,
    depth,
    errors,
    createFixture,
    createLut,
    VoxelLayer,
    ZarrVoxelLayer,
    OrbitView,
    MapView,
    ObstacleLayer,
  },
});

window.addEventListener('pagehide', () => deck.finalize(), { once: true });
