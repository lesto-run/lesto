import { describe, expect, it } from "vitest";

import { contentTypeOf, dispatchSites, isBinaryType } from "../src/index";

import type { AppHandler, RequestOptions, StaticReader } from "../src/index";

import type { Site } from "@keel/sites";

import type { AnyKeelResponse } from "@keel/web";

/** A static reader over a fixed map; an absent key is a missing file. */
function fakeReader(files: Record<string, string>): StaticReader {
  return async (filePath) => files[filePath];
}

/** A static reader over a fixed map of *byte* bodies — for binary files. */
function fakeBytesReader(files: Record<string, Uint8Array>): StaticReader {
  return async (filePath) => files[filePath];
}

/** An app handler that records each call (with its options) and echoes a response. */
function recordingHandler(response: {
  status: number;
  body: string;
  headers?: Record<string, string>;
}): {
  handle: AppHandler;
  calls: Array<{ method: string; path: string; options: RequestOptions | undefined }>;
} {
  const calls: Array<{ method: string; path: string; options: RequestOptions | undefined }> = [];

  const handle: AppHandler = async (method, path, options) => {
    calls.push({ method, path, options });

    return { status: response.status, headers: response.headers ?? {}, body: response.body };
  };

  return { handle, calls };
}

const marketing: Site = {
  name: "marketing",
  basePath: "/",
  render: "static",
  pages: ["/", "/about"],
};

const mls: Site = {
  name: "mls",
  basePath: "/mls",
  render: "dynamic",
};

describe("dispatchSites — site selection", () => {
  it("picks the longest matching basePath on a segment boundary", async () => {
    const { handle, calls } = recordingHandler({ status: 200, body: "app" });

    const dispatch = dispatchSites({
      sites: [marketing, mls],
      handle,
      readStatic: fakeReader({}),
    });

    const response = await dispatch("GET", "/mls/listings");

    expect(response.status).toBe(200);
    expect(response.body).toBe("app");
    expect(calls).toEqual([{ method: "GET", path: "/mls/listings" }]);
  });

  it("keeps the longer match even when a shorter one is seen afterward", async () => {
    // Order matters for coverage: the zone is seen first and wins, then the
    // root catch-all also matches but must NOT displace it.
    const { handle, calls } = recordingHandler({ status: 200, body: "app" });

    const dispatch = dispatchSites({
      sites: [mls, marketing],
      handle,
      readStatic: fakeReader({}),
    });

    const response = await dispatch("GET", "/mls/listings");

    expect(response.body).toBe("app");
    expect(calls).toEqual([{ method: "GET", path: "/mls/listings" }]);
  });

  it("falls to the root catch-all when no zone is more specific", async () => {
    const dispatch = dispatchSites({
      sites: [marketing, mls],
      handle: recordingHandler({ status: 200, body: "" }).handle,
      readStatic: fakeReader({ "marketing/about/index.html": "<h1>About</h1>" }),
    });

    const response = await dispatch("GET", "/about");

    expect(response.status).toBe(200);
    expect(response.body).toBe("<h1>About</h1>");
  });

  it("matches a basePath only on a segment boundary, never mid-segment", async () => {
    // A basePath of `/ml` must NOT claim `/mls`; only the root catch-all does.
    const ml: Site = { name: "ml", basePath: "/ml", render: "dynamic" };

    const dynamicRoot: Site = { name: "root", basePath: "/", render: "dynamic" };

    const root = recordingHandler({ status: 200, body: "root" });

    const dispatch = dispatchSites({
      sites: [dynamicRoot, ml],
      handle: root.handle,
      readStatic: fakeReader({}),
    });

    await dispatch("GET", "/mls");

    expect(root.calls).toEqual([{ method: "GET", path: "/mls" }]);
  });

  it("matches a zone basePath exactly (path === basePath)", async () => {
    const { handle, calls } = recordingHandler({ status: 200, body: "app-root" });

    const dispatch = dispatchSites({
      sites: [marketing, mls],
      handle,
      readStatic: fakeReader({}),
    });

    const response = await dispatch("GET", "/mls");

    expect(response.body).toBe("app-root");
    expect(calls).toEqual([{ method: "GET", path: "/mls" }]);
  });

  it("404s when no site owns the path", async () => {
    // No root mount, so a path outside `/mls` belongs to nobody.
    const dispatch = dispatchSites({
      sites: [mls],
      handle: recordingHandler({ status: 200, body: "" }).handle,
      readStatic: fakeReader({}),
    });

    const response = await dispatch("GET", "/about");

    expect(response.status).toBe(404);
    expect(response.body).toBe("");
    expect(response.headers).toEqual({});
  });
});

