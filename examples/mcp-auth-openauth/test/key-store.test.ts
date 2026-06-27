/**
 * The Durable-Object key store, exercised end-to-end in-process: the `durableObjectStorage`
 * adapter talking (over the same JSON op protocol the Worker uses) to a real `OpenAuthKeyStore`
 * DO instance, backed by an in-memory fake of `state.storage`. This guards the contract OpenAuth's
 * `signingKeys` depends on — set a key, then scan `["signing:key"]` and SEE it (an empty scan is
 * what made OpenAuth regenerate keys → the storm this DO fixes) — plus get/remove and lazy expiry.
 */

import { describe, expect, it } from "vitest";
import type { DurableObjectState, DurableObjectStub } from "@cloudflare/workers-types";

import { OpenAuthKeyStore, durableObjectStorage } from "../idp/key-store";

/** A minimal in-memory stand-in for `DurableObjectState.storage` (get/put/delete/list). */
function fakeStorageState(): DurableObjectState {
  const map = new Map<string, unknown>();

  return {
    storage: {
      get: async (key: string) => map.get(key),
      put: async (key: string, value: unknown) => {
        map.set(key, value);
      },
      delete: async (key: string) => {
        map.delete(key);
      },
      list: async ({ prefix }: { prefix: string }) => {
        const out = new Map<string, unknown>();
        for (const [key, value] of map) if (key.startsWith(prefix)) out.set(key, value);
        return out;
      },
    },
  } as unknown as DurableObjectState;
}

/** A DO stub whose `fetch` routes to ONE `OpenAuthKeyStore` over `state` — like the real binding. */
function adapterOver(state: DurableObjectState) {
  const store = new OpenAuthKeyStore(state);
  const stub = {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => store.fetch(new Request(input, init)),
  } as unknown as DurableObjectStub;

  return durableObjectStorage(() => stub);
}

describe("durableObjectStorage + OpenAuthKeyStore", () => {
  it("set → scan sees the key (the round-trip signingKeys relies on)", async () => {
    const storage = adapterOver(fakeStorageState());
    await storage.set(["signing:key", "k1"], { id: "k1", alg: "ES256" });

    const found: [string[], unknown][] = [];
    for await (const entry of storage.scan(["signing:key"])) found.push(entry);

    expect(found).toEqual([[["signing:key", "k1"], { id: "k1", alg: "ES256" }]]);
  });

  it("get returns the value, remove deletes it", async () => {
    const storage = adapterOver(fakeStorageState());
    await storage.set(["signing:key", "k1"], { id: "k1" });

    expect(await storage.get(["signing:key", "k1"])).toEqual({ id: "k1" });

    await storage.remove(["signing:key", "k1"]);
    expect(await storage.get(["signing:key", "k1"])).toBeUndefined();
  });

  it("scan with a different prefix isolates segments (no cross-prefix bleed)", async () => {
    const storage = adapterOver(fakeStorageState());
    await storage.set(["signing:key", "k1"], { id: "k1" });
    await storage.set(["encryption:key", "e1"], { id: "e1" });

    const signing: unknown[] = [];
    for await (const [, value] of storage.scan(["signing:key"])) signing.push(value);

    expect(signing).toEqual([{ id: "k1" }]);
  });

  it("treats a past-expiry entry as absent (lazy expiry)", async () => {
    const storage = adapterOver(fakeStorageState());
    await storage.set(["oauth:code", "c1"], { foo: 1 }, new Date(Date.now() - 1000));

    expect(await storage.get(["oauth:code", "c1"])).toBeUndefined();

    const scanned: unknown[] = [];
    for await (const [, value] of storage.scan(["oauth:code"])) scanned.push(value);
    expect(scanned).toEqual([]);
  });
});
