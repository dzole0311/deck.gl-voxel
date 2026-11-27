import { type DefaultProps, Layer, type LayerContext, type UpdateParameters } from '@deck.gl/core';
import { type RenderPass, Texture } from '@luma.gl/core';
import type { Model } from '@luma.gl/engine';
import type { RaymarchVoxelLayerProps, VoxelData } from '../types.js';
import {
  createVoxelBounds,
  destroyVoxelBounds,
  type VoxelBoundsResources,
} from './volume-bounds.js';
import {
  DEFAULT_MAX_TEXTURE_BYTES,
  DEFAULT_TRANSFER_FUNCTION,
  validateStyle,
  validateVolume,
} from './volume-input.js';
import {
  createVoxelResources,
  destroyVoxelResources,
  updateTransferTexture,
  type VoxelResources,
} from './volume-resources.js';
import { BOUNDS_OFFSETS, createVoxelUniforms } from './volume-uniforms.js';

/**
 * Blend the volume over what's already drawn. The shader has already multiplied its RGB by alpha.
 * Keep existing depth because a volume pixel can combine samples from several distances.
 */
const defaultProps: DefaultProps<RaymarchVoxelLayerProps> = {
  coordinateSystem: 'cartesian',
  valueRange: { type: 'array', value: [0, 1], compare: true },
  clipBounds: { type: 'array', value: [0, 0, 0, 1, 1, 1], compare: true },
  stepSize: 0.5,
  maxSteps: 2048,
  density: 1,
  showBounds: false,
  sampling: 'linear',
  colorBy: 'value',
  renderMode: 'volume',
  isovalue: 0.5,
  maxTextureBytes: DEFAULT_MAX_TEXTURE_BYTES,
  parameters: {
    depthWriteEnabled: false,
    depthCompare: 'always',
    blendColorOperation: 'add',
    blendColorSrcFactor: 'one',
    blendColorDstFactor: 'one-minus-src-alpha',
    blendAlphaOperation: 'add',
    blendAlphaSrcFactor: 'one',
    blendAlphaDstFactor: 'one-minus-src-alpha',
  },
};

/**
 * Draws a 3D grid on WebGPU by sampling along a camera ray for each pixel.
 * Draw after opaque scene layers. Pass positions in deck.gl's shared Cartesian coordinates or
 * as meter offsets from a map location given by coordinateOrigin.
 * The layer owns the textures it uploads. The caller keeps ownership of the input array
 * and the depth source keeps ownership of the optional depth texture.
 * Pass a new {@link VoxelData} object to upload new values or geometry.
 *
 * @see https://deck.gl/docs/developer-guide/webgpu
 * @see https://deck.gl/docs/developer-guide/custom-layers/layer-lifecycle
 *
 */
export class RaymarchVoxelLayer extends Layer<RaymarchVoxelLayerProps> {
  static override layerName = 'RaymarchVoxelLayer';

  static override defaultProps = defaultProps;

  /** A failed update keeps the layer hidden until its resources match the current props. */
  declare state: {
    resources: VoxelResources | null;
    bounds: VoxelBoundsResources | null;
    ready: boolean;
  };

  /**
   * Sets up the layer without allocating textures until the grid is validated.
   *
   * @throws {Error} If deck.gl was initialized with a non-WebGPU backend.
   */
  override initializeState(): void {
    if (this.context.device.type !== 'webgpu') {
      throw new Error('VoxelLayer requires a WebGPU device.');
    }

    this.setState({ resources: null, bounds: null, ready: false });
    this.getAttributeManager()?.remove(['instancePickingColors']);
  }

  /** Uses its own shader with camera and style settings supplied by createVoxelUniforms. */
  override setShaderModuleProps(): void {}

  /**
   * Gives deck.gl the draw models so it can update render settings and schedule redraws.
   *
   * @returns The current draw models, or an empty array before allocation.
   */
  override getModels(): Model[] {
    const resources = this.state?.resources;
    const bounds = this.state?.bounds;

    if (!resources) {
      return [];
    }

    return bounds ? [resources.model, bounds.model] : [resources.model];
  }