describe("dispatchSites — dynamic sites", () => {
  it("delegates verbatim, preserving status, body, and headers", async () => {
    // The session cookie rides in the headers — dropping them would break the
    // same-origin auth that path-mounting exists to enable.
    const { handle, calls } = recordingHandler({
      status: 302,
      body: "redirecting",
      headers: { "set-cookie": "session=abc; HttpOnly", location: "/mls" },
    });

    const dispatch = dispatchSites({
      sites: [mls],
      handle,
      readStatic: fakeReader({}),
    });

    const response: AnyKeelResponse = await dispatch("POST", "/mls/session");

    expect(response.status).toBe(302);
    expect(response.body).toBe("redirecting");
    expect(response.headers).toEqual({ "set-cookie": "session=abc; HttpOnly", location: "/mls" });
    expect(calls).toEqual([{ method: "POST", path: "/mls/session" }]);
  });

  it("forwards the request options (query, headers, body) to the dynamic app", async () => {
    // The reverse of header passthrough: a dynamic zone reads the session cookie
    // from the *request* headers, so the options must reach it intact.
    const { handle, calls } = recordingHandler({ status: 200, body: "ok" });

    const dispatch = dispatchSites({ sites: [mls], handle, readStatic: fakeReader({}) });

    const options: RequestOptions = {
      query: { as: "jade" },
      headers: { cookie: "keel_session=abc" },
      body: { saved: true },
    };

    await dispatch("POST", "/mls/saved", options);

    expect(calls[0]?.options).toEqual(options);
  });
});

describe("dispatchSites — framework-reserved /__keel/ namespace", () => {
  it("routes /__keel/* to the live app, even when the / catch-all zone would claim it", async () => {
    // estate's marketing zone is the `/` catch-all (static). A data-source route
    // lives at /__keel/data/<name> and MUST reach the dynamic app, not be read as
    // a (missing) static file — so node serve matches the edge's app fallthrough.
    const { handle, calls } = recordingHandler({ status: 200, body: '{"user":null}' });

    const dispatch = dispatchSites({
      sites: [marketing],
      handle,
      readStatic: fakeReader({ "marketing/index.html": "<h1>Home</h1>" }),
    });

    const response = await dispatch("GET", "/__keel/data/session", {
      headers: { cookie: "sid=jade" },
    });

    expect(response.status).toBe(200);
    expect(response.body).toBe('{"user":null}');
    // Delegated to the app with the full path + options, never read as a file.
    expect(calls).toEqual([
      { method: "GET", path: "/__keel/data/session", options: { headers: { cookie: "sid=jade" } } },
    ]);
  });
});

