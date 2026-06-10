import { afterEach, describe, expect, it } from "vitest";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchSitesDev, nodeStaticReader } from "../src/index";

import type { AppHandler, RequestOptions, StaticReader } from "../src/index";

import type { Site } from "@keel/sites";

import type { AnyKeelResponse } from "@keel/web";

/** A static reader over a fixed map; an absent key is a missing asset. */
function fakeReader(files: Record<string, string>): StaticReader {
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

describe("dispatchSitesDev — live rendering", () => {
  it("renders a STATIC zone live through handle — no files, no prebuild", async () => {
    // The whole insight: in dev a static site is the dynamic app rendered online.
    // An edit shows on the next refresh because there is no build step at all.
    const { handle, calls } = recordingHandler({ status: 200, body: "<h1>Live home</h1>" });

    const dispatch = dispatchSitesDev({ sites: [marketing], handle });

    const response = await dispatch("GET", "/about");

    expect(response.status).toBe(200);
    expect(response.body).toBe("<h1>Live home</h1>");
    expect(calls).toEqual([{ method: "GET", path: "/about", options: undefined }]);
  });

  it("renders a DYNAMIC zone live through handle, verbatim", async () => {
    const { handle, calls } = recordingHandler({
      status: 302,
      body: "redirecting",
      headers: { "set-cookie": "session=abc; HttpOnly" },
    });

    const dispatch = dispatchSitesDev({ sites: [mls], handle });

    const response: AnyKeelResponse = await dispatch("POST", "/mls/session");

    expect(response.status).toBe(302);
    expect(response.headers).toEqual({ "set-cookie": "session=abc; HttpOnly" });
    expect(calls).toEqual([{ method: "POST", path: "/mls/session", options: undefined }]);
  });

  it("forwards the request options (query, headers, body) to the app", async () => {
    const { handle, calls } = recordingHandler({ status: 200, body: "ok" });

    const dispatch = dispatchSitesDev({ sites: [mls], handle });

    const options: RequestOptions = {
      query: { as: "jade" },
      headers: { cookie: "keel_session=abc" },
      body: { saved: true },
    };

    await dispatch("POST", "/mls/saved", options);

    expect(calls[0]?.options).toEqual(options);
  });
});

describe("dispatchSitesDev — site selection (identical to dispatchSites)", () => {
  it("picks the longest matching basePath on a segment boundary", async () => {
    const { handle, calls } = recordingHandler({ status: 200, body: "app" });

    const dispatch = dispatchSitesDev({ sites: [marketing, mls], handle });

    await dispatch("GET", "/mls/listings");

    expect(calls).toEqual([{ method: "GET", path: "/mls/listings", options: undefined }]);
  });

  it("falls to the root catch-all when no zone is more specific", async () => {
    const { handle, calls } = recordingHandler({ status: 200, body: "root" });

    const dispatch = dispatchSitesDev({ sites: [marketing, mls], handle });

    const response = await dispatch("GET", "/about");

    expect(response.body).toBe("root");
    expect(calls).toEqual([{ method: "GET", path: "/about", options: undefined }]);
  });

  it("404s when no site owns the path", async () => {
    const dispatch = dispatchSitesDev({
      sites: [mls],
      handle: recordingHandler({ status: 200, body: "" }).handle,
    });

    const response = await dispatch("GET", "/about");

    expect(response.status).toBe(404);
    expect(response.body).toBe("");
    expect(response.headers).toEqual({});
  });
});

describe("dispatchSitesDev — client asset passthrough", () => {
  it("serves the island bundle before site selection, with the right type", async () => {
    const { handle, calls } = recordingHandler({ status: 200, body: "" });

    const dispatch = dispatchSitesDev({
      sites: [marketing],
      handle,
      readAsset: fakeReader({ "client.js": "hydrate();" }),
    });

    const response = await dispatch("GET", "/client.js");

    expect(response.status).toBe(200);
    expect(response.headers).toEqual({ "content-type": "text/javascript; charset=utf-8" });
    expect(response.body).toBe("hydrate();");

    // The asset never reached the sites — it was served before selection.
    expect(calls).toEqual([]);
  });

  it("hands the reader a root-relative path, not the rooted request path", async () => {
    // The reader resolves relative to its root; a leading slash would read as
    // absolute and escape it. The dispatcher must strip it — `/client.js` is read
    // as `client.js`. (A real `nodeStaticReader` refuses the un-stripped form.)
    let seen: string | undefined;

    const dispatch = dispatchSitesDev({
      sites: [marketing],
      handle: recordingHandler({ status: 200, body: "" }).handle,
      readAsset: (file) => {
        seen = file;

        return Promise.resolve("hydrate();");
      },
    });

    await dispatch("GET", "/client.js");

    expect(seen).toBe("client.js");
  });

  it("labels each asset extension correctly (.js, .css, .map)", async () => {
    const dispatch = dispatchSitesDev({
      sites: [marketing],
      handle: recordingHandler({ status: 200, body: "" }).handle,
      readAsset: fakeReader({
        "client.js": "hydrate();",
        "styles.css": "body{}",
        "client.js.map": "{}",
      }),
    });

    const js = await dispatch("GET", "/client.js");
    const css = await dispatch("GET", "/styles.css");
    const map = await dispatch("GET", "/client.js.map");

    expect(js.headers).toEqual({ "content-type": "text/javascript; charset=utf-8" });
    expect(css.headers).toEqual({ "content-type": "text/css; charset=utf-8" });
    expect(map.headers).toEqual({ "content-type": "application/json" });
  });

  it("decodes a byte body to a string for a text asset", async () => {
    // A real reader (nodeStaticReader) returns bytes from disk; a `.js` bundle is
    // text, so the dev dispatcher decodes it to a string to match its type.
    const dispatch = dispatchSitesDev({
      sites: [marketing],
      handle: recordingHandler({ status: 200, body: "" }).handle,
      readAsset: () => Promise.resolve(new Uint8Array(Buffer.from("hydrate();", "utf8"))),
    });

    const response = await dispatch("GET", "/client.js");

    expect(response.headers).toEqual({ "content-type": "text/javascript; charset=utf-8" });
    expect(typeof response.body).toBe("string");
    expect(response.body).toBe("hydrate();");
  });

  it("falls through to the sites when an asset-shaped path is a real page route", async () => {
    // A `.js` path the reader does not have is not an asset — it is a page the
    // app renders. The miss must fall through, or such routes would 404.
    const { handle, calls } = recordingHandler({ status: 200, body: "the /docs.js page" });

    const dispatch = dispatchSitesDev({
      sites: [marketing],
      handle,
      readAsset: fakeReader({}),
    });

    const response = await dispatch("GET", "/docs.js");

    expect(response.status).toBe(200);
    expect(response.body).toBe("the /docs.js page");
    expect(calls).toEqual([{ method: "GET", path: "/docs.js", options: undefined }]);
  });

  it("never consults a non-asset-shaped path against the reader", async () => {
    let read = false;

    const dispatch = dispatchSitesDev({
      sites: [marketing],
      handle: recordingHandler({ status: 200, body: "home" }).handle,
      readAsset: async (filePath) => {
        read = true;

        return filePath;
      },
    });

    const response = await dispatch("GET", "/");

    expect(response.body).toBe("home");
    expect(read).toBe(false);
  });

  it("ignores assets entirely when no reader is injected", async () => {
    // With no `readAsset`, even a `.js` path goes straight to site dispatch.
    const { handle, calls } = recordingHandler({ status: 200, body: "served as page" });

    const dispatch = dispatchSitesDev({ sites: [marketing], handle });

    const response = await dispatch("GET", "/client.js");

    expect(response.body).toBe("served as page");
    expect(calls).toEqual([{ method: "GET", path: "/client.js", options: undefined }]);
  });

  describe("with a real filesystem reader", () => {
    let root: string;

    afterEach(async () => {
      if (root) await rm(root, { recursive: true, force: true });
    });

    it("serves a real on-disk bundle for the rooted request path", async () => {
      // The end-to-end contract: a `/client.js` request must read `client.js`
      // under the asset root. A leading slash left on would resolve absolute and
      // the reader's traversal guard would refuse it — this pins the fix.
      root = await mkdtemp(join(tmpdir(), "keel-dev-asset-"));
      await writeFile(join(root, "client.js"), "/* bundle */", "utf8");

      const dispatch = dispatchSitesDev({
        sites: [marketing],
        handle: recordingHandler({ status: 200, body: "" }).handle,
        readAsset: nodeStaticReader(root),
      });

      const response = await dispatch("GET", "/client.js");

      expect(response.status).toBe(200);
      expect(response.body).toBe("/* bundle */");
    });
  });
});
