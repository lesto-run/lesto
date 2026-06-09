/**
 * Async mutex for protecting critical sections.
 */
export class AsyncMutex {
  private locked = false;
  private queue: Array<() => void> = [];

  /**
   * Acquire the lock. Returns a release function.
   */
  async acquire(): Promise<() => void> {
    if (this.locked) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.locked = true;
    return () => this.release();
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }

  /**
   * Execute a function with exclusive access.
   */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Check if the mutex is currently locked.
   */
  isLocked(): boolean {
    return this.locked;
  }
}

/**
 * Read-write lock for concurrent read access with exclusive writes.
 */
export class ReadWriteLock {
  private readers = 0;
  private writer = false;
  private readQueue: Array<() => void> = [];
  private writeQueue: Array<() => void> = [];

  async acquireRead(): Promise<() => void> {
    if (this.writer || this.writeQueue.length > 0) {
      await new Promise<void>((resolve) => this.readQueue.push(resolve));
    }
    this.readers++;
    return () => this.releaseRead();
  }

  private releaseRead(): void {
    this.readers--;
    if (this.readers === 0 && this.writeQueue.length > 0) {
      const next = this.writeQueue.shift();
      next?.();
    }
  }

  async acquireWrite(): Promise<() => void> {
    if (this.writer || this.readers > 0) {
      await new Promise<void>((resolve) => this.writeQueue.push(resolve));
    }
    this.writer = true;
    return () => this.releaseWrite();
  }

  private releaseWrite(): void {
    this.writer = false;
    // Prefer waiting readers over writers to prevent starvation
    while (this.readQueue.length > 0 && this.writeQueue.length === 0) {
      const next = this.readQueue.shift();
      next?.();
    }
    if (this.writeQueue.length > 0) {
      const next = this.writeQueue.shift();
      next?.();
    }
  }
}

/**
 * Create a singleton loader that prevents race conditions during initialization.
 */
export function createSingletonLoader<T>(
  loader: () => Promise<T>
): () => Promise<T> {
  let instance: T | null = null;
  let loadPromise: Promise<T> | null = null;

  return async () => {
    if (instance !== null) return instance;

    if (!loadPromise) {
      loadPromise = loader()
        .then((result) => {
          instance = result;
          return result;
        })
        .catch((err) => {
          loadPromise = null; // Allow retry on failure
          throw err;
        });
    }

    return loadPromise;
  };
}

/**
 * Debounce async function calls with proper cancellation.
 */
export function createDebouncedAsync<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  delayMs: number
): T & { cancel: () => void; flush: () => Promise<void> } {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let pendingPromise: Promise<unknown> | null = null;
  let pendingArgs: unknown[] | null = null;

  const debouncedFn = (async (...args: unknown[]) => {
    pendingArgs = args;

    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    return new Promise((resolve, reject) => {
      timeoutId = setTimeout(async () => {
        timeoutId = null;
        try {
          pendingPromise = fn(...(pendingArgs as Parameters<T>));
          const result = await pendingPromise;
          pendingPromise = null;
          resolve(result);
        } catch (err) {
          pendingPromise = null;
          reject(err);
        }
      }, delayMs);
    });
  }) as T & { cancel: () => void; flush: () => Promise<void> };

  debouncedFn.cancel = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  debouncedFn.flush = async () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
      if (pendingArgs) {
        await fn(...pendingArgs);
      }
    }
    if (pendingPromise) {
      await pendingPromise;
    }
  };

  return debouncedFn;
}
