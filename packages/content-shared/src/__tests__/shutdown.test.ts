import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  GracefulShutdown,
  createShutdownTimeout,
} from "../shutdown.js";

describe("GracefulShutdown", () => {
  let shutdown: GracefulShutdown;

  beforeEach(() => {
    shutdown = new GracefulShutdown({ timeout: 1000 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("creates instance with default options", () => {
      const instance = new GracefulShutdown();
      expect(instance.shuttingDown).toBe(false);
      expect(instance.activeCount).toBe(0);
    });

    it("creates instance with custom options", () => {
      const onStart = vi.fn();
      const instance = new GracefulShutdown({
        timeout: 2000,
        onShutdownStart: onStart,
      });
      expect(instance.shuttingDown).toBe(false);
    });
  });

  describe("track", () => {
    it("tracks a promise and removes it when complete", async () => {
      const promise = Promise.resolve("result");
      const tracked = shutdown.track(promise);

      expect(shutdown.activeCount).toBe(1);
      const result = await tracked;
      expect(result).toBe("result");
      expect(shutdown.activeCount).toBe(0);
    });

    it("removes promise from tracking when it rejects", async () => {
      const promise = Promise.reject(new Error("test error"));
      const tracked = shutdown.track(promise);

      expect(shutdown.activeCount).toBe(1);
      await expect(tracked).rejects.toThrow("test error");
      expect(shutdown.activeCount).toBe(0);
    });

    it("rejects when tracking during shutdown", async () => {
      await shutdown.shutdown();
      const promise = Promise.resolve("result");

      await expect(shutdown.track(promise)).rejects.toThrow(
        "Cannot track operation: shutdown in progress"
      );
    });

    it("tracks multiple concurrent operations", async () => {
      const p1 = shutdown.track(
        new Promise((resolve) => setTimeout(() => resolve(1), 10))
      );
      const p2 = shutdown.track(
        new Promise((resolve) => setTimeout(() => resolve(2), 20))
      );

      expect(shutdown.activeCount).toBe(2);

      await p1;
      expect(shutdown.activeCount).toBe(1);

      await p2;
      expect(shutdown.activeCount).toBe(0);
    });
  });

  describe("onShutdown / removeCleanup", () => {
    it("registers cleanup functions", () => {
      const fn1 = vi.fn();
      const fn2 = vi.fn();

      shutdown.onShutdown(fn1);
      shutdown.onShutdown(fn2);

      expect(fn1).not.toHaveBeenCalled();
      expect(fn2).not.toHaveBeenCalled();
    });

    it("runs cleanup functions during shutdown", async () => {
      const fn1 = vi.fn();
      const fn2 = vi.fn().mockResolvedValue(undefined);

      shutdown.onShutdown(fn1);
      shutdown.onShutdown(fn2);

      await shutdown.shutdown();

      expect(fn1).toHaveBeenCalledTimes(1);
      expect(fn2).toHaveBeenCalledTimes(1);
    });

    it("removes cleanup functions", () => {
      const fn = vi.fn();
      shutdown.onShutdown(fn);

      const removed = shutdown.removeCleanup(fn);
      expect(removed).toBe(true);
    });

    it("returns false when removing non-existent cleanup", () => {
      const fn = vi.fn();
      const removed = shutdown.removeCleanup(fn);
      expect(removed).toBe(false);
    });

    it("removed cleanup is not called during shutdown", async () => {
      const fn = vi.fn();
      shutdown.onShutdown(fn);
      shutdown.removeCleanup(fn);

      await shutdown.shutdown();

      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe("shutdown", () => {
    it("sets shuttingDown to true", async () => {
      expect(shutdown.shuttingDown).toBe(false);
      await shutdown.shutdown();
      expect(shutdown.shuttingDown).toBe(true);
    });

    it("only runs shutdown once", async () => {
      const onStart = vi.fn();
      const instance = new GracefulShutdown({
        onShutdownStart: onStart,
      });

      await instance.shutdown();
      await instance.shutdown();
      await instance.shutdown();

      expect(onStart).toHaveBeenCalledTimes(1);
    });

    it("calls onShutdownStart callback", async () => {
      const onStart = vi.fn();
      const instance = new GracefulShutdown({
        onShutdownStart: onStart,
      });

      await instance.shutdown();

      expect(onStart).toHaveBeenCalledTimes(1);
    });

    it("calls onShutdownComplete callback", async () => {
      const onComplete = vi.fn();
      const instance = new GracefulShutdown({
        onShutdownComplete: onComplete,
      });

      await instance.shutdown();

      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("waits for active operations to complete", async () => {
      let resolved = false;
      const operation = new Promise<void>((resolve) => {
        setTimeout(() => {
          resolved = true;
          resolve();
        }, 50);
      });

      shutdown.track(operation);
      await shutdown.shutdown();

      expect(resolved).toBe(true);
    });

    it("handles cleanup function errors gracefully", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const errorFn = vi.fn().mockRejectedValue(new Error("cleanup failed"));
      const successFn = vi.fn();

      shutdown.onShutdown(errorFn);
      shutdown.onShutdown(successFn);

      await shutdown.shutdown();

      expect(errorFn).toHaveBeenCalled();
      expect(successFn).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalled();
    });

    it("calls onForcedShutdown when timeout is exceeded", async () => {
      const onForced = vi.fn();
      const instance = new GracefulShutdown({
        timeout: 50,
        onForcedShutdown: onForced,
      });

      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Create a never-resolving promise
      const neverResolves = new Promise(() => {});
      instance.track(neverResolves);

      await instance.shutdown();

      expect(onForced).toHaveBeenCalledTimes(1);
      consoleSpy.mockRestore();
    });

    it("allows timeout override during shutdown call", async () => {
      const onForced = vi.fn();
      const instance = new GracefulShutdown({
        timeout: 10000, // Long default timeout
        onForcedShutdown: onForced,
      });

      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const neverResolves = new Promise(() => {});
      instance.track(neverResolves);

      await instance.shutdown(50); // Override with short timeout

      expect(onForced).toHaveBeenCalledTimes(1);
      consoleSpy.mockRestore();
    });
  });

  describe("wrap", () => {
    it("creates a wrapped function that tracks calls", async () => {
      const asyncFn = vi.fn().mockResolvedValue("result");
      const wrapped = shutdown.wrap(asyncFn);

      expect(shutdown.activeCount).toBe(0);

      const resultPromise = wrapped("arg1", "arg2");
      expect(shutdown.activeCount).toBe(1);

      const result = await resultPromise;
      expect(result).toBe("result");
      expect(shutdown.activeCount).toBe(0);
      expect(asyncFn).toHaveBeenCalledWith("arg1", "arg2");
    });

    it("wrapped function rejects when shutdown in progress", async () => {
      await shutdown.shutdown();

      const asyncFn = vi.fn().mockResolvedValue("result");
      const wrapped = shutdown.wrap(asyncFn);

      await expect(wrapped()).rejects.toThrow("shutdown in progress");
    });
  });
});

describe("createShutdownTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("triggers shutdown after timeout", async () => {
    const shutdown = new GracefulShutdown();
    const shutdownSpy = vi.spyOn(shutdown, "shutdown");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    createShutdownTimeout(shutdown, 1000);

    expect(shutdownSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);

    expect(shutdownSpy).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });

  it("returns a cancel function", async () => {
    const shutdown = new GracefulShutdown();
    const shutdownSpy = vi.spyOn(shutdown, "shutdown");

    const cancel = createShutdownTimeout(shutdown, 1000);
    cancel();

    await vi.advanceTimersByTimeAsync(2000);

    expect(shutdownSpy).not.toHaveBeenCalled();
  });
});