describe("dispatchSites — static sites", () => {
  it("serves the prerendered file mapped from the in-site route", async () => {
    const dispatch = dispatchSites({
      sites: [marketing],
      handle: recordingHandler({ status: 200, body: "" }).handle,
      readStatic: fakeReader({ "marketing/index.html": "<h1>Home</h1>" }),
    });

    const response = await dispatch("GET", "/");

    expect(response.status).toBe(200);
    // A page revalidates: no-cache, paired with the dynamic path's ETag upstream.
    expect(response.headers).toEqual({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
    });
    expect(response.body).toBe("<h1>Home</h1>");
  });

  it("freezes a content-hashed asset as immutable for a year", async () => {
    const dispatch = dispatchSites({
      sites: [marketing],
      handle: recordingHandler({ status: 200, body: "" }).handle,
      readStatic: fakeReader({ "marketing/app.4f3a9c2b.js": "console.log(1)" }),
    });

    const response = await dispatch("GET", "/app.4f3a9c2b.js");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(response.headers["content-type"]).toBe("text/javascript; charset=utf-8");
  });

  it("makes a plainly-named asset revalidate rather than freeze", async () => {
    const dispatch = dispatchSites({
      sites: [marketing],
      handle: recordingHandler({ status: 200, body: "" }).handle,
      readStatic: fakeReader({ "marketing/app.js": "console.log(1)" }),
    });

    const response = await dispatch("GET", "/app.js");

    expect(response.headers["cache-control"]).toBe("no-cache");
  });

  it("404s a source-map request by default, even when the file exists on disk", async () => {
    const dispatch = dispatchSites({
      sites: [marketing],
      handle: recordingHandler({ status: 200, body: "" }).handle,
      // The map is present in the output dir — serving it would leak source.
      readStatic: fakeReader({ "marketing/app.js.map": '{"version":3,"sources":["app.ts"]}' }),
    });

    const response = await dispatch("GET", "/app.js.map");

    // A bare 404, indistinguishable from a missing file — its existence never leaks.
    expect(response.status).toBe(404);
    expect(response.body).toBe("");
  });

  it("serves a source map only when serveSourceMaps is enabled (dev)", async () => {
    const map = '{"version":3,"sources":["app.ts"]}';

    const dispatch = dispatchSites({
      sites: [marketing],
      handle: recordingHandler({ status: 200, body: "" }).handle,
      readStatic: fakeReader({ "marketing/app.js.map": map }),
      serveSourceMaps: true,
    });

    const response = await dispatch("GET", "/app.js.map");

    expect(response.status).toBe(200);
    expect(response.body).toBe(map);
  });

  it("strips a zone basePath to the in-site route before mapping", async () => {
    const staticMls: Site = {
      name: "mls",
      basePath: "/mls",
      render: "static",
      pages: ["/", "/about"],
    };

    const dispatch = dispatchSites({
      sites: [staticMls],
      handle: recordingHandler({ status: 200, body: "" }).handle,
      readStatic: fakeReader({ "mls/about/index.html": "<h1>MLS About</h1>" }),
    });

    const response = await dispatch("GET", "/mls/about");

    expect(response.body).toBe("<h1>MLS About</h1>");
  });

  it("maps a zone's own root (path === basePath) to its index", async () => {
    const staticMls: Site = {
      name: "mls",
      basePath: "/mls",
      render: "static",
      pages: ["/"],
    };

    const dispatch = dispatchSites({
      sites: [staticMls],
      handle: recordingHandler({ status: 200, body: "" }).handle,
      readStatic: fakeReader({ "mls/index.html": "<h1>MLS Home</h1>" }),
    });

    const response = await dispatch("GET", "/mls");

    expect(response.body).toBe("<h1>MLS Home</h1>");
  });

  it("serves HEAD like GET", async () => {
    const dispatch = dispatchSites({
      sites: [marketing],
      handle: recordingHandler({ status: 200, body: "" }).handle,
      readStatic: fakeReader({ "marketing/index.html": "<h1>Home</h1>" }),
    });

    const response = await dispatch("HEAD", "/");

    expect(response.status).toBe(200);
    expect(response.body).toBe("<h1>Home</h1>");
  });

  it("405s a non-GET/HEAD method without touching the reader", async () => {
    let read = false;

    const dispatch = dispatchSites({
      sites: [marketing],
      handle: recordingHandler({ status: 200, body: "" }).handle,
      readStatic: async (filePath) => {
        read = true;

        return filePath;
      },
    });

    const response = await dispatch("POST", "/about");

    expect(response.status).toBe(405);
    expect(response.body).toBe("");
    expect(response.headers).toEqual({});
    expect(read).toBe(false);
  });

  it("404s when the prerendered file is missing", async () => {
    const dispatch = dispatchSites({
      sites: [marketing],
      handle: recordingHandler({ status: 200, body: "" }).handle,
      readStatic: fakeReader({}),
    });

    const response = await dispatch("GET", "/about");

    expect(response.status).toBe(404);
    expect(response.body).toBe("");
  });

  it("chooses a content-type by file extension", async () => {
    const dispatch = dispatchSites({
      sites: [marketing],
      handle: recordingHandler({ status: 200, body: "" }).handle,
      readStatic: fakeReader({
        "marketing/sitemap.xml": "<urlset/>",
        "marketing/robots.txt": "User-agent: *",
        "marketing/feed.json": "[]",
      }),
    });

    const xml = await dispatch("GET", "/sitemap.xml");
    const txt = await dispatch("GET", "/robots.txt");
    const json = await dispatch("GET", "/feed.json");

    expect(xml.headers["content-type"]).toBe("application/xml");
    expect(txt.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(json.headers["content-type"]).toBe("application/json");
    // These hand-named endpoints are mutable URLs, so they revalidate.
    expect(xml.headers["cache-control"]).toBe("no-cache");
  });
});

describe("dispatchSites — binary static files", () => {
  // A two-pixel PNG's leading bytes, including a 0xFF a UTF-8 round trip would
  // mangle — the exact corruption widening the body type exists to prevent.
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);

  it("serves a binary file as raw bytes, intact, with the right Content-Type", async () => {
    const dispatch = dispatchSites({
      sites: [marketing],
      handle: recordingHandler({ status: 200, body: "" }).handle,
      readStatic: fakeBytesReader({ "marketing/logo.png": pngBytes }),
    });

    // The dispatch contract is string-bodied; a static file may legitimately be
    // bytes, so we read the response at its true (wider) type to inspect them.
    const response: AnyKeelResponse = await dispatch("GET", "/logo.png");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");

    // The body is bytes (not a string), carrying every input byte unchanged.
    expect(typeof response.body).not.toBe("string");
    expect(response.body).toBeInstanceOf(Uint8Array);
    expect(Array.from(response.body as Uint8Array)).toEqual(Array.from(pngBytes));
  });

  it("labels a content-hashed binary asset immutable, still as bytes", async () => {
    const dispatch = dispatchSites({
      sites: [marketing],
      handle: recordingHandler({ status: 200, body: "" }).handle,
      readStatic: fakeBytesReader({ "marketing/icon.a1b2c3d4.woff2": pngBytes }),
    });

    const response: AnyKeelResponse = await dispatch("GET", "/icon.a1b2c3d4.woff2");

    expect(response.headers["content-type"]).toBe("font/woff2");
    expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(response.body).toBeInstanceOf(Uint8Array);
  });

  it("encodes a string body to bytes when the extension is binary", async () => {
    // A reader that (oddly) returns a string for a binary file: the dispatcher
    // re-encodes it to bytes from the extension, so the kind matches the type.
    const dispatch = dispatchSites({
      sites: [marketing],
      handle: recordingHandler({ status: 200, body: "" }).handle,
      readStatic: fakeReader({ "marketing/logo.png": "rawpngtext" }),
    });

    const response: AnyKeelResponse = await dispatch("GET", "/logo.png");

    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.body).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(response.body as Uint8Array).toString("utf8")).toBe("rawpngtext");
  });

  it("decodes a byte body to a string when the extension is text", async () => {
    // The mirror case: a reader returns bytes for an HTML page; the dispatcher
    // decodes them to a string so the text contract is preserved.
    const dispatch = dispatchSites({
      sites: [marketing],
      handle: recordingHandler({ status: 200, body: "" }).handle,
      readStatic: fakeBytesReader({
        "marketing/index.html": new Uint8Array(Buffer.from("<h1>Home</h1>", "utf8")),
      }),
    });

    const response = await dispatch("GET", "/");

    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(typeof response.body).toBe("string");
    expect(response.body).toBe("<h1>Home</h1>");
  });
});

