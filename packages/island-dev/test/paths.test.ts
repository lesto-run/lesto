/**
 * The URL-ownership predicate is the dispatch fork between Vite and the app. Vite is
 * configured with a dedicated base, so ownership is a single collision-proof prefix:
 * the entry, island modules, the Vite client, and deps all sit under it, while real
 * app routes never start with it.
 */

import { describe, expect, it } from "vitest";

import { ENTRY_PATH, isViteOwnedPath, VITE_BASE } from "../src/paths";

describe("isViteOwnedPath", () => {
  it("owns everything under the Vite base", () => {
    expect(VITE_BASE).toBe("/@lesto-dev/");
    // The base-prefixed entry, an island module, the Vite client, the Fast-Refresh
    // runtime, and a pre-bundled dep — all the browser ever requests.
    expect(isViteOwnedPath("/@lesto-dev/client.js")).toBe(true);
    expect(isViteOwnedPath("/@lesto-dev/app/islands/counter.tsx?t=123")).toBe(true);
    expect(isViteOwnedPath("/@lesto-dev/@vite/client")).toBe(true);
    expect(isViteOwnedPath("/@lesto-dev/@react-refresh")).toBe(true);
    expect(isViteOwnedPath("/@lesto-dev/node_modules/.vite/deps/react.js?v=abc")).toBe(true);
  });

  it("does NOT own app routes or the un-prefixed entry", () => {
    expect(isViteOwnedPath("/")).toBe(false);
    expect(isViteOwnedPath("/about")).toBe(false);
    expect(isViteOwnedPath("/api/users?page=2")).toBe(false);
    expect(isViteOwnedPath("/styles.css")).toBe(false);
    // The app emits `/client.js`, but `transformIndexHtml` rewrites it to the
    // base-prefixed URL before the browser ever requests it, so the bare path is the
    // app's (it never reaches the dispatch as a Vite request).
    expect(isViteOwnedPath(ENTRY_PATH)).toBe(false);
    expect(ENTRY_PATH).toBe("/client.js");
  });
});
