import { Layer, type LayerContext, type LayerProps, type UpdateParameters } from '@deck.gl/core';
import { Buffer, type RenderPass } from '@luma.gl/core';
import { Model } from '@luma.gl/engine';
import { Matrix4 } from '@math.gl/core';
import type { CellMesh } from './cell-grid.js';
import { cellShader } from './shaders/cell.wgsl.js';

/** Opaque, depth-writing cells. Input meshes remain caller-owned; the layer releases all GPU resources. */
export type CellLayerProps = LayerProps & {
  readonly mesh: CellMesh;
  /** One RGBA entry per prepared bin. Output remains opaque; visibleBins controls category hiding. Pass a new array to update colors. */
  readonly palette: Uint8Array;
  /**
   * Stretch relative to each column's ground elevation.
   * @default 1
   */
  readonly exaggeration?: number;
  /**
   * Bit mask of visible display bins.
   * @default 0xffffffff
   */
  readonly visibleBins?: number;
  /** Kept XY common-space bounds and physical meter Z bounds; cuboids close the exposed faces. */
  readonly clipBounds?: readonly [number, number, number, number, number, number];
};

/** Instanced opaque cuboids with local-ground exaggeration and capped near-plane intersections. */
export class CellLayer extends Layer<CellLayerProps> {
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
  declare state: {
    model?: Model;
    uniform?: Buffer;
    cells?: Buffer;
    colors?: Buffer;
    mesh?: CellMesh;
    palette?: Uint8Array;
    uniformData?: Float32Array;
  };
  override initializeState(): void {
    if (this.context.device.type !== 'webgpu') {
      throw new Error('CellLayer requires WebGPU.');
    }
    this.getAttributeManager()?.remove(['instancePickingColors']);
    this.setState({});
  }
  override setShaderModuleProps(): void {}
  /** deck.gl reapplies this count after model creation, including during viewport updates. */
  override getNumInstances(): number {
    return this.props.mesh.count;
  }
  override getModels(): Model[] {
    return this.state.model ? [this.state.model] : [];
  }
  override updateState({ props }: UpdateParameters<this>): void {
    if (
      !Number.isFinite(props.exaggeration) ||
      (props.exaggeration ?? 1) <= 0 ||
      props.palette.length % 4 ||
      props.palette.length < 4 ||
      props.palette.length > 128 ||
      props.palette.length / 4 !== props.mesh.binCount
    ) {
      throw new Error('CellLayer requires positive exaggeration and 1–32 palette entries.');
    }
    if (props.mesh !== this.state.mesh) {
      this.release();
      const device = this.context.device;
      const owned: { destroy(): void }[] = [];
      try {
        const uniform = device.createBuffer({
          byteLength: 192,
          usage: Buffer.UNIFORM | Buffer.COPY_DST,
        });
        owned.push(uniform);
        const cells = device.createBuffer({
          data: props.mesh.instances.length ? props.mesh.instances : new Float32Array(8),
          usage: Buffer.STORAGE | Buffer.COPY_DST,
        });
        owned.push(cells);
        const colors = device.createBuffer({
          byteLength: 32 * 16,
          usage: Buffer.STORAGE | Buffer.COPY_DST,
        });
        owned.push(colors);
        const model = new Model(device, {
          id: props.id,
          source: cellShader,
          vertexCount: 39,
          instanceCount: props.mesh.count,
          isInstanced: true,
          topology: 'triangle-list',
          parameters: { depthWriteEnabled: true, depthCompare: 'less-equal', cullMode: 'none' },
          bindings: { settings: uniform, cells, colors },
          shaderLayout: {
            attributes: [],
            bindings: [
              { name: 'settings', type: 'uniform', group: 0, location: 0 },
              { name: 'cells', type: 'read-only-storage', group: 0, location: 1 },
              { name: 'colors', type: 'read-only-storage', group: 0, location: 2 },
            ],
          },
        });
        this.setState({ model, uniform, cells, colors, mesh: props.mesh, palette: undefined });
      } catch (error) {
        for (const resource of owned.reverse()) {
          resource.destroy();
        }
        throw error;
      }
    }
    if (props.palette !== this.state.palette) {
      this.state.colors?.write(Float32Array.from(props.palette, (v) => v / 255));
      this.setState({ palette: props.palette });
    }
  }
  override draw({ renderPass }: { renderPass: RenderPass }): void {
    const { model, uniform } = this.state;
    if (!model || !uniform) {
      return;
    }
    const { grid } = this.props.mesh;
    // Multiplying the double-precision map translation on the CPU preserves local cell precision.
    const matrix = new Matrix4(this.context.viewport.viewProjectionMatrix).translate([
      grid.origin[0],
      grid.origin[1],
      0,
    ]);
    const data = this.state.uniformData ?? new Float32Array(48);
    this.state.uniformData = data;
    data.set(matrix, 0);
    data.set(matrix.clone().invert(), 16);
    data.set(
      [
        grid.spacing[0],
        grid.spacing[1],
        this.props.exaggeration ?? 1,
        this.props.palette.length / 4,
      ],
      32,
    );
    new Uint32Array(data.buffer)[36] = this.props.visibleBins ?? 0xffffffff;
    const clip = this.props.clipBounds;
    data.set(
      clip
        ? [clip[0] - grid.origin[0], clip[1] - grid.origin[1], clip[2], 0]
        : [-1e30, -1e30, -1e30, 0],
      40,
    );
    data.set(
      clip
        ? [clip[3] - grid.origin[0], clip[4] - grid.origin[1], clip[5], 0]
        : [1e30, 1e30, 1e30, 0],
      44,
    );
    uniform.write(data);
    model.draw(renderPass);
  }
  private release(): void {
    this.state.model?.destroy();
    this.state.uniform?.destroy();
    this.state.cells?.destroy();
    this.state.colors?.destroy();
    delete this.state.model;
    delete this.state.uniform;
    delete this.state.cells;
    delete this.state.colors;
  }
  override finalizeState(context: LayerContext): void {
    this.release();
    super.finalizeState(context);
  }
}
