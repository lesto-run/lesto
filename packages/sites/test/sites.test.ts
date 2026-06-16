import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildStaticSites,
  defineSites,
  nodeSink,
  prerenderSite,
  SitesError,
  writePages,
  type OutputSink,
  type PageHandler,
  type RenderedPage,
  type RenderResponse,
  type Site,
  type StaticSite,
} from "../src/index";

// A handler that echoes the path it was asked to render, and records its calls.
function echoHandler(): { handle: PageHandler; calls: string[] } {
  const calls: string[] = [];

  const handle: PageHandler = (method, path) => {
    calls.push(`${method} ${path}`);

    return Promise.resolve({ status: 200, body: `<html>${path}</html>` });
  };

  return { handle, calls };
}

// A capturing sink: each written page lands in the map, keyed by its path. The
// sink carries bytes, so the map decodes them to a string for easy assertions.
function mapSink(): { sink: OutputSink; written: Map<string, string> } {
  const written = new Map<string, string>();

  const sink: OutputSink = (path: string, contents: Uint8Array | string) => {
    written.set(path, typeof contents === "string" ? contents : new TextDecoder().decode(contents));

    return Promise.resolve();
  };

  return { sink, written };
}

// A handler that answers every page with a fixed status, echoing the path.
function statusHandler(status: number): PageHandler {
  return (_method, path) => Promise.resolve({ status, body: `<html>${path}</html>` });
}

// A handler that yields a fixed body, to drive each `KeelResponseBody` arm.
function bodyHandler(body: RenderResponse["body"]): PageHandler {
  return () => Promise.resolve({ status: 200, body });
}

describe("defineSites", () => {
  it("returns a valid set unchanged", () => {
    const sites = defineSites([
      { name: "marketing", render: "static", basePath: "/", pages: ["/"] },
      { name: "mls", render: "dynamic", basePath: "/mls" },
    ]);

    expect(sites.map((site) => site.name)).toEqual(["marketing", "mls"]);
  });

  it("rejects a site with an empty name", () => {
    try {
      defineSites([{ name: "", render: "dynamic", basePath: "/" }]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SitesError);
      expect((error as SitesError).code).toBe("SITES_EMPTY_NAME");
    }
  });

  it("rejects two sites with the same name", () => {
    expect(() =>
      defineSites([
        { name: "app", render: "dynamic", basePath: "/" },
        { name: "app", render: "dynamic", basePath: "/admin" },
      ]),
    ).toThrowError(expect.objectContaining({ code: "SITES_DUPLICATE_NAME" }));
  });

  it("rejects a basePath that is not rooted", () => {
    try {
      defineSites([{ name: "marketing", render: "static", basePath: "mls", pages: ["/"] }]);
      expect.unreachable();
    } catch (error) {
      expect((error as SitesError).code).toBe("SITES_INVALID_BASE_PATH");
      expect((error as SitesError).details["basePath"]).toBe("mls");
    }
  });

  it("rejects two sites mounted at the same basePath", () => {
    try {
      defineSites([
        { name: "a", render: "dynamic", basePath: "/app" },
        { name: "b", render: "dynamic", basePath: "/app" },
      ]);
      expect.unreachable();
    } catch (error) {
      expect((error as SitesError).code).toBe("SITES_DUPLICATE_BASE_PATH");
      expect((error as SitesError).details["basePath"]).toBe("/app");
    }
  });

  it("treats a trailing-slash basePath as the same mount (normalized)", () => {
    // `/app` and `/app/` are the same zone — the trailing slash must not slip a
    // second site past the collision guard.
    expect(() =>
      defineSites([
        { name: "a", render: "dynamic", basePath: "/app" },
        { name: "b", render: "dynamic", basePath: "/app/" },
      ]),
    ).toThrowError(expect.objectContaining({ code: "SITES_DUPLICATE_BASE_PATH" }));
  });
});