  /**
   * Checks the options and uploads the grid or color ramp when the corresponding object changes.
   * Frees the old grid texture before uploading a replacement to save GPU memory.
   * Keeps the bounds model across frames and releases it when the outline is turned off.
   * @param update - Current layer props from the deck.gl lifecycle.
   * @throws {Error} If validation, allocation, or upload fails.
   */
  override updateState({ props }: UpdateParameters<this>): void {
    this.setState({ ready: false });
    validateStyle(props);

    const device = this.context.device;
    const transferFunction = props.transferFunction ?? DEFAULT_TRANSFER_FUNCTION;

    if (transferFunction.length / 4 > device.limits.maxTextureDimension2D) {
      throw new Error('Transfer function exceeds the device texture limit.');
    }

    validateVolume(
      props.volume,
      device.limits.maxTextureDimension3D,
      props.maxTextureBytes ?? DEFAULT_MAX_TEXTURE_BYTES,
      transferFunction.byteLength,
    );

    if (!this.state.resources || props.volume !== this.state.resources.volumeData) {
      this.releaseResources();
      this.setState({ resources: createVoxelResources(device, props, transferFunction) });
    } else if (transferFunction !== this.state.resources.transferData) {
      updateTransferTexture(device, this.state.resources, transferFunction, props.id);
    }

    if (props.showBounds && !this.state.bounds) {
      this.setState({ bounds: createVoxelBounds(device, props.id) });
    } else if (!props.showBounds && this.state.bounds) {
      this.releaseBounds();
    }

    this.setState({ ready: true });
  }

  /**
   * Sends this view's settings to the GPU and draws into the canvas via deck.gl's render pass.
   * Draws the dashed rear edges first so the volume can cover them, then draws the solid
   * front edges over the volume.
   *
   * @param options - Draw parameters supplied by deck.gl.
   * @param options.renderPass - Where the draw commands go. deck.gl finishes the pass
   * and submits the commands to the GPU.
   * @throws {Error} If the view can't place the grid or the scene depth texture is incompatible.
   */
  override draw({ renderPass }: { renderPass: RenderPass }): void {
    const resources = this.state.resources;
    const canvas = this.context.device.canvasContext;

    if (!resources || !this.state.ready || !canvas) {
      return;
    }

    const viewport = this.context.viewport;
    const canvasSize = canvas.getDrawingBufferSize();
    const [cssWidth] = canvas.getCSSSize();
    const pixelRatio = cssWidth ? canvasSize[0] / cssWidth : 1;
    const depth = this.props.depthSource?.getDepthTexture(viewport.id);

    if (
      depth &&
      (depth.destroyed ||
        depth.device !== this.context.device ||
        depth.width !== canvasSize[0] ||
        depth.height !== canvasSize[1] ||
        depth.dimension !== '2d' ||
        depth.format !== 'depth32float' ||
        !((depth.props.usage ?? 0) & Texture.SAMPLE))
    ) {
      throw new Error(
        'Scene depth must be a sampleable, full-canvas depth32float texture on the same device.',
      );
    }

    const uniforms = createVoxelUniforms(
      this.props,
      viewport,
      canvasSize,
      pixelRatio,
      Boolean(depth),
    );

    const bounds = this.state.bounds;

    if (bounds && uniforms.bounds) {
      bounds.front.write(uniforms.bounds);
      uniforms.bounds[BOUNDS_OFFSETS.rearPass] = 1;
      bounds.rear.write(uniforms.bounds);
      bounds.model.setBindings({ outline: bounds.rear });
      bounds.model.draw(renderPass);
    }

    resources.uniforms.write(uniforms.volume);
    resources.model.setBindings({ sceneDepth: depth ?? resources.emptyDepth });
    resources.model.draw(renderPass);

    if (bounds && uniforms.bounds) {
      bounds.model.setBindings({ outline: bounds.front });
      bounds.model.draw(renderPass);
    }
  }

  /**
   * Releases owned GPU objects before deck.gl disposes its remaining layer state.
   *
   * @param context - Framework context passed to the base layer cleanup.
   */
  override finalizeState(context: LayerContext): void {
    this.releaseBounds();
    this.releaseResources();
    super.finalizeState(context);
  }

  /** Drops the bounds model reference before freeing its GPU objects. */
  private releaseBounds(): void {
    const bounds = this.state.bounds;
    this.state.bounds = null;

    if (bounds) {
      destroyVoxelBounds(bounds);
    }
  }

  /** Drops the model reference before destroying it so deck.gl won't try to free it again. */
  private releaseResources(): void {
    const resources = this.state.resources;

    this.state.resources = null;
    this.state.ready = false;

    if (resources) {
      destroyVoxelResources(resources);
    }
  }
}
