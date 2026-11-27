import {
  CompositeLayer,
  type GetPickingInfoParams,
  type PickingInfo,
  type UpdateParameters,
  Viewport,
} from '@deck.gl/core';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import type { CellMesh } from '../data/cell-mesh.js';
import { type CellClipBounds, getCellMeshBounds } from '../geometry/cell-bounds.js';
import type { Vector3, VoxelCellLayerProps } from '../types.js';
import { type CellAttributes, prepareCellAttributes } from './cell-attributes.js';

/** Renders an immutable cell mesh. Callers retain input arrays; sublayers release GPU resources. */
export type CellLayerProps = Omit<
  VoxelCellLayerProps,
  'renderMode' | 'volume' | 'clipBounds' | 'physicalClipBounds'
> & {
  /** Kept common X/Y and physical-meter Z bounds, applied before exaggeration. */
  readonly clipBounds?: CellClipBounds;
};

const commonViewports = new WeakMap<Viewport, Map<string, Viewport>>();
/** Swaps local X/Z so one height float can supply a stock matrix column without storing two zeroes per run. */
const cellBasis = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1];

/**
 * Keeps the map camera while treating prepared XYZ as deck.gl common units.
 * A map viewport would scale Z from meters again. Tiles sharing an XY origin reuse this adapter.
 */
function commonViewport(viewport: Viewport, origin: Vector3): Viewport {
  let origins = commonViewports.get(viewport);
  if (!origins) {
    origins = new Map();
    commonViewports.set(viewport, origins);
  }
  const key = `${origin[0]},${origin[1]}`;
  let common = origins.get(key);
  if (!common) {
    common = new Viewport({
      id: `${viewport.id}-common-cells-${key}`,
      x: viewport.x,
      y: viewport.y,
      width: viewport.width,
      height: viewport.height,
      zoom: viewport.zoom,
      position: [
        (viewport.center[0] ?? 0) - origin[0],
        (viewport.center[1] ?? 0) - origin[1],
        (viewport.center[2] ?? 0) - origin[2],
      ],
      viewMatrix: viewport.viewMatrixUncentered,
      projectionMatrix: viewport.projectionMatrix,
      focalDistance: viewport.focalDistance,
    });
    origins.set(key, common);
  }
  return common;
}

type CommonSpaceMeshProps = { readonly cellAttributes: CellAttributes };

/** Adapts public attribute and projection inputs; SimpleMeshLayer retains its stock shaders and GPU lifetime. */
class CommonSpaceMeshLayer extends SimpleMeshLayer<unknown, CommonSpaceMeshProps> {
  static override layerName = 'CommonSpaceMeshLayer';
  declare state: SimpleMeshLayer['state'] & { scaleSize?: 1 | 6 };

  /** Uses one local float32 position stream and a broadcast zero row instead of a low-part tuple per run. */
  override initializeState(): void {
    super.initializeState();
    const manager = this.getAttributeManager();
    if (!manager) {
      throw new Error('Cell mesh requires a primitive attribute manager.');
    }
    manager.remove(['instancePositions']);
    manager.addInstanced({
      instancePositions: { size: 3, type: 'float32', accessor: 'getPosition' },
      instancePositions64Low: {
        size: 3,
        type: 'float32',
        noAlloc: true,
        update: (attribute) => {
          attribute.constant = true;
          attribute.value = new Float32Array(3);
        },
      },
    });
    this.configureScaleAttributes();
  }

  override updateState(params: UpdateParameters<this>): void {
    if (this.state.scaleSize !== params.props.cellAttributes.scaleSize) {
      this.configureScaleAttributes();
    }
    super.updateState(params);
  }

