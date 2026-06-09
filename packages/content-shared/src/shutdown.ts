/**
 * Graceful shutdown utilities for handling process termination.
 * Ensures in-flight operations complete before exit.
 */

export type CleanupFn = () => Promise<void> | void;

export interface GracefulShutdownOptions {
  /** Timeout in milliseconds before forced shutdown (default: 5000) */
  timeout?: number;
  /** Called when shutdown begins */
  onShutdownStart?: () => void;
  /** Called when shutdown completes (before exit) */
  onShutdownComplete?: () => void;
  /** Called when forced shutdown occurs after timeout */
  onForcedShutdown?: () => void;
  /** Exit code on successful shutdown (default: 0) */
  exitCode?: number;
  /** Exit code on forced shutdown (default: 1) */
  forcedExitCode?: number;
}

/**
 * Manages graceful shutdown of async operations.
 * Tracks active operations and runs cleanup functions on shutdown.
 *
 * @example
 * ```typescript
 * const shutdown = new GracefulShutdown({ timeout: 10000 });
 *
 * // Register cleanup functions
 * shutdown.onShutdown(async () => {
 *   await database.close();
 * });
 *
 * // Track long-running operations
 * const result = await shutdown.track(fetchData());
 *
 * // Setup signal handlers
 * GracefulShutdown.setupSignalHandlers(shutdown);
 * ```
 */
export class GracefulShutdown {
  private activeOperations = new Set<Promise<unknown>>();
  private isShuttingDown = false;
  private cleanupFns: CleanupFn[] = [];
  private options: Required<GracefulShutdownOptions>;

  constructor(options: GracefulShutdownOptions = {}) {
    this.options = {
      timeout: options.timeout ?? 5000,
      onShutdownStart: options.onShutdownStart ?? (() => {}),
      onShutdownComplete: options.onShutdownComplete ?? (() => {}),
      onForcedShutdown: options.onForcedShutdown ?? (() => {}),
      exitCode: options.exitCode ?? 0,
      forcedExitCode: options.forcedExitCode ?? 1,
    };
  }

  /**
   * Check if shutdown is in progress.
   */
  get shuttingDown(): boolean {
    return this.isShuttingDown;
  }

  /**
   * Get the count of active operations being tracked.
   */
  get activeCount(): number {
    return this.activeOperations.size;
  }

  /**
   * Track an async operation for graceful shutdown.
   * The operation will be awaited during shutdown.
   *
   * @param operation - The promise to track
   * @returns The same promise for chaining
   */
  track<T>(operation: Promise<T>): Promise<T> {
    if (this.isShuttingDown) {
      return Promise.reject(new Error("Cannot track operation: shutdown in progress"));
    }

    this.activeOperations.add(operation);
    return operation.finally(() => {
      this.activeOperations.delete(operation);
    });
  }

  /**
   * Register a cleanup function to run during shutdown.
   * Functions run in the order they were registered.
   *
   * @param fn - Cleanup function (can be async)
   */
  onShutdown(fn: CleanupFn): void {
    this.cleanupFns.push(fn);
  }

  /**
   * Remove a previously registered cleanup function.
   *
   * @param fn - The function to remove
   * @returns true if the function was found and removed
   */
  removeCleanup(fn: CleanupFn): boolean {
    const index = this.cleanupFns.indexOf(fn);
    if (index !== -1) {
      this.cleanupFns.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Initiate graceful shutdown.
   * Runs cleanup functions, waits for active operations, then exits.
   *
   * @param timeout - Override the default timeout (in ms)
   * @returns Promise that resolves when shutdown is complete
   */
  async shutdown(timeout?: number): Promise<void> {
    if (this.isShuttingDown) {
      return; // Already shutting down
    }

    this.isShuttingDown = true;
    this.options.onShutdownStart();

    const effectiveTimeout = timeout ?? this.options.timeout;

    // Run cleanup functions concurrently with error handling
    const cleanupPromises = this.cleanupFns.map(async (fn) => {
      try {
        await fn();
      } catch (err) {
        console.error("[GracefulShutdown] Cleanup error:", err);
      }
    });

    await Promise.all(cleanupPromises);

    // Wait for active operations with timeout
    if (this.activeOperations.size > 0) {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("Shutdown timeout")),
          effectiveTimeout
        );
      });

      try {
        await Promise.race([
          Promise.all(this.activeOperations),
          timeoutPromise,
        ]);
      } catch {
        this.options.onForcedShutdown();
        console.warn(
          `[GracefulShutdown] Forced shutdown after ${effectiveTimeout}ms timeout. ` +
            `${this.activeOperations.size} operations still pending.`
        );
      }
    }

    this.options.onShutdownComplete();
  }

  /**
   * Setup signal handlers for SIGINT and SIGTERM.
   * Automatically triggers shutdown on these signals.
   *
   * @param instance - GracefulShutdown instance to use
   * @param exitAfterShutdown - Whether to exit the process after shutdown (default: true)
   */
  static setupSignalHandlers(
    instance: GracefulShutdown,
    exitAfterShutdown = true
  ): void {
    const handler = async (signal: string) => {
      console.log(`\n[GracefulShutdown] Received ${signal}, shutting down...`);
      await instance.shutdown();
      if (exitAfterShutdown) {
        process.exit(instance.options.exitCode);
      }
    };

    process.on("SIGINT", () => handler("SIGINT"));
    process.on("SIGTERM", () => handler("SIGTERM"));
  }

  /**
   * Create a wrapper function that tracks all calls automatically.
   *
   * @param fn - Async function to wrap
   * @returns Wrapped function that tracks operations
   */
  wrap<T extends (...args: unknown[]) => Promise<unknown>>(
    fn: T
  ): T {
    return ((...args: Parameters<T>) => {
      return this.track(fn(...args));
    }) as T;
  }
}

/**
 * Create a simple cleanup handler without full shutdown management.
 * Useful for registering cleanup with existing shutdown mechanisms.
 *
 * @param cleanupFn - Function to call on process exit
 * @param signals - Signals to listen for (default: SIGINT, SIGTERM)
 */
export function onProcessExit(
  cleanupFn: CleanupFn,
  signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"]
): () => void {
  let called = false;

  const handler = async () => {
    if (called) return;
    called = true;

    try {
      await cleanupFn();
    } catch (err) {
      console.error("[onProcessExit] Cleanup error:", err);
    }

    process.exit(0);
  };

  for (const signal of signals) {
    process.on(signal, handler);
  }

  // Also handle beforeExit for normal termination
  process.on("beforeExit", () => {
    if (!called) {
      called = true;
      Promise.resolve(cleanupFn()).catch(console.error);
    }
  });

  // Return a function to manually trigger cleanup
  return () => {
    if (!called) {
      called = true;
      return Promise.resolve(cleanupFn());
    }
    return Promise.resolve();
  };
}

/**
 * Create a timeout-based shutdown trigger.
 * Useful for graceful shutdown in serverless environments.
 *
 * @param instance - GracefulShutdown instance
 * @param timeoutMs - Timeout before shutdown triggers
 * @returns Function to cancel the timeout
 */
export function createShutdownTimeout(
  instance: GracefulShutdown,
  timeoutMs: number
): () => void {
  const timeoutId = setTimeout(() => {
    console.log(`[GracefulShutdown] Shutdown timeout (${timeoutMs}ms) reached`);
    instance.shutdown();
  }, timeoutMs);

  return () => clearTimeout(timeoutId);
}
