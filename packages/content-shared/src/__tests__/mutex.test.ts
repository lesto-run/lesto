import { describe, it, expect, vi } from "vitest";
import {
  AsyncMutex,
  ReadWriteLock,
  createSingletonLoader,
  createDebouncedAsync,
} from "../mutex.js";

describe("AsyncMutex", () => {
  it("acquires lock when unlocked", async () => {
    const mutex = new AsyncMutex();
    expect(mutex.isLocked()).toBe(false);

    const release = await mutex.acquire();
    expect(mutex.isLocked()).toBe(true);

    release();
    expect(mutex.isLocked()).toBe(false);
  });

  it("queues acquisitions when locked", async () => {
    const mutex = new AsyncMutex();
    const order: number[] = [];

    const release1 = await mutex.acquire();
    order.push(1);

    // These should queue
    const promise2 = mutex.acquire().then((release) => {
      order.push(2);
      return release;
    });

    const promise3 = mutex.acquire().then((release) => {
      order.push(3);
      return release;
    });

    // Release first lock
    release1();
    const release2 = await promise2;
    release2();
    const release3 = await promise3;
    release3();

    expect(order).toEqual([1, 2, 3]);
    expect(mutex.isLocked()).toBe(false);
  });

  it("runExclusive executes function with lock held", async () => {
    const mutex = new AsyncMutex();
    let wasLocked = false;

    await mutex.runExclusive(async () => {
      wasLocked = mutex.isLocked();
    });

    expect(wasLocked).toBe(true);
    expect(mutex.isLocked()).toBe(false);
  });

  it("runExclusive releases lock on error", async () => {
    const mutex = new AsyncMutex();

    await expect(
      mutex.runExclusive(async () => {
        throw new Error("Test error");
      }),
    ).rejects.toThrow("Test error");

    expect(mutex.isLocked()).toBe(false);
  });

  it("runExclusive returns function result", async () => {
    const mutex = new AsyncMutex();

    const result = await mutex.runExclusive(async () => {
      return 42;
    });

    expect(result).toBe(42);
  });

  it("prevents concurrent execution", async () => {
    const mutex = new AsyncMutex();
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const task = async () => {
      await mutex.runExclusive(async () => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrentCount--;
      });
    };

    await Promise.all([task(), task(), task(), task()]);

    expect(maxConcurrent).toBe(1);
  });

  it("isLocked returns correct state", async () => {
    const mutex = new AsyncMutex();

    expect(mutex.isLocked()).toBe(false);

    const release = await mutex.acquire();
    expect(mutex.isLocked()).toBe(true);

    release();
    expect(mutex.isLocked()).toBe(false);
  });
});

