import { CompositeLayer, type DefaultProps } from '@deck.gl/core';
import { CellLayer } from './rendering/cell-layer.js';
import { RaymarchVoxelLayer } from './rendering/raymarch-layer.js';
import type { RaymarchVoxelLayerProps, VoxelCellLayerProps, VoxelLayerProps } from './types.js';

type SharedDefaults = {
  coordinateSystem: VoxelLayerProps['coordinateSystem'];
  renderMode: VoxelLayerProps['renderMode'];
  valueRange: RaymarchVoxelLayerProps['valueRange'];
  clipBounds: RaymarchVoxelLayerProps['clipBounds'];
  physicalClipBounds: VoxelCellLayerProps['physicalClipBounds'];
};

/** Common defaults leave renderer-specific clipping and GPU settings to the selected child. */
const defaultProps: DefaultProps<SharedDefaults> = {
  coordinateSystem: 'cartesian',
  renderMode: 'volume',
  valueRange: { type: 'array', value: undefined, optional: true, compare: true },
  clipBounds: { type: 'array', value: undefined, optional: true, compare: true },
  physicalClipBounds: { type: 'array', value: undefined, optional: true, compare: true },
};

/**
 * Draws a dense grid as a translucent volume or isosurface or a prepared mesh as opaque cells.
 * The default volume mode requires volume; cells mode requires mesh and palette.
 * Dense clipBounds are normalized fractions. Cells use physicalClipBounds in common XY and physical-meter Z.
 * Input arrays remain caller-owned. Renderer children own and release their GPU resources.
 * Switching to a new complete props object with the same layer ID retires the previous renderer.
 * Camera and style updates preserve unchanged data and the selected renderer's resource caches.
 *
 * @example
 * new VoxelLayer({
 *   id: 'density',
 *   volume: { values: new Float32Array(8).fill(0.5), dimensions: [2, 2, 2] },
 * });
 */
export class VoxelLayer extends CompositeLayer<VoxelLayerProps> {
  static override layerName = 'VoxelLayer';
  static override defaultProps = defaultProps;

  /** Accepts one complete mode-specific configuration; use a fresh object when switching renderers. */
  constructor(props: VoxelLayerProps) {
    super({ ...props, pickable: props.pickable ?? props.renderMode === 'cells' });
  }

  /** Returns the displayed cell envelope without allocating a device; dense grids return null. */
  override getBounds(): [number[], number[]] | null {
    return this.props.renderMode === 'cells' ? (this.renderLayers().getBounds() ?? null) : null;
  }

  /** Creates only the selected renderer; dense mode changes share a child ID to retain uploaded textures. */
  override renderLayers(): CellLayer | RaymarchVoxelLayer {
    const props = this.props;
    if (props.renderMode === 'cells') {
      if (!props.mesh || !(props.palette instanceof Uint8Array) || props.volume !== undefined) {
        throw new Error('Cells mode requires a prepared mesh and palette, without a dense volume.');
      }
      if (props.clipBounds !== undefined) {
        throw new Error(
          'Cells mode uses physicalClipBounds; clipBounds is reserved for dense grids.',
        );
      }
      const { renderMode: _renderMode, physicalClipBounds, ...cells } = props;
      const child = this.getSubLayerProps({ id: 'cells' });
      return new CellLayer(cells, child, {
        parameters: { ...CellLayer.defaultProps.parameters, ...child.parameters },
        ...(physicalClipBounds ? { clipBounds: physicalClipBounds } : {}),
      });
    }
    if (props.renderMode !== 'volume' && props.renderMode !== 'isosurface') {
      throw new Error('renderMode must be volume, isosurface or cells.');
    }
    if (
      props.mesh !== undefined ||
      props.palette !== undefined ||
      props.physicalClipBounds !== undefined
    ) {
      throw new Error('Dense modes use volume and normalized clipBounds, without cell inputs.');
    }
    const child = this.getSubLayerProps({ id: 'raymarch' });
    return new RaymarchVoxelLayer(props, child, {
      parameters: { ...RaymarchVoxelLayer.defaultProps.parameters, ...child.parameters },
    });
  }
}