  /**
   * Binds stock matrix columns to height alone, or height and XY sizes for cut footprints.
   * WebGPU fills missing vector components with zero. `noAlloc` keeps constant rows from allocating per-run buffers.
   * Updaters read the current layer through `this` because deck.gl transfers state between layer objects.
   */
  private configureScaleAttributes(): void {
    const manager = this.getAttributeManager();
    if (!manager) {
      throw new Error('Cell mesh requires a primitive attribute manager.');
    }
    const { scaleSize } = this.props.cellAttributes;
    manager.remove([
      'instanceModelMatrix',
      'instanceScales',
      'instanceModelMatrixCol1',
      'instanceModelMatrixCol2',
      'instanceTranslation',
    ]);
    manager.addInstanced({
      instanceScales: {
        size: scaleSize,
        type: 'float32',
        noAlloc: true,
        shaderAttributes: {
          instanceModelMatrixCol0: { size: 1, elementOffset: 0 },
          ...(scaleSize === 6
            ? {
                instanceModelMatrixCol1: { size: 2, elementOffset: 1 },
                instanceModelMatrixCol2: { size: 3, elementOffset: 3 },
              }
            : {}),
        },
      },
      instanceTranslation: {
        size: 3,
        type: 'float32',
        noAlloc: true,
        accessor: 'getTranslation',
      },
    });
    if (scaleSize === 1) {
      manager.addInstanced({
        instanceModelMatrixCol1: {
          size: 2,
          type: 'float32',
          noAlloc: true,
          update: function (this: CommonSpaceMeshLayer, attribute) {
            attribute.constant = true;
            attribute.value = new Float32Array([0, this.props.cellAttributes.footprint[1]]);
          },
        },
        instanceModelMatrixCol2: {
          size: 3,
          type: 'float32',
          noAlloc: true,
          update: function (this: CommonSpaceMeshLayer, attribute) {
            attribute.constant = true;
            attribute.value = new Float32Array([0, 0, this.props.cellAttributes.footprint[0]]);
          },
        },
      });
    }
    this.setState({ scaleSize });
  }

  /** Sets stock unlit material props because deck.gl 9.4 treats material:false as default Phong lighting. */
  override setShaderModuleProps(
    ...args: Parameters<SimpleMeshLayer['setShaderModuleProps']>
  ): void {
    const [props] = args;
    const inputs = { ...props, phongMaterial: { ...props.phongMaterial, unlit: true } };
    const viewport = props.project?.viewport;
    super.setShaderModuleProps(
      viewport instanceof Viewport
        ? {
            ...inputs,
            project: {
              ...props.project,
              viewport: commonViewport(viewport, this.props.coordinateOrigin),
            },
          }
        : inputs,
    );
  }
}

/**
 * Builds a closed indexed cube in the layer's Z/Y/X basis, with darker side faces.
 * Only CPU geometry is shared; each stock sublayer creates and releases its own GPU copy.
 */
function unitCube() {
  const faces = [
    [0, 2, 1, 3],
    [4, 5, 6, 7],
    [0, 1, 4, 5],
    [2, 6, 3, 7],
    [0, 4, 2, 6],
    [1, 3, 5, 7],
  ];
  const faceNormals = [
    [0, 0, -1],
    [0, 0, 1],
    [0, -1, 0],
    [0, 1, 0],
    [-1, 0, 0],
    [1, 0, 0],
  ];
  const positions = new Float32Array(24 * 3),
    normals = new Float32Array(24 * 3),
    colors = new Float32Array(24 * 3),
    indices = new Uint16Array(36);
  for (const [face, corners] of faces.entries()) {
    const normal = faceNormals[face] ?? [0, 0, 1];
    for (const [vertex, corner] of corners.entries()) {
      const offset = (face * 4 + vertex) * 3;
      positions.set(
        [((corner >> 2) & 1) - 0.5, ((corner >> 1) & 1) - 0.5, (corner & 1) - 0.5],
        offset,
      );
      normals.set([normal[2] ?? 0, normal[1] ?? 0, normal[0] ?? 0], offset);
      colors.fill(face < 2 ? 1 : 0.84, offset, offset + 3);
    }
    indices.set(
      [0, 1, 2, 2, 1, 3].map((vertex) => face * 4 + vertex),
      face * 6,
    );
  }
  return {
    indices: { size: 1, value: indices },
    attributes: {
      positions: { size: 3, value: positions },
      normals: { size: 3, value: normals },
      colors: { size: 3, value: colors },
    },
  };
}

