import { describe, expect, it } from "vitest";

import {
  cacheControl,
  etagFor,
  etagMatches,
  hasContentHash,
  respondNotModified,
} from "../src/index";

import type { NotModifiedResponse } from "../src/index";

describe("cacheControl", () => {
  it("freezes a content-hashed asset as immutable, ignoring every other directive", () => {
    expect(cacheControl({ immutable: true })).toBe("public, max-age=31536000, immutable");

    // Immutable is absolute: the other directives are deliberately ignored.
    expect(cacheControl({ immutable: true, maxAge: 5, noCache: true })).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  it("emits no-cache for a revalidate-every-time resource", () => {
    expect(cacheControl({ noCache: true })).toBe("no-cache");
  });

  it("prefers no-cache over max-age when both are somehow present", () => {
    // The type makes these mutually exclusive, but the implementation must still
    // honor no-cache so a max-age can't sneak a freshness window past it.
    expect(cacheControl({ noCache: true, maxAge: 60 })).toBe("no-cache");
  });

  it("assembles visibility, freshness, and the stale-* windows in canonical order", () => {
    expect(
      cacheControl({
        visibility: "public",
        maxAge: 60,
        staleWhileRevalidate: 30,
        staleIfError: 120,
      }),
    ).toBe("public, max-age=60, stale-while-revalidate=30, stale-if-error=120");
  });

  it("emits a bare max-age when no other directive is set", () => {
    expect(cacheControl({ maxAge: 0 })).toBe("max-age=0");
  });

  it("emits private visibility when asked", () => {
    expect(cacheControl({ visibility: "private", noCache: true })).toBe("private, no-cache");
  });

  it("emits an empty string for an empty directive set", () => {
    expect(cacheControl({})).toBe("");
  });
});

describe("hasContentHash", () => {
  describe("dot form — name.<hash>.ext", () => {
    it("detects a fingerprint segment of hex before the extension", () => {
      expect(hasContentHash("assets/app.4f3a9c2b.js")).toBe(true);
      expect(hasContentHash("site/main.0a1b2c3d4e5f.css")).toBe(true);
      // The dot form's hash may be UPPERCASE hex (the regex is case-insensitive).
      expect(hasContentHash("app.4F3A9C2B.js")).toBe(true);
    });

    it("treats plain and human-versioned filenames as mutable", () => {
      expect(hasContentHash("index.html")).toBe(false);
      expect(hasContentHash("app.js")).toBe(false);
      // A short or non-hash dotted segment is not a digest.
      expect(hasContentHash("app.v2.js")).toBe(false);
    });

    it("requires a trailing extension after the hash", () => {
      // A bare hash with no extension is not an asset filename.
      expect(hasContentHash("app.4f3a9c2b1d2e")).toBe(false);
    });
  });

  describe("dash form — Vite/Rollup default name-<hash>.ext", () => {
    // Real Vite/Rollup default emitted filenames — these are the chunks that were
    // wrongly revalidating on every load before L-e217eb20.
    it("freezes a real Vite dash-hash chunk (digit + mixed case)", () => {
      expect(hasContentHash("sqlite3-BqX9F35q.wasm")).toBe(true);
      expect(hasContentHash("assets/chunk-DdF2xY8z.css")).toBe(true);
      expect(hasContentHash("index-4f3a9c2b.js")).toBe(true);
    });

    it("freezes a dash-hash carried on a name that itself contains dashes", () => {
      // We inspect only the FINAL dash segment, so a multi-word prefix is fine.
      expect(hasContentHash("opfs-worker-BvJIRuxz.js")).toBe(true);
    });

    it("freezes a mixed-case dash-hash even when it carries no digit", () => {
      // `BvJIRuxz` has no digit; mixed case alone is enough entropy for a digest.
      expect(hasContentHash("opfs-worker-BvJIRuxz.js")).toBe(true);
      expect(hasContentHash("chunk-AbCdEfGh.js")).toBe(true);
    });

    // The tension case, spelled out: an unhashed human dash-word must stay
    // no-cache, while its hashed sibling must freeze.
    it("keeps an unhashed human dash-word mutable but freezes its hashed sibling", () => {
      expect(hasContentHash("opfs-worker.js")).toBe(false); // `worker` is a word
      expect(hasContentHash("opfs-worker-BvJIRuxz.js")).toBe(true); // `BvJIRuxz` is a hash
    });

    it("keeps a long lowercase dash-word mutable (length alone is not entropy)", () => {
      // `controller` is 10 chars — long enough on length, but pure lowercase, so
      // it must NOT be mistaken for a digest.
      expect(hasContentHash("opfs-controller.js")).toBe(false);
      expect(hasContentHash("service-worker.js")).toBe(false);
      expect(hasContentHash("vendor-chunk.js")).toBe(false);
    });

    it("keeps short dash suffixes mutable (a version/qualifier is not a hash)", () => {
      expect(hasContentHash("foo-v2.js")).toBe(false);
      expect(hasContentHash("bar-min.js")).toBe(false);
    });

    it("does not treat an internal-dot segment as a dash-hash", () => {
      // The final dash token spans a dot (`file.min`), which is not the base64url
      // alphabet, so it is rejected — `vendor-app.min.js` stays mutable.
      expect(hasContentHash("my-file.min.js")).toBe(false);
    });

    it("requires a trailing extension after a dash-hash", () => {
      // A hashed-looking token with no extension is not an asset filename we freeze.
      expect(hasContentHash("chunk-BqX9F35q")).toBe(false);
    });
  });

  it("treats bare plain filenames (no dash, no dot-hash) as mutable", () => {
    for (const name of ["main.js", "styles.css", "worker.js", "index.js"]) {
      expect(hasContentHash(name)).toBe(false);
    }
  });

  it("looks only at the filename, never a hash-looking directory", () => {
    // A hash in a directory must not freeze a plainly-named file under it.
    expect(hasContentHash("4f3a9c2b1d2e/index.html")).toBe(false);
    // Same for a dash-hash directory over an unhashed file.
    expect(hasContentHash("assets/chunk-DdF2xY8z/index.html")).toBe(false);
  });
});

describe("etagFor", () => {
  it("hashes the body into a quoted strong validator", () => {
    const tag = etagFor("<h1>Home</h1>");

    expect(tag).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
  });

  it("is stable for identical bodies and distinct for different ones", () => {
    expect(etagFor("same")).toBe(etagFor("same"));
    expect(etagFor("one")).not.toBe(etagFor("two"));
  });

  it("prefixes a weak validator with W/", () => {
    const weak = etagFor("body", { weak: true });

    expect(weak.startsWith('W/"')).toBe(true);
    // The quoted opaque tag is the same; only the weakness marker differs.
    expect(weak.slice(2)).toBe(etagFor("body"));
  });
});

describe("etagMatches", () => {
  const tag = etagFor("<h1>Home</h1>");

  it("is false when the client sent no If-None-Match", () => {
    expect(etagMatches(undefined, tag)).toBe(false);
  });

  it("matches an identical tag", () => {
    expect(etagMatches(tag, tag)).toBe(true);
  });

  it("matches across weak/strong forms of the same tag", () => {
    expect(etagMatches(`W/${tag}`, tag)).toBe(true);
    expect(etagMatches(tag, `W/${tag}`)).toBe(true);
  });

  it("matches one tag out of a comma-separated list", () => {
    expect(etagMatches(`"other", ${tag}, "more"`, tag)).toBe(true);
  });

  it("matches the wildcard against any current representation", () => {
    expect(etagMatches("*", tag)).toBe(true);
  });

  it("is false for a non-matching tag", () => {
    expect(etagMatches('"nope"', tag)).toBe(false);
  });
});

describe("respondNotModified", () => {
  it("writes a 304 with the given headers and ends with no body", () => {
    const calls: Array<
      | { kind: "writeHead"; status: number; headers: Record<string, string | string[]> }
      | { kind: "end" }
    > = [];

    const res: NotModifiedResponse = {
      writeHead: (status, headers) => calls.push({ kind: "writeHead", status, headers }),
      end: () => calls.push({ kind: "end" }),
    };

    respondNotModified(res, { ETag: '"abc"', "cache-control": "no-cache" });

    expect(calls).toEqual([
      {
        kind: "writeHead",
        status: 304,
        headers: { ETag: '"abc"', "cache-control": "no-cache" },
      },
      { kind: "end" },
    ]);
  });

  it("strips Content-Length so a bodiless 304 never declares a body length", () => {
    const calls: Array<
      | { kind: "writeHead"; status: number; headers: Record<string, string | string[]> }
      | { kind: "end" }
    > = [];

    const res: NotModifiedResponse = {
      writeHead: (status, headers) => calls.push({ kind: "writeHead", status, headers }),
      end: () => calls.push({ kind: "end" }),
    };

    // Mixed casing on purpose: an app owns its response headers and may set any
    // casing, so the strip must be case-insensitive.
    respondNotModified(res, {
      ETag: '"abc"',
      "Content-Length": "42",
      "content-length": "99",
      "cache-control": "no-cache",
    });

    expect(calls).toEqual([
      {
        kind: "writeHead",
        status: 304,
        headers: { ETag: '"abc"', "cache-control": "no-cache" },
      },
      { kind: "end" },
    ]);
  });

  it("echoes a multi-valued Set-Cookie list intact so a 304 re-sets every cookie", () => {
    const calls: Array<
      | { kind: "writeHead"; status: number; headers: Record<string, string | string[]> }
      | { kind: "end" }
    > = [];

    const res: NotModifiedResponse = {
      writeHead: (status, headers) => calls.push({ kind: "writeHead", status, headers }),
      end: () => calls.push({ kind: "end" }),
    };

    respondNotModified(res, {
      ETag: '"abc"',
      "set-cookie": ["session=s; HttpOnly", "csrf=c; Secure"],
    });

    // The Set-Cookie list survives the 304 as a list — node emits one line per
    // element, so a not-modified response still re-sets both cookies.
    expect(calls[0]).toEqual({
      kind: "writeHead",
      status: 304,
      headers: { ETag: '"abc"', "set-cookie": ["session=s; HttpOnly", "csrf=c; Secure"] },
    });
  });
});
