/**
 * The pure pieces of the fetch-proxy. `viteQuery` re-attaches the query Lesto split
 * off (Vite versions modules with it — drop it and HMR breaks); `proxyHeaders`
 * forwards a proxied response's headers minus the ones `fetch` already decoded, with
 * a JS content-type fallback so a header-less module still executes.
 */

import { describe, expect, it } from "vitest";

import { proxyHeaders, viteQuery } from "../src/proxy";

describe("viteQuery", () => {
  it("is empty for no query", () => {
    expect(viteQuery(undefined)).toBe("");
    expect(viteQuery({})).toBe("");
  });

  it("rebuilds the search string, preserving flag presence", () => {
    expect(viteQuery({ v: "abc123" })).toBe("?v=abc123");
    // A bare flag like `?import` round-trips as `import=`, which Vite reads identically.
    expect(viteQuery({ import: "", t: "9" })).toBe("?import=&t=9");
  });
});

describe("proxyHeaders", () => {
  it("forwards headers but drops the ones fetch already decoded", () => {
    const headers = new Headers({
      "content-type": "text/javascript",
      "cache-control": "no-cache",
      etag: 'W/"x"',
      "content-encoding": "gzip",
      "content-length": "42",
    });

    expect(proxyHeaders(headers)).toEqual({
      "content-type": "text/javascript",
      "cache-control": "no-cache",
      etag: 'W/"x"',
    });
  });

  it("defaults a missing content-type to JS (a browser refuses an untyped module script)", () => {
    expect(proxyHeaders(new Headers())).toEqual({ "content-type": "application/javascript" });
    // A redirect's Location rides through (status is carried separately).
    expect(proxyHeaders(new Headers({ location: "/@lesto-dev/x.js" }))).toEqual({
      location: "/@lesto-dev/x.js",
      "content-type": "application/javascript",
    });
  });
});
