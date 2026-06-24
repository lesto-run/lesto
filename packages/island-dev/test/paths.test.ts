/**
 * The URL-ownership predicate is the dispatch fork between Vite and the app, so it is
 * tested at the edges: the entry, every Vite-internal prefix, query-suffixed module
 * URLs, and the app routes it must NOT shadow (absolute island paths route through
 * `/@fs/`, never `/app/…`).
 */

import { describe, expect, it } from "vitest";

import { ENTRY_PATH, isViteOwnedPath, VITE_PREFIXES } from "../src/paths";

describe("isViteOwnedPath", () => {
  it("owns the hydration entry", () => {
    expect(isViteOwnedPath(ENTRY_PATH)).toBe(true);
    expect(ENTRY_PATH).toBe("/client.js");
  });

  it("owns the entry even with a version query", () => {
    expect(isViteOwnedPath("/client.js?v=abc123")).toBe(true);
  });

  it("owns every Vite-internal prefix", () => {
    for (const prefix of VITE_PREFIXES) {
      expect(isViteOwnedPath(`${prefix}some/module.js`)).toBe(true);
    }
  });

  it("owns a transformed source module under /@fs/ (an island), query and all", () => {
    expect(isViteOwnedPath("/@fs/Users/me/app/islands/Counter.tsx?import")).toBe(true);
  });

  it("does NOT own app routes", () => {
    expect(isViteOwnedPath("/")).toBe(false);
    expect(isViteOwnedPath("/about")).toBe(false);
    expect(isViteOwnedPath("/api/users?page=2")).toBe(false);
  });

  it("does NOT own the framework stylesheet or a root-relative app path", () => {
    expect(isViteOwnedPath("/styles.css")).toBe(false);
    // Island source URLs are `/@fs/<abs>`, never `/app/...`, so this stays the app's.
    expect(isViteOwnedPath("/app/islands/Counter.tsx")).toBe(false);
  });
});
