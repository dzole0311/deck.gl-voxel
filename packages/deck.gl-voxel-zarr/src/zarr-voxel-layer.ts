import { CompositeLayer } from '@deck.gl/core';
import {
  CollectionLoadingLayer,
  type CollectionLoadingLayerProps,
} from './loading/collection-loading-layer.js';
import { equalFieldSelection, equalOptions } from './loading/prop-comparison.js';
import { fetchZarrRequest } from './loading/request.js';
import {
  VolumeLoadingLayer,
  type VolumeLoadingLayerProps,
} from './loading/volume-loading-layer.js';
import type { ZarrLoadOptions } from './types.js';

export type {
  ZarrCollectionSource,
  ZarrCollectionSourceOptions,
} from './loading/collection-loading-layer.js';
export type { ZarrVolumeSourceOptions } from './loading/volume-loading-layer.js';
export type { ZarrFetch, ZarrFetchContext, ZarrLoadOptions, ZarrSourceContext } from './types.js';

/** Loads a dense field for ray marching or a sparse collection for stock cuboids. */
export type ZarrVoxelLayerProps = VolumeLoadingLayerProps | CollectionLoadingLayerProps;

/**
 * Loads Zarr data and draws it with the selected VoxelLayer backend.
 * Pass a URL, an opened readable store, or a cancellable store opener.
 * GeoZarr describes field geometry; storage backends such as Icechunk provide bytes.
 * The layer owns its readers and cancellation. Callbacks borrow readers for diagnostics only.
 * Reuse the layer ID to keep caches, and pass a complete new layer to change render modes.
 */
export class ZarrVoxelLayer extends CompositeLayer<ZarrVoxelLayerProps> {
  static override layerName = 'ZarrVoxelLayer';
  static override defaultProps = {
    coordinateSystem: 'cartesian',
    renderMode: 'volume',
    fetch: { type: 'function', value: fetchZarrRequest, compare: true },
    sourceOptions: { type: 'object', value: undefined, equal: equalOptions },
    loadOptions: { type: 'object', value: undefined, equal: equalOptions },
    valueRange: { type: 'array', value: [0, 1], compare: true },
    physicalClipBounds: { type: 'array', value: undefined, optional: true, compare: true },
    selectedFields: { type: 'object', value: undefined, equal: equalFieldSelection },
  };

  /** Keeps the byte-request hook type separate from Deck's generic fetch signature. */
  constructor(props: ZarrVoxelLayerProps);
  constructor(props: Pick<ZarrVoxelLayerProps, 'pickable' | 'renderMode'>) {
    super({ ...props, pickable: props.pickable ?? props.renderMode === 'cells' });
  }

  override getLoadOptions(): ZarrLoadOptions {
    return this.props.loadOptions ?? {};
  }

  override renderLayers(): CollectionLoadingLayer | VolumeLoadingLayer {
    const props = this.props;
    if (props.renderMode === 'cells') {
      return new CollectionLoadingLayer({
        ...props,
        ...this.getSubLayerProps({ id: 'collection' }),
      });
    }
    return new VolumeLoadingLayer({
      ...props,
      ...this.getSubLayerProps({ id: 'frames' }),
    });
  }
}
