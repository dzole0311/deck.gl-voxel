import { CompositeLayer, type UpdateParameters, type Viewport } from '@deck.gl/core';
import { type VoxelCellLayerProps, VoxelLayer } from 'deck.gl-voxel';
import { GeoZarrCollection, type GeoZarrCollectionOptions } from '../readers/geozarr-collection.js';
import type { ZarrStoreInput } from '../storage/zarr-store.js';
import type { ZarrFetch, ZarrLoadOptions } from '../types.js';
import { equalFieldSelection, equalOptions } from './prop-comparison.js';
import { createZarrTransport } from './request.js';

type SourceOptions<T> = T extends unknown
  ? Omit<T, 'bins' | 'valueRange' | 'signal' | 'fetch' | 'maxCacheBytes' | 'maxRequests'>
  : never;

/** Selects a GeoZarr field or collection; opened stores own their byte transport. */
export type ZarrCollectionSourceOptions = SourceOptions<GeoZarrCollectionOptions>;

/** A URL, opened readable store, or cancellable opener such as IcechunkStore.open. */
export type ZarrCollectionSource =
  ZarrStoreInput | ((signal: AbortSignal) => Promise<ZarrStoreInput>);

/** URL-backed opaque cells, with loading and disposal owned by the layer. */
export type CollectionLoadingLayerProps = Omit<
  VoxelCellLayerProps,
  'mesh' | 'fetch' | 'loadOptions'
> & {
  source: ZarrCollectionSource;
  sourceOptions: ZarrCollectionSourceOptions;
  /** Values mapped to the first and last palette bins. @default [0, 1] */
  valueRange?: readonly [number, number];
  /** Displayed fields; omitted means every configured field. */
  selectedFields?: ReadonlySet<string>;
  /** Decoded CPU cache budget. @default 201326592 */
  maxCacheBytes?: number;
  /** Concurrent logical chunk reads. @default 6 */
  maxRequests?: number;
  fetch?: ZarrFetch;
  loadOptions?: ZarrLoadOptions;
  /** Borrows the opened collection for inspection; callers must not dispose or drive it. */
  onSourceLoad?: (collection: GeoZarrCollection) => void;
  /** Batched progress for UI, picking and diagnostics; the layer still owns loading. */
  onSourceUpdate?: (collection: GeoZarrCollection) => void;
};

interface Lifecycle {
  opening: AbortController | undefined;
  reader: GeoZarrCollection | undefined;
  unsubscribe: (() => void) | undefined;
}

/** Owns a sparse collection while stock mesh sublayers own all GPU resources. */
export class CollectionLoadingLayer extends CompositeLayer<CollectionLoadingLayerProps> {
  static override layerName = 'ZarrCollectionLayer';
  static override defaultProps = {
    sourceOptions: { type: 'object', value: undefined, equal: equalOptions },
    selectedFields: { type: 'object', value: undefined, equal: equalFieldSelection },
    valueRange: { type: 'array', value: [0, 1], compare: true },
    physicalClipBounds: { type: 'array', value: undefined, optional: true, compare: true },
  };

  declare state: { lifecycle: Lifecycle; revision: number };

  private get current(): CollectionLoadingLayer {
    const current = this.getCurrentLayer();
    return current instanceof CollectionLoadingLayer ? current : this;
  }

  override initializeState(): void {
    this.setState({
      lifecycle: { opening: undefined, reader: undefined, unsubscribe: undefined },
      revision: 0,
    });
  }

  override get isLoaded(): boolean {
    const stats = this.state?.lifecycle.reader?.getStats();
    return super.isLoaded && Boolean(stats && !stats.active && !stats.queued);
  }

  override shouldUpdateState(params: UpdateParameters<this>): boolean {
    return super.shouldUpdateState(params) || Boolean(params.changeFlags.viewportChanged);
  }

