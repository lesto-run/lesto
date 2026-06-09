import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  defineSites,
  nodeSink,
  prerenderSite,
  SitesError,
  writePages,
  type OutputSink,
  type PageHandler,
  type RenderedPage,
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

    // basePath "/" leaves routes as-is; "/" stays "/".
    expect(calls).toEqual(["GET /", "GET /about"]);
    expect(pages).toEqual([
      { path: "/", outputPath: "marketing/index.html", status: 200, html: "<html>/</html>" },
      {
        path: "/about",
        outputPath: "marketing/about/index.html",
        status: 200,
        html: "<html>/about</html>",
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
});

describe("writePages", () => {
  it("hands every page to the sink", async () => {
    const written = new Map<string, string>();
    const sink: OutputSink = (path, contents) => {
      written.set(path, contents);

      return Promise.resolve();
    };

    const pages: RenderedPage[] = [
      { path: "/", outputPath: "a/index.html", status: 200, html: "<a>" },
      { path: "/b", outputPath: "a/b/index.html", status: 200, html: "<b>" },
    ];

    await writePages(pages, sink);

    expect(written.get("a/index.html")).toBe("<a>");
    expect(written.get("a/b/index.html")).toBe("<b>");
  });
});

describe("nodeSink", () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("writes a page to disk, creating its directories", async () => {
    root = await mkdtemp(join(tmpdir(), "keel-sites-"));

    const sink = nodeSink(root);
    await sink("marketing/about/index.html", "<html>about</html>");

    const written = await readFile(join(root, "marketing/about/index.html"), "utf8");
    expect(written).toBe("<html>about</html>");
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