const cube = unitCube();
/** A distinct mesh identity makes SimpleMeshLayer rebuild its model when cuts need per-run XY sizes. */
const slicedCube = { ...cube };

interface PreparedCells {
  readonly exaggeration: number;
  readonly visibleBins: number;
  readonly clipBounds: CellClipBounds | undefined;
  readonly palette: Uint8Array;
  /** Coarse common-space XY offset shared by nearby tiles; Z stays unshifted. */
  readonly commonOrigin: Vector3;
  readonly geometry: CellAttributes;
  readonly data: {
    readonly length: number;
    readonly attributes: {
      readonly getPosition: { readonly value: Float32Array | Float64Array; readonly size: number };
      readonly instanceScales: { readonly value: Float32Array; readonly size: number };
      readonly getColor: {
        readonly value: Uint8Array;
        readonly size: number;
        readonly normalized: true;
      };
    };
  };
  readonly bytes: number;
  readonly preparationMs: number;
}

/** Holds the latest conversion per retained source mesh; source-cache eviction lets the entry be collected. */
const preparedMeshes = new WeakMap<CellMesh, PreparedCells>();

function sameBounds(a: CellClipBounds | undefined, b: CellClipBounds | undefined): boolean {
  return a === b || Boolean(a && b && a.every((value, index) => value === b[index]));
}

/**
 * Reuses geometry for palette-only updates and camera movement.
 * XY is rebased before float32 conversion because stock shaders add cube corners before subtracting the camera origin.
 * Small footprints would otherwise lose precision at large map coordinates.
 */
function prepare(props: CellLayerProps): PreparedCells {
  const { mesh, palette, clipBounds } = props;
  const exaggeration = props.exaggeration ?? 1,
    visibleBins = props.visibleBins ?? 0xffffffff;
  if (palette.length < 4 || palette.length > 128 || palette.length !== mesh.binCount * 4) {
    throw new Error('CellLayer requires one RGBA palette entry per mesh bin.');
  }
  const cached = preparedMeshes.get(mesh);
  const sameGeometry =
    cached &&
    cached.exaggeration === exaggeration &&
    cached.visibleBins === visibleBins &&
    sameBounds(cached.clipBounds, clipBounds);
  if (sameGeometry && cached.palette === palette) {
    return cached;
  }
  const start = performance.now();
  const commonOrigin: Vector3 = cached?.commonOrigin ?? [
    Math.floor(mesh.grid.origin[0]),
    Math.floor(mesh.grid.origin[1]),
    0,
  ];
  let geometry: CellAttributes;
  if (sameGeometry) {
    geometry = cached.geometry;
  } else {
    const localMesh: CellMesh = {
      ...mesh,
      grid: {
        ...mesh.grid,
        origin: [
          mesh.grid.origin[0] - commonOrigin[0],
          mesh.grid.origin[1] - commonOrigin[1],
          mesh.grid.origin[2],
        ],
      },
    };
    const localClip: CellClipBounds | undefined = clipBounds
      ? [
          clipBounds[0] - commonOrigin[0],
          clipBounds[1] - commonOrigin[1],
          clipBounds[2],
          clipBounds[3] - commonOrigin[0],
          clipBounds[4] - commonOrigin[1],
          clipBounds[5],
        ]
      : undefined;
    geometry = prepareCellAttributes(localMesh, exaggeration, visibleBins, localClip, 'float32');
  }
  const colors = new Uint8Array(geometry.count * 4);
  for (let instance = 0; instance < geometry.count; instance++) {
    const run = geometry.runIndices[instance] ?? 0,
      source = (mesh.instances[run * 8 + 5] ?? 0) * 4,
      target = instance * 4;
    colors[target] = palette[source] ?? 0;
    colors[target + 1] = palette[source + 1] ?? 0;
    colors[target + 2] = palette[source + 2] ?? 0;
    colors[target + 3] = 255;
  }
  const attributes: PreparedCells['data']['attributes'] = {
    getPosition: sameGeometry
      ? cached.data.attributes.getPosition
      : { value: geometry.positions, size: 3 },
    instanceScales: sameGeometry
      ? cached.data.attributes.instanceScales
      : { value: geometry.scales, size: geometry.scaleSize },
    getColor: { value: colors, size: 4, normalized: true },
  };
  const result: PreparedCells = {
    exaggeration,
    visibleBins,
    clipBounds: clipBounds
      ? [clipBounds[0], clipBounds[1], clipBounds[2], clipBounds[3], clipBounds[4], clipBounds[5]]
      : undefined,
    palette,
    commonOrigin,
    geometry,
    data: { length: geometry.count, attributes },
    bytes: geometry.bytes + colors.byteLength,
    preparationMs: performance.now() - start,
  };
  preparedMeshes.set(mesh, result);
  return result;
}

