import { use } from "react";
import { describe, expect, it } from "vitest";

import { createSourceResolver } from "../src/index";

describe("createSourceResolver", () => {
  it("runs the loader once per distinct source, sharing the thenable (memoization)", () => {
    const calls: string[] = [];

    const resolver = createSourceResolver((source) => {
      calls.push(source);

      return `v:${source}`;
    }, use);

    const a1 = resolver.resolve("session");
    const a2 = resolver.resolve("session");
    const b1 = resolver.resolve("cart");

    // One run per distinct name; the same thenable is handed back on the repeat.
    expect(calls).toEqual(["session", "cart"]);
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b1);
  });

  it("wraps a sync value as a pre-fulfilled thenable read synchronously", async () => {
    const resolver = createSourceResolver(() => ({ id: "ada" }), use);

    const thenable = resolver.resolve("session") as {
      status: string;
      value: unknown;
      then: (onFulfilled: (v: unknown) => unknown) => PromiseLike<unknown>;
    };

    // React's `use()` reads `status`/`value` directly for a synchronous return.
    expect(thenable.status).toBe("fulfilled");
    expect(thenable.value).toEqual({ id: "ada" });
    // `then` still works for the async consumer.
    await expect(Promise.resolve(thenable)).resolves.toEqual({ id: "ada" });
    // The fulfilled thenable's `then` runs its onFulfilled with the value.
    await expect(thenable.then((v) => v)).resolves.toEqual({ id: "ada" });
  });

  it("wraps a sync value with no onFulfilled and resolves to the value", async () => {
    const resolver = createSourceResolver(() => 7, use);

    const thenable = resolver.resolve("n") as PromiseLike<unknown>;

    // `then(undefined)` (no fulfillment callback) must still resolve to the raw
    // value — the falsy-onFulfilled branch of the tracked thenable.
    await expect(thenable.then(undefined)).resolves.toBe(7);
  });

  it("passes a real promise through untouched", async () => {
    const promised = Promise.resolve("async-value");

    const resolver = createSourceResolver(() => promised, use);

    expect(resolver.resolve("session")).toBe(promised);
    await expect(resolver.resolve("session")).resolves.toBe("async-value");
  });

  it("memoizes a real-promise loader to a single run too", () => {
    let runs = 0;

    const resolver = createSourceResolver(() => {
      runs += 1;

      return Promise.resolve("x");
    }, use);

    resolver.resolve("session");
    resolver.resolve("session");

    expect(runs).toBe(1);
  });

  it("memoizes a loader that returns null without re-running it", () => {
    let runs = 0;

    const resolver = createSourceResolver(() => {
      runs += 1;

      return null;
    }, use);

    const first = resolver.resolve("session");
    const second = resolver.resolve("session");

    expect(first).toBe(second);
    expect(runs).toBe(1);
  });
});