describe("contentTypeOf / isBinaryType", () => {
  it("labels the common binary types with their MIME and marks them binary", () => {
    const binary: Array<[string, string]> = [
      ["a.png", "image/png"],
      ["a.jpg", "image/jpeg"],
      ["a.jpeg", "image/jpeg"],
      ["a.gif", "image/gif"],
      ["a.webp", "image/webp"],
      ["a.avif", "image/avif"],
      ["a.ico", "image/x-icon"],
      ["a.woff", "font/woff"],
      ["a.woff2", "font/woff2"],
      ["a.ttf", "font/ttf"],
      ["a.otf", "font/otf"],
      ["a.pdf", "application/pdf"],
      ["a.mp4", "video/mp4"],
      ["a.webm", "video/webm"],
      ["a.wasm", "application/wasm"],
    ];

    for (const [file, type] of binary) {
      expect(contentTypeOf(file)).toBe(type);
      expect(isBinaryType(file)).toBe(true);
    }
  });

  it("keeps the text types and treats them as text (not binary)", () => {
    const text: Array<[string, string]> = [
      ["a.js", "text/javascript; charset=utf-8"],
      ["a.css", "text/css; charset=utf-8"],
      ["a.xml", "application/xml"],
      ["a.txt", "text/plain; charset=utf-8"],
      ["a.map", "application/json"],
      ["a.json", "application/json"],
      // SVG is XML markup, served as a string — binary: false on purpose.
      ["a.svg", "image/svg+xml; charset=utf-8"],
    ];

    for (const [file, type] of text) {
      expect(contentTypeOf(file)).toBe(type);
      expect(isBinaryType(file)).toBe(false);
    }
  });

  it("falls back to HTML text for an unknown extension and a clean-URL page", () => {
    expect(contentTypeOf("index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeOf("about")).toBe("text/html; charset=utf-8");
    expect(isBinaryType("index.html")).toBe(false);
  });

  it("resolves a compound extension and is case-insensitive", () => {
    // `.woff2` resolves to its own type (it does not end with the bare `.woff`),
    // and an uppercase extension resolves the same as lowercase (a file may be
    // named LOGO.PNG).
    expect(contentTypeOf("font.woff2")).toBe("font/woff2");
    expect(contentTypeOf("LOGO.PNG")).toBe("image/png");
    expect(isBinaryType("LOGO.PNG")).toBe(true);
  });
});
