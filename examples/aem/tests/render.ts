import { Deck, OrbitView } from '@deck.gl/core';
import { webgpuAdapter } from '@luma.gl/webgpu';
import { Matrix4 } from '@math.gl/core';
import { CellLayer, prepareCellMesh } from 'deck.gl-voxel';

const mesh = await prepareCellMesh(
  {
    dimensions: [3, 1, 2],
    origin: [-3, -1, -2],
    spacing: [2, 2, 2],
    values: new Float32Array([0.1, 0.1, 0.1, 0.9, 0.9, 0.9]),
    valueDimensions: [3, 1, 2],
    valueScale: 1,
    validity: new Uint8Array([1, 0, 1, 1, 0, 1]),
    ground: new Float32Array(3),
    elevationScales: new Float32Array([1]),
  },
  2,
  [0, 1],
);
const deck = new Deck({
  canvas: 'test',
  width: 400,
  height: 400,
  views: new OrbitView({ orbitAxis: 'Z', orthographic: false, near: 0.1, far: 1000 }),
  viewState: { target: [0, 0, 0], rotationX: 30, rotationOrbit: 0, zoom: 5 },
  controller: false,
  useDevicePixels: 1,
  deviceProps: {
    type: 'webgpu',
    adapters: [webgpuAdapter],
    createCanvasContext: { alphaMode: 'premultiplied' },
  },
});
let frames = 0;
deck.setProps({
  onAfterRender: () => {
    frames++;
  },
});
function render(
  options: {
    mask?: number;
    clip?: readonly [number, number, number, number, number, number];
    camera?: number[];
    near?: number;
  } = {},
) {
  frames = 0;
  const layer = new CellLayer({
    id: 'opaque-fixture',
    mesh,
    palette: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]),
    visibleBins: options.mask ?? 3,
    ...(options.clip ? { clipBounds: options.clip } : {}),
  });
  deck.setProps({
    layers: [layer],
    viewState: { target: options.camera ?? [0, 0, 0], rotationX: 30, rotationOrbit: 0, zoom: 5 },
    views: new OrbitView({
      orbitAxis: 'Z',
      orthographic: false,
      near: options.near ?? 0.1,
      far: 1000,
    }),
  });
  return layer;
}
Object.assign(window, {
  cellFixture: {
    deck,
    mesh,
    render,
    nearPoint(x: number, y: number) {
      return new Matrix4(deck.getViewports()[0].viewProjectionMatrix)
        .invert()
        .transformAsPoint([x / 200 - 1, 1 - y / 200, -1]);
    },
    get frames() {
      return frames;
    },
  },
});
render();
