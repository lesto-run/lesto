import { describe, expect, it } from "vitest";

import { dispatchSites } from "../src/index";

import type { AppHandler, StaticReader } from "../src/index";

import type { Site } from "@keel/sites";

import type { KeelResponse } from "@keel/web";

/** A static reader over a fixed map; an absent key is a missing file. */
function fakeReader(files: Record<string, string>): StaticReader {
  return async (filePath) => files[filePath];
}

/** An app handler that records its calls and echoes a fixed response. */
function recordingHandler(response: {
  status: number;
  body: string;
  headers?: Record<string, string>;
}): {
  handle: AppHandler;
  calls: Array<{ method: string; path: string }>;
} {
  const calls: Array<{ method: string; path: string }> = [];

  const handle: AppHandler = async (method, path) => {
    calls.push({ method, path });

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

    const response: KeelResponse = await dispatch("POST", "/mls/session");

    expect(response.status).toBe(302);
    expect(response.body).toBe("redirecting");
    expect(response.headers).toEqual({ "set-cookie": "session=abc; HttpOnly", location: "/mls" });
    expect(calls).toEqual([{ method: "POST", path: "/mls/session" }]);
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
    expect(response.headers).toEqual({ "content-type": "text/html; charset=utf-8" });
    expect(response.body).toBe("<h1>Home</h1>");
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

    expect(xml.headers).toEqual({ "content-type": "application/xml" });
    expect(txt.headers).toEqual({ "content-type": "text/plain; charset=utf-8" });
    expect(json.headers).toEqual({ "content-type": "application/json" });
  });
});