describe("prerenderSite", () => {
  it("renders a root site's pages via the app handler", async () => {
    const { handle, calls } = echoHandler();

    const site: StaticSite = {
      name: "marketing",
      render: "static",
      basePath: "/",
      pages: ["/", "/about"],
    };

    const pages = await prerenderSite(site, handle);

    // basePath "/" leaves routes as-is; "/" stays "/". Each page also carries the
    // raw bytes the sink will write; `html` is their UTF-8 view.
    expect(calls).toEqual(["GET /", "GET /about"]);
    expect(pages).toEqual([
      {
        path: "/",
        outputPath: "marketing/index.html",
        status: 200,
        html: "<html>/</html>",
        body: new TextEncoder().encode("<html>/</html>"),
      },
      {
        path: "/about",
        outputPath: "marketing/about/index.html",
        status: 200,
        html: "<html>/about</html>",
        body: new TextEncoder().encode("<html>/about</html>"),
      },
    ]);
  });

  it("writes a file-extension route verbatim, not as a directory", async () => {
    const { handle } = echoHandler();

    const site: StaticSite = {
      name: "marketing",
      render: "static",
      basePath: "/",
      pages: ["/sitemap.xml"],
    };

    const [page] = await prerenderSite(site, handle);

    // sitemap.xml is an endpoint, not a page — it must not become a directory.
    expect(page?.outputPath).toBe("marketing/sitemap.xml");
  });

  it("prefixes a zone's basePath and resolves a function page source", async () => {
    const { handle, calls } = echoHandler();

    const site: StaticSite = {
      name: "listings",
      render: "static",
      basePath: "/mls",
      // Function form — pages derived at build time (e.g. from a collection).
      pages: () => ["/", "/listings/villa-1"],
    };

    const pages = await prerenderSite(site, handle);

    expect(calls).toEqual(["GET /mls", "GET /mls/listings/villa-1"]);
    expect(pages.map((page) => page.path)).toEqual(["/mls", "/mls/listings/villa-1"]);
    expect(pages.map((page) => page.outputPath)).toEqual([
      "listings/index.html",
      "listings/listings/villa-1/index.html",
    ]);
  });

  // A static site is the live app rendered offline, so prerendering must capture
  // whatever body arm the handler produced — string, bytes, stream, or none — as
  // raw bytes. These cases pin down every branch of `bodyToBytes`.
  const onePage: StaticSite = { name: "marketing", render: "static", basePath: "/", pages: ["/"] };

  it("captures a string body verbatim, as UTF-8 bytes", async () => {
    const [page] = await prerenderSite(onePage, bodyHandler("<html>hi</html>"));

    expect(page?.html).toBe("<html>hi</html>");
    expect(page?.body).toEqual(new TextEncoder().encode("<html>hi</html>"));
  });

  it("captures an absent body as empty bytes", async () => {
    // No body (e.g. a 204) becomes an empty file, not the string "undefined".
    const [page] = await prerenderSite(onePage, bodyHandler(undefined));

    expect(page?.html).toBe("");
    expect(page?.body).toEqual(new Uint8Array(0));
  });

  it("passes a Uint8Array body through untouched", async () => {
    const bytes = new TextEncoder().encode("<html>bytes</html>");
    const [page] = await prerenderSite(onePage, bodyHandler(bytes));

    expect(page?.body).toBe(bytes);
    expect(page?.html).toBe("<html>bytes</html>");
  });

  it("preserves a binary (non-UTF-8) body bit-exact", async () => {
    // Bytes a string seam would corrupt: a PNG signature, a lone 0xFF, a NUL.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
    const [page] = await prerenderSite(onePage, bodyHandler(png));

    expect(Array.from(page?.body ?? [])).toEqual(Array.from(png));
  });

  it("drains a multi-chunk ReadableStream body in order, concatenating bytes", async () => {
    // The `.page` routes stream React SSR this way; the prerenderer must read the
    // stream to completion and concatenate the chunks in the order they arrive —
    // including chunks that are not valid UTF-8 on their own.
    const chunks = [
      new TextEncoder().encode("<html>"),
      new Uint8Array([0x00, 0xff]),
      new TextEncoder().encode("</html>"),
    ];

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });

    const [page] = await prerenderSite(onePage, bodyHandler(stream));

    const expected = new Uint8Array([
      ...new TextEncoder().encode("<html>"),
      0x00,
      0xff,
      ...new TextEncoder().encode("</html>"),
    ]);
    expect(Array.from(page?.body ?? [])).toEqual(Array.from(expected));
  });
});

describe("writePages", () => {
  it("hands every page's bytes to the sink", async () => {
    const written = new Map<string, Uint8Array>();
    const sink: OutputSink = (path: string, contents: Uint8Array | string) => {
      written.set(
        path,
        typeof contents === "string" ? new TextEncoder().encode(contents) : contents,
      );

      return Promise.resolve();
    };

    const pages: RenderedPage[] = [
      {
        path: "/",
        outputPath: "a/index.html",
        status: 200,
        html: "<a>",
        body: new TextEncoder().encode("<a>"),
      },
      {
        path: "/b",
        outputPath: "a/b/index.html",
        status: 200,
        html: "<b>",
        body: new TextEncoder().encode("<b>"),
      },
    ];

    await writePages(pages, sink);

    // The sink receives the raw `body`, not the decoded `html` view.
    expect(written.get("a/index.html")).toEqual(new TextEncoder().encode("<a>"));
    expect(written.get("a/b/index.html")).toEqual(new TextEncoder().encode("<b>"));
  });

  it("writes a binary page's bytes through the sink bit-exact", async () => {
    const captured: Uint8Array[] = [];
    const sink: OutputSink = (_path, contents: Uint8Array | string) => {
      captured.push(contents as Uint8Array);

      return Promise.resolve();
    };

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const pages: RenderedPage[] = [
      { path: "/logo.png", outputPath: "a/logo.png", status: 200, html: "", body: png },
    ];

    await writePages(pages, sink);

    expect(captured[0]).toBe(png);
  });
});

