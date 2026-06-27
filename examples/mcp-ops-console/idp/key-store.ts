/**
 * Durable-Object-backed storage for the OpenAuth issuer — the FIX for the KV key-storm
 * (L-35a55b2e).
 *
 * OpenAuth scans storage for its signing key and, when the scan comes back empty, generates and
 * persists a new one (keys.js → `signingKeys`). On Cloudflare KV that scan is eventually
 * consistent, so cold isolates across colos each see "no key", each mint their own, and the JWKS
 * DIVERGES — a token signed by one isolate fails against another isolate's JWKS (→ 401). We saw
 * exactly this: the KV namespace read empty while ~65 keys piled up in-memory across isolates.
 *
 * A single Durable Object is the fix: every isolate routes get/set/remove/scan to ONE
 * strongly-consistent instance, so the first generated key is the ONLY key any isolate ever sees.
 * This is a classic (`fetch`-based) DO so the file needs no `cloudflare:workers` value import
 * (which would drag the workerd globals into a DOM-typed project).
 */

import type { DurableObjectState, DurableObjectStub } from "@cloudflare/workers-types";
import type { StorageAdapter } from "@openauthjs/openauth/storage/storage";

// OpenAuth joins its `string[]` keys with US (unit separator, 0x1f) — mirror it (the package
// doesn't export these helpers on a stable subpath, and they're three lines).
const SEPARATOR = String.fromCharCode(31);
const joinKey = (key: string[]): string => key.join(SEPARATOR);
const splitKey = (key: string): string[] => key.split(SEPARATOR);

/** One stored record: the value plus an optional absolute expiry (epoch ms; null = permanent). */
interface Entry {
  value: unknown;
  expiresAt: number | null;
}

/** The JSON op protocol between the {@link durableObjectStorage} adapter and the DO. */
type StoreOp =
  | { op: "get"; key: string }
  | { op: "set"; key: string; value: unknown; expiresAt: number | null }
  | { op: "remove"; key: string }
  | { op: "scan"; prefix: string };

/**
 * The Durable Object: a strongly-consistent key/value store over `state.storage`. A single named
 * instance (see `idp/worker.ts`) holds every issuer isolate's signing keys + auth state, so all
 * isolates agree. Requests to one DO instance are serialized and its storage is transactional —
 * that consistency is the whole point.
 */
export class OpenAuthKeyStore {
  readonly #storage: DurableObjectState["storage"];

  constructor(state: DurableObjectState) {
    this.#storage = state.storage;
  }

  async fetch(request: Request): Promise<Response> {
    const msg = (await request.json()) as StoreOp;

    switch (msg.op) {
      case "get":
        return Response.json({ value: this.#live(await this.#storage.get<Entry>(msg.key)) });
      case "set":
        await this.#storage.put<Entry>(msg.key, { value: msg.value, expiresAt: msg.expiresAt });
        return Response.json({ ok: true });
      case "remove":
        await this.#storage.delete(msg.key);
        return Response.json({ ok: true });
      case "scan": {
        const map = await this.#storage.list<Entry>({ prefix: msg.prefix });
        const entries: [string, unknown][] = [];
        for (const [key, entry] of map) {
          const value = this.#live(entry);
          if (value !== undefined) entries.push([key, value]);
        }
        return Response.json({ entries });
      }
      default:
        // Unreachable via the adapter (the only caller); a malformed op is a 400, not a throw.
        return new Response(null, { status: 400 });
    }
  }

  /** Treat a past-expiry entry as absent (lazy expiry — fine for auth codes/state). */
  #live(entry: Entry | undefined): unknown {
    if (entry === undefined) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) return undefined;

    return entry.value;
  }
}

/**
 * An OpenAuth {@link StorageAdapter} that routes every op to the {@link OpenAuthKeyStore} DO.
 * `getStub` is read PER CALL, so each request uses its own DO stub rather than a stale captured
 * one. Drop-in for `MemoryStorage`/`CloudflareStorage` — the issuer is unchanged.
 */
export function durableObjectStorage(getStub: () => DurableObjectStub): StorageAdapter {
  const call = async (body: StoreOp): Promise<unknown> => {
    const res = await getStub().fetch("https://openauth-store.internal/", {
      method: "POST",
      body: JSON.stringify(body),
    });

    return res.json();
  };

  return {
    async get(key) {
      const { value } = (await call({ op: "get", key: joinKey(key) })) as { value: unknown };

      return (value as Record<string, unknown> | null) ?? undefined;
    },
    async set(key, value, expiry) {
      await call({
        op: "set",
        key: joinKey(key),
        value,
        expiresAt: expiry ? expiry.getTime() : null,
      });
    },
    async remove(key) {
      await call({ op: "remove", key: joinKey(key) });
    },
    async *scan(prefix) {
      // OpenAuth scans `["signing:key"]`; the stored keys are `signing:key\x1f<id>`, so prefix
      // with a trailing separator (`joinKey([...prefix, ""])`) to match on a segment boundary.
      const { entries } = (await call({ op: "scan", prefix: joinKey([...prefix, ""]) })) as {
        entries: [string, unknown][];
      };

      for (const [key, value] of entries) yield [splitKey(key), value];
    },
  };
}
