import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { contentTypeFor, DeployError, nodeUploader, planDeploy, shipStatic } from "../src/index";

import type { ShipDeps, StaticTarget } from "../src/index";
import type { Site, SiteManifest } from "@keel/sites";

// A two-zone project: a static marketing site at the root, a dynamic app at /mls
// — the exact split the routing manifest exists to express.
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

// The manifest `buildStaticSites` would have produced for the static site.
const marketingManifest: SiteManifest = {
  site: "marketing",
  pages: [
    { path: "/", outputPath: "marketing/index.html", status: 200 },
    { path: "/about", outputPath: "marketing/about/index.html", status: 200 },
  ],
};

// A helper to pull one target out of a plan by its discriminant + site name.
function staticTarget(plan: ReturnType<typeof planDeploy>, site: string): StaticTarget {
  const target = plan.targets.find((t) => t.kind === "static" && t.site === site);

  if (target?.kind !== "static") throw new Error(`no static target "${site}"`);

  return target;
}

describe("contentTypeFor", () => {
  it("maps known extensions to their media type, case-insensitively", () => {
    expect(contentTypeFor("a/index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("sitemap.XML")).toBe("application/xml; charset=utf-8");
    expect(contentTypeFor("logo.SVG")).toBe("image/svg+xml");
    expect(contentTypeFor("font.woff2")).toBe("font/woff2");
  });

  it("falls back to a binary type for unknown or missing extensions", () => {
    expect(contentTypeFor("LICENSE")).toBe("application/octet-stream");
    expect(contentTypeFor("archive.tar.zzz")).toBe("application/octet-stream");
  });

  it("treats a trailing dot as no extension", () => {
    expect(contentTypeFor("weird.")).toBe("application/octet-stream");
  });
});

describe("planDeploy", () => {
  it("plans a static site into a CDN target of routed, typed files", () => {
    const plan = planDeploy([marketing], [marketingManifest]);
    const target = staticTarget(plan, "marketing");

    expect(target.kind).toBe("static");
    expect(target.basePath).toBe("/");
    expect(target.routing).toEqual({ basePath: "/", mode: "static" });

    expect(target.files).toEqual([
      { file: "marketing/index.html", route: "/", contentType: "text/html; charset=utf-8" },
      {
        file: "marketing/about/index.html",
        route: "/about",
        contentType: "text/html; charset=utf-8",
      },
    ]);
  });

  it("plans a dynamic site into a node target that runs `keel serve` and needs the db", () => {
    const plan = planDeploy([mls], []);

    expect(plan.targets).toEqual([
      {
        kind: "node",
        site: "mls",
        basePath: "/mls",
        routing: { basePath: "/mls", mode: "dynamic" },
        run: "keel serve",
        needsDatabase: true,
      },
    ]);
  });

  it("lets a deploy override the dynamic serve command", () => {
    const plan = planDeploy([mls], [], { serveCommand: "bun run start" });
    const target = plan.targets[0];

    expect(target?.kind === "node" && target.run).toBe("bun run start");
  });

  it("normalizes a zone prefix through sitePath (trailing slash collapses)", () => {
    const trailing: Site = { name: "docs", basePath: "/docs/", render: "dynamic" };

    const plan = planDeploy([trailing], []);

    expect(plan.targets[0]?.basePath).toBe("/docs");
  });

  it("orders routing rules most-specific first, so an edge can match longest-prefix", () => {
    const plan = planDeploy([marketing, mls], [marketingManifest]);

    // `/mls` (dynamic) must come before `/` (static): a request to /mls/listings
    // matches the dynamic rule first; everything else falls through to the CDN.
    expect(plan.routing).toEqual([
      { basePath: "/mls", mode: "dynamic" },
      { basePath: "/", mode: "static" },
    ]);
  });

  it("breaks ties between same-length prefixes lexically, for a stable order", () => {
    const a: Site = { name: "a", basePath: "/bbb", render: "dynamic" };
    const b: Site = { name: "b", basePath: "/aaa", render: "dynamic" };

    const plan = planDeploy([a, b], []);

    expect(plan.routing.map((rule) => rule.basePath)).toEqual(["/aaa", "/bbb"]);
  });

  it("refuses a static site missing from the build manifest", () => {
    try {
      planDeploy([marketing], []);
      expect.unreachable("planDeploy should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(DeployError);
      expect((error as DeployError).code).toBe("DEPLOY_UNKNOWN_SITE");
      expect((error as DeployError).details).toEqual({ site: "marketing" });
    }
  });

  it("plans an empty site set into an empty plan", () => {
    expect(planDeploy([], [])).toEqual({ targets: [], routing: [] });
  });
});

describe("shipStatic", () => {
  it("reads each file and puts it through the injected uploader, in plan order", async () => {
    const plan = planDeploy([marketing], [marketingManifest]);
    const target = staticTarget(plan, "marketing");

    // An in-memory uploader: capture every put, serve a body keyed by file.
    const puts: { key: string; contents: string; contentType: string }[] = [];

    const deps: ShipDeps = {
      read: (outRoot, file) => Promise.resolve(`<${outRoot}:${file}>`),
      put: (key, contents, contentType) => {
        puts.push({ key, contents, contentType });

        return Promise.resolve();
      },
    };

    const result = await shipStatic(target, "out", deps);

    expect(result).toEqual({ site: "marketing", routes: ["/", "/about"] });

    expect(puts).toEqual([
      {
        key: "marketing/index.html",
        contents: "<out:marketing/index.html>",
        contentType: "text/html; charset=utf-8",
      },
      {
        key: "marketing/about/index.html",
        contents: "<out:marketing/about/index.html>",
        contentType: "text/html; charset=utf-8",
      },
    ]);
  });
});

describe("nodeUploader", () => {
  let outRoot: string;
  let distRoot: string;

  beforeEach(async () => {
    outRoot = await mkdtemp(join(tmpdir(), "keel-deploy-out-"));
    distRoot = await mkdtemp(join(tmpdir(), "keel-deploy-dist-"));
  });

  afterEach(async () => {
    await rm(outRoot, { recursive: true, force: true });
    await rm(distRoot, { recursive: true, force: true });
  });

  it("copies built files from the output root into the dist root, tree intact", async () => {
    await writeFile(join(outRoot, "page.html"), "<h1>hi</h1>", "utf8");

    const target: StaticTarget = {
      kind: "static",
      site: "marketing",
      basePath: "/",
      routing: { basePath: "/", mode: "static" },
      files: [{ file: "page.html", route: "/", contentType: "text/html; charset=utf-8" }],
    };

    const result = await shipStatic(target, outRoot, nodeUploader(distRoot));

    expect(result.routes).toEqual(["/"]);
    expect(await readFile(join(distRoot, "page.html"), "utf8")).toBe("<h1>hi</h1>");
  });

  it("creates nested directories under the dist root as needed", async () => {
    const deps = nodeUploader(distRoot);

    await deps.put("a/b/c.html", "nested", "text/html; charset=utf-8");

    expect(await readFile(join(distRoot, "a/b/c.html"), "utf8")).toBe("nested");
  });

  it("refuses to publish a file that escapes the dist root", async () => {
    const deps = nodeUploader(distRoot);

    await expect(deps.put("../escape.html", "nope", "text/html")).rejects.toMatchObject({
      code: "DEPLOY_PATH_ESCAPE",
    });
  });
});