  override updateState({ props, oldProps, changeFlags }: UpdateParameters<this>): void {
    const lifecycle = this.state.lifecycle;
    const sourceChanged =
      !lifecycle.opening ||
      props.source !== oldProps.source ||
      !equalOptions(props.sourceOptions, oldProps.sourceOptions) ||
      props.palette.length !== oldProps.palette?.length ||
      !equalOptions(props.valueRange, oldProps.valueRange) ||
      props.fetch !== oldProps.fetch ||
      !equalOptions(props.loadOptions, oldProps.loadOptions) ||
      props.maxCacheBytes !== oldProps.maxCacheBytes ||
      props.maxRequests !== oldProps.maxRequests;
    if (sourceChanged) {
      this.closeCollection();
      const opening = new AbortController();
      lifecycle.opening = opening;
      void this.openCollection(opening);
    } else if (
      changeFlags?.viewportChanged ||
      props.visible !== oldProps.visible ||
      props.exaggeration !== oldProps.exaggeration ||
      !equalFieldSelection(props.selectedFields, oldProps.selectedFields)
    ) {
      this.updateCollection();
    }
  }

  private async openCollection(opening: AbortController): Promise<void> {
    const { signal } = opening;
    const props = this.props;
    const lifecycle = this.state.lifecycle;
    let reader: GeoZarrCollection | undefined;
    try {
      signal.throwIfAborted();
      const input = typeof props.source === 'function' ? await props.source(signal) : props.source;
      signal.throwIfAborted();
      reader = await GeoZarrCollection.open(input, {
        ...props.sourceOptions,
        bins: props.palette.length / 4,
        valueRange: props.valueRange ?? [0, 1],
        signal,
        ...(typeof input === 'string'
          ? { fetch: createZarrTransport(this.parent ?? this, props.fetch, props.loadOptions) }
          : {}),
        ...(props.maxCacheBytes !== undefined ? { maxCacheBytes: props.maxCacheBytes } : {}),
        ...(props.maxRequests !== undefined ? { maxRequests: props.maxRequests } : {}),
      });
      if (signal.aborted) {
        reader.dispose();
        return;
      }
      const collection = reader;
      lifecycle.reader = collection;
      collection.setPaused(this.current.props.visible === false);
      lifecycle.unsubscribe = collection.subscribe(() => {
        if (signal.aborted) {
          return;
        }
        const current = this.current;
        current.setState({ revision: current.state.revision + 1 });
        current.props.onSourceUpdate?.(collection);
      });
      const current = this.current;
      current.props.onSourceLoad?.(collection);
      current.updateCollection();
      current.setState({ revision: current.state.revision + 1 });
      current.props.onSourceUpdate?.(collection);
    } catch (error: unknown) {
      if (reader && lifecycle.reader !== reader) {
        reader.dispose();
      }
      if (!signal.aborted) {
        this.current.raiseError(
          error instanceof Error ? error : new Error(String(error)),
          'opening GeoZarr collection',
        );
      }
    }
  }

  /** Hidden layers keep an old activated view, so ask Deck for the current version of that view. */
  private viewport(): Viewport | undefined {
    const active = this.context.viewport;
    return (
      this.context.deck?.getViewports().find((viewport) => viewport.id === active?.id) ?? active
    );
  }

  /** Updates the retained selection before resuming, so a hidden pan cannot fetch its old view. */
  private updateCollection(): void {
    const reader = this.state.lifecycle.reader;
    if (!reader) {
      return;
    }
    const hidden = this.props.visible === false;
    if (hidden) {
      reader.setPaused(true);
    }
    const viewport = this.viewport();
    if (viewport) {
      reader.update(viewport, this.props.exaggeration ?? 1, this.props.selectedFields);
    }
    if (!hidden) {
      reader.setPaused(false);
    }
  }

  override renderLayers(): VoxelLayer[] {
    return (this.state.lifecycle.reader?.getTiles() ?? [])
      .filter((tile) => tile.mesh.count > 0)
      .map(
        (tile) =>
          new VoxelLayer({
            ...this.getSubLayerProps({ id: tile.id }),
            renderMode: 'cells',
            mesh: tile.mesh,
            palette: this.props.palette,
            exaggeration: this.props.exaggeration ?? 1,
            visibleBins: this.props.visibleBins ?? 0xffffffff,
            ...(this.props.physicalClipBounds
              ? { physicalClipBounds: this.props.physicalClipBounds }
              : {}),
          }),
      );
  }

  private closeCollection(): void {
    const lifecycle = this.state.lifecycle;
    lifecycle.unsubscribe?.();
    lifecycle.unsubscribe = undefined;
    lifecycle.reader?.dispose();
    lifecycle.reader = undefined;
    lifecycle.opening?.abort();
    lifecycle.opening = undefined;
  }

  override finalizeState(): void {
    this.closeCollection();
  }
}
