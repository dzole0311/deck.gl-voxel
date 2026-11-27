import {
  _LayersPass,
  type Effect,
  type EffectContext,
  type Layer,
  type PreRenderOptions,
  type Viewport,
} from '@deck.gl/core';
import { type Device, type Framebuffer, type Parameters, Texture } from '@luma.gl/core';
import { RaymarchVoxelLayer } from './rendering/raymarch-layer.js';
import type { VoxelDepthSource } from './types.js';

/** Each pixel needs four bytes for depth and four for color. */
const BYTES_PER_CAPTURE_PIXEL = 8;

/** Settings for the extra draw that records how far away opaque objects are. */
export interface VoxelDepthEffectProps {
  /**
   * Unique effect identifier.
   * @default 'voxel-depth'
   */
  readonly id?: string;

  /** Picks the opaque layers that actually draw. Deck.layerFilter still checks parent layers. */
  readonly getLayerFilter: (layer: Layer) => boolean;

  /**
   * Total GPU memory for the color and depth textures across all views, in bytes.
   * @default 134217728
   */
  readonly maxTextureBytes?: number;
}

/** GPU objects used to capture depth for one view. */
interface Capture {
  /** The closest opaque object at each pixel, in the camera's depth units for that view. */
  readonly texture: Texture;

  /** Color texture required so the layers can run their usual pixel shaders during capture. */
  readonly color: Texture;

  /** A framebuffer groups the textures that receive the draw, here instead of the canvas. */
  readonly framebuffer: Framebuffer;
}

/**
 * Draws selected solid deck.gl layers into an offscreen texture before the visible scene.
 * Each pixel records the nearest solid object. The volume shader stops at that depth, so a
 * building or terrain can hide samples behind it.
 * The capture uses deck.gl 9.4's experimental _LayersPass and only sees layers drawn in this pass.
 * Supply the effect in Deck.effects and draw the volume after opaque scene layers.
 *
 * @example
 * const volume = { values: new Float32Array(8).fill(0.5), dimensions: [2, 2, 2] as const };
 * const depth = new VoxelDepthEffect({ getLayerFilter: layer => layer.id === 'terrain' });
 * const layer = new VoxelLayer({ id: 'density', volume, depthSource: depth });
 */
export class VoxelDepthEffect implements Effect, VoxelDepthSource {
  /** Identifier used by deck.gl's effect manager. */
  readonly id: string;

  /** The caller's layer filter and GPU memory limit. */
  readonly props: Readonly<VoxelDepthEffectProps>;

  /** Skip the capture when deck.gl is checking what the pointer hit. */
  readonly useInPicking = false;

  private device: Device | null = null;

  private pass: OpaqueCapturePass | null = null;

  private readonly captures = new Map<string, Capture>();

  /**
   * Stores the options. The effect creates its textures when it first draws a view.
   *
   * @param props - Which opaque layers to capture and how much GPU memory to allow.
   */
  constructor(props: VoxelDepthEffectProps) {
    this.props = { ...props };
    this.id = props.id ?? 'voxel-depth';
  }

  /**
   * Prepares the step that draws depth into textures ahead of the main canvas draw.
   *
   * @param context - Effect context supplied by deck.gl.
   * @throws {Error} If the device is not WebGPU.
   */
  setup({ device }: EffectContext): void {
    if (device.type !== 'webgpu') {
      throw new Error('VoxelDepthEffect requires WebGPU.');
    }

    this.device = device;
    this.pass = new OpaqueCapturePass(device, { id: this.id }, this.props.getLayerFilter);
  }

  /**
   * Gets the latest depth texture for a view. The effect still owns the texture.
   *
   * @param viewportId - Viewport to read.
   * @returns A depth texture, or undefined before the first capture or after cleanup.
   */
  getDepthTexture(viewportId: string): Texture | undefined {
    return this.captures.get(viewportId)?.texture;
  }

  /**
   * Draws the selected opaque layers before deck.gl draws the visible scene.
   *
   * @param options - Current layers, views and the application's layer filter.
   * @throws {Error} If the textures are too large for the GPU or exceed the memory limit.
   */
  preRender(options: PreRenderOptions): void {
    if (options.isPicking || !this.device || !this.pass) {
      return;
    }

    const [width, height] = this.device.canvasContext?.getDrawingBufferSize() ?? [0, 0];

    if (width <= 0 || height <= 0) {
      return;
    }

    const viewports = options.viewports.filter(
      (viewport) => viewport.width > 0 && viewport.height > 0,
    );
    const activeIds = new Set(viewports.map((viewport) => viewport.id));

    this.pruneCaptures(activeIds, width, height);

    const maxBytes = this.props.maxTextureBytes ?? 128 * 1024 * 1024;
    const requiredBytes = width * height * BYTES_PER_CAPTURE_PIXEL * viewports.length;

    if (
      width > this.device.limits.maxTextureDimension2D ||
      height > this.device.limits.maxTextureDimension2D ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes <= 0 ||
      requiredBytes > maxBytes
    ) {
      throw new Error(
        `Voxel depth capture requires ${requiredBytes} bytes; maxTextureBytes is ${maxBytes}.`,
      );
    }

    for (const viewport of viewports) {
      let capture = this.captures.get(viewport.id);

      if (!capture) {
        capture = createCapture(this.device, width, height, `${this.id}-${viewport.id}`);
        this.captures.set(viewport.id, capture);
      }

      this.captureViewport(options, viewport, capture);
    }
  }

