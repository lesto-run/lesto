import { describe, it, expect, vi } from "vitest";
import { nn } from "./test-utils";
import { createEventEmitter, createNoopEmitter } from "../events";

describe("events", () => {
  describe("createEventEmitter", () => {
    describe("Event Subscription", () => {
      it("on() subscribes to specific event type", async () => {
        const emitter = createEventEmitter();
        const listener = vi.fn();

        emitter.on("build:start", listener);
        await emitter.emit("build:start", { cwd: "/test", collectionCount: 1 });

        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith({
          cwd: "/test",
          collectionCount: 1,
          timestamp: expect.any(Number),
        });
      });

      it("on() returns unsubscribe function that works", async () => {
        const emitter = createEventEmitter();
        const listener = vi.fn();

        const unsubscribe = emitter.on("build:start", listener);
        await emitter.emit("build:start", { cwd: "/test", collectionCount: 1 });

        expect(listener).toHaveBeenCalledTimes(1);

        unsubscribe();
        await emitter.emit("build:start", { cwd: "/test2", collectionCount: 2 });

        expect(listener).toHaveBeenCalledTimes(1);
      });

      it("onAny() subscribes to all events", async () => {
        const emitter = createEventEmitter();
        const listener = vi.fn();

        emitter.onAny(listener);
        await emitter.emit("build:start", { cwd: "/test", collectionCount: 1 });
        await emitter.emit("build:end", { duration: 100, entryCount: 5, collections: ["test"] });

        expect(listener).toHaveBeenCalledTimes(2);
      });

      it("onAny() receives event type and payload", async () => {
        const emitter = createEventEmitter();
        const listener = vi.fn();

        emitter.onAny(listener);
        await emitter.emit("build:start", { cwd: "/test", collectionCount: 1 });

        expect(listener).toHaveBeenCalledWith("build:start", {
          cwd: "/test",
          collectionCount: 1,
          timestamp: expect.any(Number),
        });
      });

      it("removeAllListeners() clears all subscriptions", async () => {
        const emitter = createEventEmitter();
        const listener1 = vi.fn();
        const listener2 = vi.fn();
        const wildcardListener = vi.fn();

        emitter.on("build:start", listener1);
        emitter.on("build:end", listener2);
        emitter.onAny(wildcardListener);

        emitter.removeAllListeners();

        await emitter.emit("build:start", { cwd: "/test", collectionCount: 1 });
        await emitter.emit("build:end", { duration: 100, entryCount: 5, collections: ["test"] });

        expect(listener1).not.toHaveBeenCalled();
        expect(listener2).not.toHaveBeenCalled();
        expect(wildcardListener).not.toHaveBeenCalled();
      });
    });

    describe("Event Emission", () => {
      it("emit() calls registered listeners", async () => {
        const emitter = createEventEmitter();
        const listener = vi.fn();

        emitter.on("build:start", listener);
        await emitter.emit("build:start", { cwd: "/test", collectionCount: 1 });

        expect(listener).toHaveBeenCalled();
      });

      it("emit() adds timestamp to payload", async () => {
        const emitter = createEventEmitter();
        const listener = vi.fn();
        const beforeEmit = Date.now();

        emitter.on("build:start", listener);
        await emitter.emit("build:start", { cwd: "/test", collectionCount: 1 });

        const afterEmit = Date.now();
        const payload = nn(listener.mock.calls[0])[0];

        expect(payload.timestamp).toBeGreaterThanOrEqual(beforeEmit);
        expect(payload.timestamp).toBeLessThanOrEqual(afterEmit);
      });

      it("emit() calls multiple listeners", async () => {
        const emitter = createEventEmitter();
        const listener1 = vi.fn();
        const listener2 = vi.fn();
        const listener3 = vi.fn();

        emitter.on("build:start", listener1);
        emitter.on("build:start", listener2);
        emitter.on("build:start", listener3);

        await emitter.emit("build:start", { cwd: "/test", collectionCount: 1 });

        expect(listener1).toHaveBeenCalledTimes(1);
        expect(listener2).toHaveBeenCalledTimes(1);
        expect(listener3).toHaveBeenCalledTimes(1);
      });

      it("emit() awaits async listeners in parallel", async () => {
        const emitter = createEventEmitter();
        const order: number[] = [];

        const listener1 = vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          order.push(1);
        });

        const listener2 = vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          order.push(2);
        });

        const listener3 = vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          order.push(3);
        });

        emitter.on("build:start", listener1);
        emitter.on("build:start", listener2);
        emitter.on("build:start", listener3);

        await emitter.emit("build:start", { cwd: "/test", collectionCount: 1 });

        expect(listener1).toHaveBeenCalled();
        expect(listener2).toHaveBeenCalled();
        expect(listener3).toHaveBeenCalled();
        expect(order).toEqual([3, 2, 1]);
      });

      it("emit() handles mixed sync/async listeners", async () => {
        const emitter = createEventEmitter();
        const order: number[] = [];

        const syncListener = vi.fn(() => {
          order.push(1);
        });

        const asyncListener = vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          order.push(2);
        });

        emitter.on("build:start", syncListener);
        emitter.on("build:start", asyncListener);

        await emitter.emit("build:start", { cwd: "/test", collectionCount: 1 });

        expect(syncListener).toHaveBeenCalled();
        expect(asyncListener).toHaveBeenCalled();
        expect(order).toEqual([1, 2]);
      });
    });

    describe("Multiple Event Types", () => {
      it("does not call listeners for different event types", async () => {
        const emitter = createEventEmitter();
        const startListener = vi.fn();
        const endListener = vi.fn();

        emitter.on("build:start", startListener);
        emitter.on("build:end", endListener);

        await emitter.emit("build:start", { cwd: "/test", collectionCount: 1 });

        expect(startListener).toHaveBeenCalledTimes(1);
        expect(endListener).not.toHaveBeenCalled();
      });

      it("wildcard listener receives all event types", async () => {
        const emitter = createEventEmitter();
        const wildcardListener = vi.fn();

        emitter.onAny(wildcardListener);

        await emitter.emit("build:start", { cwd: "/test", collectionCount: 1 });
        await emitter.emit("build:end", { duration: 100, entryCount: 5, collections: ["test"] });
        await emitter.emit("collect:start", { collection: "posts" });

        expect(wildcardListener).toHaveBeenCalledTimes(3);
        expect(wildcardListener).toHaveBeenNthCalledWith(1, "build:start", expect.any(Object));
        expect(wildcardListener).toHaveBeenNthCalledWith(2, "build:end", expect.any(Object));
        expect(wildcardListener).toHaveBeenNthCalledWith(3, "collect:start", expect.any(Object));
      });

      it("combines specific and wildcard listeners", async () => {
        const emitter = createEventEmitter();
        const specificListener = vi.fn();
        const wildcardListener = vi.fn();

        emitter.on("build:start", specificListener);
        emitter.onAny(wildcardListener);

        await emitter.emit("build:start", { cwd: "/test", collectionCount: 1 });

        expect(specificListener).toHaveBeenCalledTimes(1);
        expect(wildcardListener).toHaveBeenCalledTimes(1);
      });
    });

    describe("Unsubscribe Edge Cases", () => {
      it("unsubscribe from wildcard listener works", async () => {
        const emitter = createEventEmitter();
        const listener = vi.fn();

        const unsubscribe = emitter.onAny(listener);
        await emitter.emit("build:start", { cwd: "/test", collectionCount: 1 });

        expect(listener).toHaveBeenCalledTimes(1);

        unsubscribe();
        await emitter.emit("build:end", { duration: 100, entryCount: 5, collections: ["test"] });

        expect(listener).toHaveBeenCalledTimes(1);
      });

      it("calling unsubscribe multiple times is safe", async () => {
        const emitter = createEventEmitter();
        const listener = vi.fn();

        const unsubscribe = emitter.on("build:start", listener);
        unsubscribe();
        unsubscribe();
        unsubscribe();

        await emitter.emit("build:start", { cwd: "/test", collectionCount: 1 });

        expect(listener).not.toHaveBeenCalled();
      });
    });
  });

  describe("createNoopEmitter", () => {
    it("createNoopEmitter() returns valid emitter", () => {
      const emitter = createNoopEmitter();

      expect(emitter).toHaveProperty("on");
      expect(emitter).toHaveProperty("onAny");
      expect(emitter).toHaveProperty("emit");
      expect(emitter).toHaveProperty("removeAllListeners");
    });

    it("on() returns no-op unsubscribe", () => {
      const emitter = createNoopEmitter();
      const listener = vi.fn();

      const unsubscribe = emitter.on("build:start", listener);

      expect(typeof unsubscribe).toBe("function");
      expect(() => unsubscribe()).not.toThrow();
    });

    it("emit() resolves without calling anything", async () => {
      const emitter = createNoopEmitter();
      const listener = vi.fn();

      emitter.on("build:start", listener);
      await emitter.emit("build:start", { cwd: "/test", collectionCount: 1 });

      expect(listener).not.toHaveBeenCalled();
    });

    it("onAny() returns no-op unsubscribe", () => {
      const emitter = createNoopEmitter();
      const listener = vi.fn();

      const unsubscribe = emitter.onAny(listener);

      expect(typeof unsubscribe).toBe("function");
      expect(() => unsubscribe()).not.toThrow();
    });

    it("removeAllListeners() does not throw", () => {
      const emitter = createNoopEmitter();

      expect(() => emitter.removeAllListeners()).not.toThrow();
    });

    it("noop emitter never calls listeners on any event", async () => {
      const emitter = createNoopEmitter();
      const listener = vi.fn();

      emitter.on("build:start", listener);
      emitter.on("build:end", listener);
      emitter.onAny(listener);

      await emitter.emit("build:start", { cwd: "/test", collectionCount: 1 });
      await emitter.emit("build:end", { duration: 100, entryCount: 5, collections: ["test"] });
      await emitter.emit("collect:start", { collection: "posts" });

      expect(listener).not.toHaveBeenCalled();
    });
  });
});