/**
 * Closed instanced cuboids rendered with unmodified SimpleMeshLayer shaders.
 * Axis-aligned clipping rebuilds compact attributes and closes the exposed physical cut faces before exaggeration.
 * The camera near plane remains uncapped; inside-cell views and picking use the visible exit surfaces.
 * Stable local common-space origins preserve small footprints without camera-dependent buffer rebuilds.
 * Pass new mesh, palette and clip-bound objects when inputs change. Converted CPU attributes are weakly cached
 * by source mesh identity; stock sublayers own and release every GPU resource.
 * GPU picking identifies a source run; CPU picking resolves its native cell index and displayed level's stored value.
 */
export class CellLayer extends CompositeLayer<CellLayerProps> {
  static override layerName = 'CellLayer';
  static override defaultProps = {
    exaggeration: 1,
    visibleBins: 0xffffffff,
    pickable: false,
    parameters: {
      depthWriteEnabled: true,
      depthCompare: 'less',
      cullMode: 'none',
      blendColorOperation: 'add',
      blendColorSrcFactor: 'one',
      blendColorDstFactor: 'zero',
      blendAlphaOperation: 'add',
      blendAlphaSrcFactor: 'one',
      blendAlphaDstFactor: 'zero',
    },
  };
  declare state: { prepared?: PreparedCells };

  /** Returns the clipped cuboid envelope in displayed common XYZ without a device or encoded attributes. */
  override getBounds(): [number[], number[]] | null {
    const { mesh, clipBounds } = this.props;
    if (!mesh.count) {
      return null;
    }
    const bounds = getCellMeshBounds(mesh, this.props.exaggeration ?? 1, undefined, clipBounds);
    if (bounds[0] >= bounds[3] || bounds[1] >= bounds[4] || bounds[2] >= bounds[5]) {
      return null;
    }
    return [bounds.slice(0, 3), bounds.slice(3)];
  }

  override initializeState(): void {
    if (this.context.device.type !== 'webgpu') {
      throw new Error('CellLayer requires WebGPU.');
    }
    this.setState({});
  }

  override updateState({ props }: UpdateParameters<this>): void {
    this.setState({ prepared: prepare(props) });
  }

  override renderLayers(): CommonSpaceMeshLayer | null {
    const prepared = this.state.prepared;
    if (!prepared?.geometry.count) {
      return null;
    }
    return new CommonSpaceMeshLayer(
      this.getSubLayerProps({
        id: 'cuboids',
        mesh: prepared.geometry.scaleSize === 1 ? cube : slicedCube,
        data: prepared.data,
        cellAttributes: prepared.geometry,
        material: false,
        coordinateSystem: 'cartesian',
        coordinateOrigin: prepared.commonOrigin,
        modelMatrix: cellBasis,
      }),
    );
  }

  override getPickingInfo({ info }: GetPickingInfoParams): PickingInfo {
    const run = this.state.prepared?.geometry.runIndices[info.index];
    info.index = run ?? -1;
    info.object = run === undefined ? undefined : { mesh: this.props.mesh, runIndex: run };
    return info;
  }
}
