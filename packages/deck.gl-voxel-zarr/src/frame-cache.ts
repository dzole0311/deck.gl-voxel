import type { VoxelData } from 'deck.gl-voxel';

import type { ZarrVolume } from './zarr-volume.js';

interface PendingFrame {
  readonly controller: AbortController;
  readonly frame: Promise<VoxelData>;
  subscribers: number;
  settled: boolean;
}

/** Keeps decoded frames and shares in-flight reads for one dataset. */
export class FrameCache {
  private readonly reader: ZarrVolume;
  private readonly maxBytes: number;
  private bytes = 0;
  private readonly frames = new Map<number, VoxelData>();
  private readonly pending = new Map<number, PendingFrame>();

  /**
   * Starts an empty cache for an open dataset.
   * @param reader - Source of the frames in this dataset.
   * @param maxBytes - Limit on cached scalar arrays; displayed or pending frames may retain additional memory.
   */
  constructor(reader: ZarrVolume, maxBytes: number) {
    this.reader = reader;
    this.maxBytes = maxBytes;
  }

  /** Number of frames in the dataset. */
  get frameCount(): number {
    return this.reader.frameCount;
  }

  /** Whether every frame is ready to play from memory. */
  get isComplete(): boolean {
    return this.frames.size === this.frameCount;
  }

  /**
   * Checks if a frame is already in memory.
   * @param index - Zero-based frame index.
   * @returns Whether the frame can be drawn without fetching it.
   */
  has(index: number): boolean {
    return this.frames.has(index);
  }

  /**
   * Gets a frame from memory, shares an active read or starts a read.
   * @param index - Zero-based frame index.
   * @param signal - Cancels this caller's request.
   * @returns The decoded frame.
   * @throws {Error} If the read fails or this request is canceled.
   */
  async read(index: number, signal: AbortSignal): Promise<VoxelData> {
    signal.throwIfAborted();
    const cached = this.frames.get(index);

    if (cached) {
      this.frames.delete(index);
      this.frames.set(index, cached);
      return cached;
    }

    let pending = this.pending.get(index);
    if (!pending) {
      const controller = new AbortController();
      const entry: PendingFrame = {
        controller,
        subscribers: 0,
        settled: false,
        frame: Promise.resolve()
          .then(() => {
            controller.signal.throwIfAborted();
            return this.reader.readFrame(index, controller.signal);
          })
          .then((result) => {
            controller.signal.throwIfAborted();
            const bytes = result.values.byteLength;
            if (bytes <= this.maxBytes) {
              this.frames.set(index, result);
              this.bytes += bytes;
              for (const [oldIndex, oldFrame] of this.frames) {
                if (this.bytes <= this.maxBytes) {
                  break;
                }
                this.frames.delete(oldIndex);
                this.bytes -= oldFrame.values.byteLength;
              }
            }
            return result;
          })
          .finally(() => {
            entry.settled = true;
            if (this.pending.get(index) === entry) {
              this.pending.delete(index);
            }
          }),
      };
      pending = entry;
      this.pending.set(index, entry);
    }
    return this.subscribe(index, pending, signal);
  }

  // A preload and a visible-frame read may share transport. Only the last
  // subscriber leaving can cancel that transport; each caller stops waiting immediately.
  private subscribe(index: number, entry: PendingFrame, signal: AbortSignal): Promise<VoxelData> {
    entry.subscribers++;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (complete: () => void): void => {
        if (finished) {
          return;
        }
        finished = true;
        signal.removeEventListener('abort', abort);
        entry.subscribers--;
        if (!entry.settled && entry.subscribers === 0) {
          entry.controller.abort(signal.reason);
          if (this.pending.get(index) === entry) {
            this.pending.delete(index);
          }
        }
        complete();
      };
      const abort = (): void => finish(() => reject(signal.reason));
      signal.addEventListener('abort', abort, { once: true });
      entry.frame.then(
        (frame) => finish(() => resolve(frame)),
        (error: unknown) => finish(() => reject(error)),
      );
      if (signal.aborted) {
        abort();
      }
    });
  }
}