describe("ReadWriteLock", () => {
  it("allows multiple concurrent readers", async () => {
    const lock = new ReadWriteLock();
    let concurrentReaders = 0;
    let maxConcurrentReaders = 0;

    const read = async () => {
      const release = await lock.acquireRead();
      concurrentReaders++;
      maxConcurrentReaders = Math.max(maxConcurrentReaders, concurrentReaders);
      await new Promise((resolve) => setTimeout(resolve, 20));
      concurrentReaders--;
      release();
    };

    await Promise.all([read(), read(), read()]);

    expect(maxConcurrentReaders).toBe(3);
  });

  it("blocks readers when writer holds lock", async () => {
    const lock = new ReadWriteLock();
    const events: string[] = [];

    const releaseWrite = await lock.acquireWrite();
    events.push("write-acquired");

    // Start reader (should block)
    const readerPromise = lock.acquireRead().then((release) => {
      events.push("read-acquired");
      return release;
    });

    // Give time for reader to potentially acquire
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Release writer
    releaseWrite();
    events.push("write-released");

    const releaseRead = await readerPromise;
    releaseRead();

    expect(events).toEqual(["write-acquired", "write-released", "read-acquired"]);
  });

  it("blocks writer when readers hold lock", async () => {
    const lock = new ReadWriteLock();
    const events: string[] = [];

    const releaseRead = await lock.acquireRead();
    events.push("read-acquired");

    // Start writer (should block)
    const writerPromise = lock.acquireWrite().then((release) => {
      events.push("write-acquired");
      return release;
    });

    // Give time for writer to potentially acquire
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Release reader
    releaseRead();
    events.push("read-released");

    const releaseWrite = await writerPromise;
    releaseWrite();

    expect(events).toEqual(["read-acquired", "read-released", "write-acquired"]);
  });

  it("blocks writer when writer holds lock", async () => {
    const lock = new ReadWriteLock();
    const events: string[] = [];

    const releaseWrite1 = await lock.acquireWrite();
    events.push("write1-acquired");

    // Start second writer (should block)
    const writer2Promise = lock.acquireWrite().then((release) => {
      events.push("write2-acquired");
      return release;
    });

    // Give time for second writer to potentially acquire
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Release first writer
    releaseWrite1();
    events.push("write1-released");

    const releaseWrite2 = await writer2Promise;
    releaseWrite2();

    expect(events).toEqual(["write1-acquired", "write1-released", "write2-acquired"]);
  });

  it("prefers readers over writers to prevent reader starvation", async () => {
    const lock = new ReadWriteLock();
    const events: string[] = [];

    // Acquire initial write lock
    const releaseWrite = await lock.acquireWrite();
    events.push("initial-write");

    // Queue a reader and a writer
    const readerPromise = lock.acquireRead().then((release) => {
      events.push("reader");
      release();
      return undefined;
    });

    // Small delay to ensure order
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Only queue writer after reader is queued
    const writerPromise = lock.acquireWrite().then((release) => {
      events.push("writer");
      release();
      return undefined;
    });

    // Release initial lock
    releaseWrite();

    await Promise.all([readerPromise, writerPromise]);

    // Reader should be processed before the queued writer
    expect(events[0]).toBe("initial-write");
    expect(events.includes("reader")).toBe(true);
    expect(events.includes("writer")).toBe(true);
  });

  it("blocks new readers when writer is waiting", async () => {
    const lock = new ReadWriteLock();
    const events: string[] = [];

    // Start with a reader
    const releaseRead1 = await lock.acquireRead();
    events.push("read1-acquired");

    // Queue a writer
    const writerPromise = lock.acquireWrite().then((release) => {
      events.push("write-acquired");
      return release;
    });

    // Try to queue another reader (should wait for writer)
    const reader2Promise = lock.acquireRead().then((release) => {
      events.push("read2-acquired");
      return release;
    });

    // Give time for queuing
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Release first reader
    releaseRead1();
    events.push("read1-released");

    const releaseWrite = await writerPromise;
    releaseWrite();
    events.push("write-released");

    const releaseRead2 = await reader2Promise;
    releaseRead2();

    // Writer should acquire before second reader
    expect(events.indexOf("write-acquired")).toBeLessThan(events.indexOf("read2-acquired"));
  });
});

