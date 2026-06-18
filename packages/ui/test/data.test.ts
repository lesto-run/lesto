// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DATA_ROUTE_PREFIX,
  dataPrimerScript,
  dataSourceHref,
  defineDataSource,
  UiError,
} from "../src/index";
import type { IslandMount } from "../src/index";

describe("defineDataSource", () => {
  it("returns a token carrying the name and a default private scope", () => {
    const source = defineDataSource<{ id: string }>("session");

    expect(source).toEqual({ name: "session", scope: "private" });
  });

  it("defaults scope to private when no options are given", () => {
    expect(defineDataSource("session").scope).toBe("private");
  });

  it("carries an explicit shared scope", () => {
    expect(defineDataSource("reactions", { scope: "shared" }).scope).toBe("shared");
  });

  it("carries an explicit private scope", () => {
    expect(defineDataSource("session", { scope: "private" }).scope).toBe("private");
  });

  it.each(["a/b", "a b", "", "a.b", "sess!on", "../escape"])(
    "rejects the unsafe name %j (it is a URL segment and a script literal)",
    (name) => {
      try {
        defineDataSource(name);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(UiError);
        expect((error as UiError).code).toBe("UI_INVALID_DATA_SOURCE_NAME");
        expect((error as UiError).details).toEqual({ name });
      }
    },
  );

  it.each(["session", "cart_count", "user-id", "ABC123"])("accepts the safe name %j", (name) => {
    expect(defineDataSource(name).name).toBe(name);
  });
});

describe("dataSourceHref", () => {
  it("is the auto-exposed route for the source", () => {
    expect(dataSourceHref("session")).toBe("/__volo/data/session");
    expect(DATA_ROUTE_PREFIX).toBe("/__volo/data/");
  });
});

// A manifest entry with a bind, as buildIsland would emit for a `data` island.
function bound(id: string, bind: NonNullable<IslandMount["bind"]>): IslandMount {
  return { id, component: "Account", props: { static: 1 }, ssr: false, bind };
}

/** A visible (lazy-mount) bound island — its data is deferred, never primed. */
function visibleBound(id: string, bind: NonNullable<IslandMount["bind"]>): IslandMount {
  return { id, component: "Account", props: { static: 1 }, ssr: false, strategy: "visible", bind };
}

const sessionBind = { session: { source: "session", href: "/__volo/data/session" } } as const;
const cartBind = { cart: { source: "cart", href: "/__volo/data/cart" } } as const;

afterEach(() => {
  delete window.__voloData;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("dataPrimerScript", () => {
  it("is empty for a manifest with no binds (a data-free page emits no primer)", () => {
    expect(dataPrimerScript([{ id: "$", component: "X", props: {}, ssr: false }])).toBe("");
    expect(dataPrimerScript([])).toBe("");
  });

  it("kicks one guarded, ok-checked, credentialed fetch per distinct source", () => {
    const script = dataPrimerScript([bound("$.a", sessionBind)]);

    expect(script).toBe(
      "(function(){var w=window.__voloData=window.__voloData||{};" +
        'w["session"]=w["session"]||fetch("/__volo/data/session",{credentials:"same-origin"})' +
        '.then(function(r){if(!r.ok)throw new Error("volo data "+r.status);return r.json()});' +
        'w["session"].catch(function(){});})()',
    );
  });

  it("deduplicates a source bound by several islands to a single fetch", () => {
    const script = dataPrimerScript([
      bound("$.a", sessionBind),
      bound("$.b", sessionBind),
      bound("$.c", cartBind),
    ]);

    expect(script.match(/fetch\(/g)).toHaveLength(2);
    expect(script).toContain('w["session"]=');
    expect(script).toContain('w["cart"]=');
  });

  it("emits no primer when the only bind is on a visible island (F5)", () => {
    expect(dataPrimerScript([visibleBound("$.v", sessionBind)])).toBe("");
  });

  it("primes a source once when bound by both an eager and a visible island", () => {
    const script = dataPrimerScript([
      bound("$.eager", sessionBind),
      visibleBound("$.v", sessionBind),
    ]);

    expect(script.match(/fetch\(/g)).toHaveLength(1);
    expect(script).toContain('w["session"]=');
  });
});

// ---------------------------------------------------------------------------
// Execute the emitted primer body in jsdom against a stubbed window.fetch —
// the guard, the ok-check, and the handled-rejection properties (F2/F4).
// ---------------------------------------------------------------------------

/**
 * Run a primer script body the way the browser would (it is a self-calling IIFE).
 *
 * `new Function` executes only the framework's own emitted primer, whose names
 * and hrefs are charset-validated by `defineDataSource` (the `VALID_SOURCE_NAME`
 * invariant) — no untrusted input crosses into the function body.
 */
function runPrimer(script: string): void {
  new Function(script)();
}

describe("dataPrimerScript — runtime behavior", () => {
  it("starts one fetch per source; running the script TWICE still fetches once (the || guard)", () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(1) }));
    vi.stubGlobal("fetch", fetchMock);

    const script = dataPrimerScript([bound("$.a", sessionBind), bound("$.b", cartBind)]);

    runPrimer(script);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // A re-run (e.g. two islands each emitting their own primer for shared
    // sources) must NOT re-fetch — `w[name]||fetch(...)` keeps the first promise.
    runPrimer(script);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects the stored promise on a non-ok response WITHOUT parsing the error body", async () => {
    const json = vi.fn(() => Promise.resolve({ error: "nope" }));
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: false, status: 401, json }));

    runPrimer(dataPrimerScript([bound("$.a", sessionBind)]));

    await expect(window.__voloData?.session).rejects.toThrow("volo data 401");
    // The error JSON body was never read into a value.
    expect(json).not.toHaveBeenCalled();
  });

  it("does not fire unhandledrejection for an unconsumed rejected primer promise", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve({ ok: false, status: 500, json: () => undefined }),
    );

    const unhandled: unknown[] = [];
    const onUnhandled = (event: PromiseRejectionEvent): void => {
      unhandled.push(event.reason);
    };
    window.addEventListener("unhandledrejection", onUnhandled);

    try {
      // Nobody awaits window.__voloData.session here — the detached .catch must
      // mark the rejection handled so no unhandledrejection escapes.
      runPrimer(dataPrimerScript([bound("$.a", sessionBind)]));

      // Let the rejected promise settle and the microtask/macrotask queues drain.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).toEqual([]);
    } finally {
      window.removeEventListener("unhandledrejection", onUnhandled);
    }
  });

  it("resolves the stored promise to the parsed body on an ok response", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: true, json: () => Promise.resolve("Ada") }));

    runPrimer(dataPrimerScript([bound("$.a", sessionBind)]));

    await expect(window.__voloData?.session).resolves.toBe("Ada");
  });
});
