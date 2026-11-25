interface PendingRead<T> {
  readonly controller: AbortController;
  readonly promise: Promise<T>;
  priority: number;
  subscribers: number;
  settled: boolean;
  started: boolean;
  start?: () => void;
}

/**
 * Configures cached value sizes and the number of loads allowed to run at once
 * maxBytes counts retained values using byteLength, excluding pending loads
 * The loader receives a shared signal that aborts when no callers still need the read
 * It must pass that signal to its fetches and stop work when aborted
 */
export interface ChunkCacheOptions<K, T> {
  readonly maxBytes: number;
  readonly maxRequests?: number;
  readonly load: (key: K, signal: AbortSignal) => Promise<T>;
  readonly byteLength: (value: T) => number;
}

/**
 * Callers requesting the same key share one load and receive the same value
 * Cancelling one caller leaves the load running while another caller still needs it
 * Once loaded, values are kept within the byte budget by removing the least recently used first
 */
export class ChunkCache<K, T> {
  private readonly values = new Map<K, T>();
  private readonly pending = new Map<K, PendingRead<T>>();
  private readonly queue: PendingRead<T>[] = [];
  private queueDirty = false;
  private bytes = 0;
  private active = 0;
  private readonly maxRequests: number;

  constructor(private readonly options: ChunkCacheOptions<K, T>) {
    this.maxRequests = options.maxRequests ?? 6;
    if (
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes < 0 ||
      !Number.isSafeInteger(this.maxRequests) ||
      this.maxRequests < 1
    ) {
      throw new Error(
        'Cache bytes must be nonnegative and maxRequests must be a positive integer.',
      );
    }
  }

  /** Number of cached values, excluding pending reads */
  get size(): number {
    return this.values.size;
  }

  /** Whether the key is already in the cache */
  has(key: K): boolean {
    return this.values.has(key);
  }

  /**
   * Lower priority numbers run first
   * A caller can move a shared queued read ahead by requesting a lower number
   */
  async read(key: K, signal: AbortSignal, priority = 0): Promise<T> {
    signal.throwIfAborted();
    const cached = this.values.get(key);
    if (cached !== undefined) {
      this.values.delete(key);
      this.values.set(key, cached);
      return cached;
    }
    let entry = this.pending.get(key);
    if (!entry) {
      const controller = new AbortController();
      const created: PendingRead<T> = {
        controller,
        priority,
        subscribers: 0,
        settled: false,
        started: false,
        promise: Promise.resolve()
          .then(async () => {
            controller.signal.throwIfAborted();
            await this.acquire(created);
            controller.signal.throwIfAborted();
            const value = await this.options.load(key, controller.signal);
            controller.signal.throwIfAborted();
            const bytes = this.options.byteLength(value);
            if (!Number.isSafeInteger(bytes) || bytes < 0) {
              throw new Error('Cached byte lengths must be nonnegative safe integers.');
            }
            if (bytes <= this.options.maxBytes) {
              this.values.set(key, value);
              this.bytes += bytes;
              for (const [oldKey, oldValue] of this.values) {
                if (this.bytes <= this.options.maxBytes) {
                  break;
                }
                this.values.delete(oldKey);
                this.bytes -= this.options.byteLength(oldValue);
              }
            }
            return value;
          })
          .finally(() => {
            created.settled = true;
            if (this.pending.get(key) === created) {
              this.pending.delete(key);
            }
            if (created.started) {
              this.active--;
            }
            this.drain();
          }),
      };
      entry = created;
      this.pending.set(key, entry);
    }
    if (priority < entry.priority) {
      entry.priority = priority;
      this.queueDirty = true;
    }
    return this.subscribe(key, entry, signal);
  }

  /** Cancels pending reads and clears cached values */
  clear(): void {
    for (const entry of this.pending.values()) {
      entry.controller.abort();
    }
    this.pending.clear();
    this.values.clear();
    this.bytes = 0;
  }

  private acquire(entry: PendingRead<T>): Promise<void> {
    return new Promise((resolve) => {
      const abort = (): void => {
        const index = this.queue.indexOf(entry);
        if (index !== -1) {
          this.queue.splice(index, 1);
        }
        resolve();
      };
      entry.start = () => {
        entry.controller.signal.removeEventListener('abort', abort);
        resolve();
      };
      entry.controller.signal.addEventListener('abort', abort, { once: true });
      this.queue.push(entry);
      this.queueDirty = true;
      if (entry.controller.signal.aborted) {
        abort();
      }
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.maxRequests) {
      if (this.queueDirty) {
        this.queue.sort((left, right) => left.priority - right.priority);
        this.queueDirty = false;
      }
      const next = this.queue.shift();
      if (!next) {
        break;
      }
      if (!next.controller.signal.aborted && next.start) {
        next.started = true;
        this.active++;
        next.start();
      }
    }
  }

  private subscribe(key: K, entry: PendingRead<T>, signal: AbortSignal): Promise<T> {
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
          if (this.pending.get(key) === entry) {
            this.pending.delete(key);
          }
        }
        complete();
      };
      const abort = (): void => finish(() => reject(signal.reason));
      signal.addEventListener('abort', abort, { once: true });
      entry.promise.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
      if (signal.aborted) {
        abort();
      }
    });
  }
}