  /** Releases all captures and the pass when deck.gl removes the effect. */
  cleanup(): void {
    for (const capture of this.captures.values()) {
      disposeCapture(capture);
    }

    this.captures.clear();
    this.pass?.cleanup();
    this.pass = null;
    this.device = null;
  }

  /**
   * Frees textures for views that went away or for an old canvas size.
   *
   * @param activeIds - Viewports participating in the current frame.
   * @param width - Current canvas width in device pixels.
   * @param height - Current canvas height in device pixels.
   */
  private pruneCaptures(activeIds: Set<string>, width: number, height: number): void {
    for (const [id, capture] of this.captures) {
      if (
        !activeIds.has(id) ||
        capture.texture.width !== width ||
        capture.texture.height !== height
      ) {
        disposeCapture(capture);
        this.captures.delete(id);
      }
    }
  }

  /**
   * Records depth for one view. Restores the layers' GPU settings before the visible draw.
   *
   * @param options - Layers and filters supplied for this draw by deck.gl.
   * @param viewport - View with the same camera and canvas rectangle as the visible draw.
   * @param capture - Textures that receive the extra draw.
   */
  private captureViewport(options: PreRenderOptions, viewport: Viewport, capture: Capture): void {
    const savedParameters = options.layers.flatMap((layer) =>
      layer.getModels().map((model) => ({ model, parameters: { ...model.parameters } })),
    );

    try {
      this.pass?.render({
        ...options,
        views: {},
        viewports: [viewport],
        target: capture.framebuffer,
        pass: this.id,
        effects: [],
        clearCanvas: true,
      });
    } finally {
      for (const { model, parameters } of savedParameters) {
        model.setParameters(parameters);
      }
    }
  }
}

/** Draws the selected opaque layers while honoring the application's layer filter. */
class OpaqueCapturePass extends _LayersPass {
  /**
   * Creates the extra render pass with the caller's opaque-layer filter.
   *
   * @param device - WebGPU device shared with the display pass.
   * @param props - Pass identifier used in debug groups.
   * @param filter - Picks the opaque layers that should write depth.
   */
  constructor(
    device: Device,
    props: { id: string },
    private readonly filter: (layer: Layer) => boolean,
  ) {
    super(device, props);
  }

  /**
   * Checks the filter for drawable layers other than the raymarch renderer.
   *
   * @param layer - Layer under consideration, including composite layers that wrap other layers.
   * @returns Whether this layer should write the capture.
   */
  override shouldDrawLayer(layer: Layer): boolean {
    return !layer.isComposite && !(layer instanceof RaymarchVoxelLayer) && this.filter(layer);
  }

  /**
   * Turns on depth writes and turns off blending for this draw. Keeps other GPU settings.
   *
   * @param layer - Selected opaque layer.
   * @returns Pipeline parameters for the capture only.
   */
  protected override getLayerParameters(layer: Layer): Parameters {
    return {
      ...layer.props.parameters,
      depthWriteEnabled: true,
      depthCompare: 'less-equal',
      blend: false,
    };
  }
}

/**
 * Creates color and depth textures of the same size for one view.
 *
 * @param device - WebGPU device owning the capture.
 * @param width - Full-canvas width in physical pixels.
 * @param height - Full-canvas height in physical pixels.
 * @param id - Resource identifier prefix.
 * @returns The textures and render target owned by the capture.
 * @throws {Error} If allocation fails; partial allocations are released.
 */
function createCapture(device: Device, width: number, height: number, id: string): Capture {
  const owned: { destroy(): void }[] = [];

  try {
    const texture = device.createTexture({
      id: `${id}-depth`,
      width,
      height,
      format: 'depth32float',
      usage: Texture.RENDER | Texture.SAMPLE,
    });

    owned.push(texture);

    const color = device.createTexture({
      id: `${id}-color`,
      width,
      height,
      format: 'rgba8unorm',
      usage: Texture.RENDER,
    });

    owned.push(color);

    const framebuffer = device.createFramebuffer({
      id,
      width,
      height,
      colorAttachments: [color],
      depthStencilAttachment: texture,
    });

    return { texture, color, framebuffer };
  } catch (error) {
    for (const resource of owned.reverse()) {
      resource.destroy();
    }

    throw error;
  }
}

/**
 * Frees the render target first, then frees the textures it pointed to.
 *
 * @param capture - Capture allocated by createCapture.
 */
function disposeCapture(capture: Capture): void {
  capture.framebuffer.destroy();
  capture.color.destroy();
  capture.texture.destroy();
}