describe("nodeSink", () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("writes a page to disk, creating its directories (string convenience arm)", async () => {
    root = await mkdtemp(join(tmpdir(), "keel-sites-"));

    const sink = nodeSink(root);
    await sink("marketing/about/index.html", "<html>about</html>");

    const written = await readFile(join(root, "marketing/about/index.html"), "utf8");
    expect(written).toBe("<html>about</html>");
  });

  it("writes binary bytes to disk bit-exact (the canonical byte arm)", async () => {
    root = await mkdtemp(join(tmpdir(), "keel-sites-"));

    const sink = nodeSink(root);
    // Bytes a UTF-8 string seam would corrupt: a PNG signature, a lone 0xFF, a NUL.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
    await sink("assets/logo.png", png);

    const written = await readFile(join(root, "assets/logo.png"));
    expect(Array.from(written)).toEqual(Array.from(png));
  });

  it("refuses to write outside the output root", async () => {
    root = await mkdtemp(join(tmpdir(), "keel-sites-"));

    const sink = nodeSink(root);

    // A `..` slug must not let a build write over the filesystem.
    await expect(sink("../escaped.html", "x")).rejects.toMatchObject({
      code: "SITES_PATH_ESCAPE",
    });
  });
});

describe("buildStaticSites", () => {
  it("prerenders every static site, writes them, and returns a manifest", async () => {
    const { handle, calls } = echoHandler();
    const { sink, written } = mapSink();

    const sites: readonly Site[] = [
      { name: "marketing", render: "static", basePath: "/", pages: ["/", "/about"] },
      { name: "listings", render: "static", basePath: "/mls", pages: ["/"] },
    ];

    const manifest = await buildStaticSites(sites, handle, sink);

    // Every static page was rendered through the app's own handler. Sites
    // prerender concurrently, so assert the set rather than the interleaving.
    expect(calls.toSorted()).toEqual(["GET /", "GET /about", "GET /mls"]);

    // And every rendered page was written through the sink.
    expect(written.get("marketing/index.html")).toBe("<html>/</html>");
    expect(written.get("marketing/about/index.html")).toBe("<html>/about</html>");
    expect(written.get("listings/index.html")).toBe("<html>/mls</html>");

    expect(manifest).toEqual([
      {
        site: "marketing",
        pages: [
          { path: "/", outputPath: "marketing/index.html", status: 200 },
          { path: "/about", outputPath: "marketing/about/index.html", status: 200 },
        ],
      },
      {
        site: "listings",
        pages: [{ path: "/mls", outputPath: "listings/index.html", status: 200 }],
      },
    ]);
  });

  it("skips dynamic sites entirely", async () => {
    const { handle, calls } = echoHandler();
    const { sink, written } = mapSink();

    const sites: readonly Site[] = [
      { name: "marketing", render: "static", basePath: "/", pages: ["/"] },
      { name: "app", render: "dynamic", basePath: "/app" },
    ];

    const manifest = await buildStaticSites(sites, handle, sink);

    // The dynamic site is served live — it is neither rendered nor written.
    expect(calls).toEqual(["GET /"]);
    expect(written.has("app/index.html")).toBe(false);
    expect(manifest.map((entry) => entry.site)).toEqual(["marketing"]);
  });

  it("fails the build on a non-2xx page and writes nothing", async () => {
    const calls: string[] = [];

    // The second page 404s; the build must refuse the whole set.
    const handle: PageHandler = (_method, path) => {
      calls.push(path);

      return Promise.resolve(
        path === "/missing"
          ? { status: 404, body: "not found" }
          : { status: 200, body: `<html>${path}</html>` },
      );
    };

    const { sink, written } = mapSink();

    const sites: readonly Site[] = [
      { name: "marketing", render: "static", basePath: "/", pages: ["/", "/missing"] },
    ];

    try {
      await buildStaticSites(sites, handle, sink);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SitesError);
      expect((error as SitesError).code).toBe("SITES_PAGE_FAILED");
      expect((error as SitesError).details["failures"]).toEqual([
        { site: "marketing", path: "/missing", status: 404 },
      ]);
    }

    // Nothing is written when any page fails — the build is all-or-nothing, even
    // for the pages that did render cleanly before the failure.
    expect(written.size).toBe(0);
  });

  it("treats any 2xx (e.g. 204) as a clean render", async () => {
    const handle = statusHandler(204);

    const { sink, written } = mapSink();

    const sites: readonly Site[] = [
      { name: "marketing", render: "static", basePath: "/", pages: ["/"] },
    ];

    const manifest = await buildStaticSites(sites, handle, sink);

    expect(manifest[0]?.pages[0]?.status).toBe(204);
    expect(written.get("marketing/index.html")).toBe("<html>/</html>");
  });
});