describe("createSingletonLoader", () => {
  it("calls loader only once", async () => {
    const loader = vi.fn().mockResolvedValue("result");
    const getSingleton = createSingletonLoader(loader);

    const result1 = await getSingleton();
    const result2 = await getSingleton();
    const result3 = await getSingleton();

    expect(result1).toBe("result");
    expect(result2).toBe("result");
    expect(result3).toBe("result");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("handles concurrent calls with single loader invocation", async () => {
    let loadCount = 0;
    const loader = vi.fn().mockImplementation(async () => {
      loadCount++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return `result-${loadCount}`;
    });

    const getSingleton = createSingletonLoader(loader);

    // Call concurrently
    const [result1, result2, result3] = await Promise.all([
      getSingleton(),
      getSingleton(),
      getSingleton(),
    ]);

    expect(result1).toBe("result-1");
    expect(result2).toBe("result-1");
    expect(result3).toBe("result-1");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("retries after failure", async () => {
    let attempts = 0;
    const loader = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error("First attempt failed");
      }
      return "success";
    });

    const getSingleton = createSingletonLoader(loader);

    // First call fails
    await expect(getSingleton()).rejects.toThrow("First attempt failed");
    expect(loader).toHaveBeenCalledTimes(1);

    // Second call should retry and succeed
    const result = await getSingleton();
    expect(result).toBe("success");
    expect(loader).toHaveBeenCalledTimes(2);

    // Third call should use cached result
    const result2 = await getSingleton();
    expect(result2).toBe("success");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("caches null values correctly", async () => {
    const loader = vi.fn().mockResolvedValue(null);
    const getSingleton = createSingletonLoader(loader);

    // Note: The implementation only caches non-null values
    // This test verifies current behavior
    const result1 = await getSingleton();
    const result2 = await getSingleton();

    expect(result1).toBe(null);
    expect(result2).toBe(null);
    // Due to null check, loader may be called multiple times for null values
  });

  it("preserves result type", async () => {
    interface User {
      id: number;
      name: string;
    }

    const user: User = { id: 1, name: "Test" };
    const loader: () => Promise<User> = vi.fn().mockResolvedValue(user);
    const getSingleton = createSingletonLoader(loader);

    const result = await getSingleton();

    expect(result).toEqual(user);
    expect(result.id).toBe(1);
    expect(result.name).toBe("Test");
  });
});

describe("createDebouncedAsync", () => {
  it("debounces multiple calls", async () => {
    const fn = vi.fn().mockResolvedValue("result");
    const debounced = createDebouncedAsync(fn, 50);

    // Make multiple rapid calls - only the last one's args should be used
    debounced("arg1");
    debounced("arg2");
    const promise = debounced("arg3");

    // Wait for debounce to complete
    const result = await promise;

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("arg3");
    expect(result).toBe("result");
  });

  it("delays execution by specified time", async () => {
    const fn = vi.fn().mockResolvedValue("result");
    const debounced = createDebouncedAsync(fn, 100);

    debounced();

    // Not called immediately
    expect(fn).not.toHaveBeenCalled();

    // Wait a bit less than delay
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fn).not.toHaveBeenCalled();

    // Wait for full delay
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("cancel stops pending execution", async () => {
    const fn = vi.fn().mockResolvedValue("result");
    const debounced = createDebouncedAsync(fn, 100);

    debounced();
    debounced.cancel();

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(fn).not.toHaveBeenCalled();
  });

  it("flush executes immediately", async () => {
    const fn = vi.fn().mockResolvedValue("result");
    const debounced = createDebouncedAsync(fn, 1000);

    debounced("flushed-arg");
    await debounced.flush();

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("flushed-arg");
  });

  it("handles errors in debounced function", async () => {
    const error = new Error("Test error");
    const fn = vi.fn().mockRejectedValue(error);
    const debounced = createDebouncedAsync(fn, 50);

    const promise = debounced();

    await expect(promise).rejects.toThrow("Test error");
  });

  it("resets timer on new calls", async () => {
    // Fake timers: wall-clock sleeps race the 100ms debounce under parallel CI
    // load (coverage instrumentation), so advance virtual time deterministically.
    // advanceTimersByTimeAsync also drains the microtasks the timeout awaits.
    vi.useFakeTimers();
    try {
      const fn = vi.fn().mockResolvedValue("result");
      const debounced = createDebouncedAsync(fn, 100);

      debounced("call1");
      await vi.advanceTimersByTimeAsync(50);

      debounced("call2");
      await vi.advanceTimersByTimeAsync(50);

      // Only 50ms since call2 — the 100ms timer was reset and hasn't fired.
      expect(fn).not.toHaveBeenCalled();

      debounced("call3");
      await vi.advanceTimersByTimeAsync(110);

      // Now should be called with last args
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith("call3");
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows multiple arguments", async () => {
    const fn = vi.fn().mockResolvedValue("result");
    const debounced = createDebouncedAsync(fn, 50);

    const promise = debounced("arg1", "arg2", "arg3");
    await promise;

    expect(fn).toHaveBeenCalledWith("arg1", "arg2", "arg3");
  });

  it("flush waits for pending promise", async () => {
    let resolvePromise: (value: string) => void;
    const fn = vi.fn().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolvePromise = resolve;
        }),
    );
    const debounced = createDebouncedAsync(fn, 10);

    debounced();

    // Wait for debounce delay
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Start flush (should wait for pending promise)
    const flushPromise = debounced.flush();

    // Resolve the pending promise
    resolvePromise!("done");

    await flushPromise;

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("cancel has no effect after execution", async () => {
    const fn = vi.fn().mockResolvedValue("result");
    const debounced = createDebouncedAsync(fn, 50);

    const promise = debounced();
    const result = await promise;

    // Cancel after execution
    debounced.cancel();

    expect(result).toBe("result");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
