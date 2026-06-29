import { describe, expect, it } from "vitest";

import { toOpenApi } from "@lesto/openapi";

import { buildResources, describeApp, listResources, readResource } from "../src/resources";
import { McpError } from "../src/errors";

import type { App } from "@lesto/kernel";
import type { AppSchemaShape, ContentModules, LestoMcpContext } from "../src/tools";

const routes = [
  { method: "GET", pattern: "/posts" },
  { method: "POST", pattern: "/posts" },
];

// A minimal content surface whose only used method is `getCollections`; cast to the
// optional-peer shape so this test takes no content-package dependency.
const fakeLoadContent =
  (
    collections: { name: string; entries: readonly unknown[] }[],
  ): NonNullable<LestoMcpContext["loadContent"]> =>
  () =>
    Promise.resolve({ core: { getCollections: () => collections } } as ContentModules);

function context(overrides: Partial<LestoMcpContext> = {}): LestoMcpContext {
  return {
    app: {} as App,
    routes,
    audit: () => {
      /* unused by the read-only resource builders */
    },
    ...overrides,
  };
}

describe("buildResources", () => {
  it("returns the four contract resources with stable URIs in stable order", () => {
    const resources = buildResources(context());

    expect(resources.map((resource) => resource.uri)).toEqual([
      "lesto://routes",
      "lesto://openapi",
      "lesto://collections",
      "lesto://schema",
    ]);

    for (const resource of resources) {
      expect(resource.mimeType).toBe("application/json");
      expect(resource.name.length).toBeGreaterThan(0);
    }
  });

  it("route-map read() returns the context's routes", async () => {
    const [routeMap] = buildResources(context());

    expect(await routeMap?.read()).toEqual(routes);
  });

  it("openapi read() equals toOpenApi(routes, info) with the app's supplied info", async () => {
    const openApiInfo = { title: "Estate", version: "1.2.3" };
    const resources = buildResources(context({ openApiInfo }));
    const openapi = resources.find((resource) => resource.uri === "lesto://openapi");

    expect(await openapi?.read()).toEqual(toOpenApi(routes, openApiInfo));
  });

  it("openapi read() falls back to a default info when the app supplies none", async () => {
    const resources = buildResources(context());
    const openapi = resources.find((resource) => resource.uri === "lesto://openapi");

    expect(await openapi?.read()).toEqual(
      toOpenApi(routes, { title: "Lesto API", version: "0.0.0" }),
    );
  });

  it("collections read() mirrors getCollections() as { name, count } when peers are wired", async () => {
    const resources = buildResources(
      context({
        loadContent: fakeLoadContent([
          { name: "posts", entries: [1, 2, 3] },
          { name: "pages", entries: [1] },
        ]),
      }),
    );
    const collections = resources.find((resource) => resource.uri === "lesto://collections");

    expect(await collections?.read()).toEqual([
      { name: "posts", count: 3 },
      { name: "pages", count: 1 },
    ]);
  });

  it("collections read() degrades to an empty list when content peers are absent (no throw)", async () => {
    const resources = buildResources(context());
    const collections = resources.find((resource) => resource.uri === "lesto://collections");

    expect(await collections?.read()).toEqual([]);
  });

  it("collections read() degrades to [] when the loader THROWS MCP_CONTENT_PACKAGES_MISSING (the real-server case)", async () => {
    // The real stdio server always wires a default loader that throws this rather than
    // leaving `loadContent` absent; reading the contract must still never refuse.
    const resources = buildResources(
      context({
        loadContent: () =>
          Promise.reject(new McpError("MCP_CONTENT_PACKAGES_MISSING", "peers not installed")),
      }),
    );
    const collections = resources.find((resource) => resource.uri === "lesto://collections");

    expect(await collections?.read()).toEqual([]);
  });

  it("collections read() rethrows a loader error that is NOT the missing-peers refusal", async () => {
    const boom = new Error("the content store is on fire");
    const resources = buildResources(context({ loadContent: () => Promise.reject(boom) }));
    const collections = resources.find((resource) => resource.uri === "lesto://collections");

    await expect(collections?.read()).rejects.toBe(boom);
  });

  it("schema read() returns the app's declared shape when present", async () => {
    const schema: AppSchemaShape = {
      migrations: ["001_create_posts"],
      tables: [{ name: "posts", columns: [{ name: "id", type: "integer" }] }],
    };
    const resources = buildResources(context({ schema }));
    const shape = resources.find((resource) => resource.uri === "lesto://schema");

    expect(await shape?.read()).toEqual(schema);
  });

  it("schema read() degrades to an empty-but-valid shape when none is declared", async () => {
    const resources = buildResources(context());
    const shape = resources.find((resource) => resource.uri === "lesto://schema");

    expect(await shape?.read()).toEqual({ migrations: [], tables: [] });
  });
});

describe("listResources", () => {
  it("includes a description only for the resources that carry one", () => {
    const listed = listResources(buildResources(context())).resources;

    // The route map and collections have no caveat; openapi and schema do.
    const byUri = Object.fromEntries(listed.map((resource) => [resource.uri, resource]));

    expect(byUri["lesto://routes"]).toEqual({
      uri: "lesto://routes",
      name: "Route map",
      mimeType: "application/json",
    });
    expect(byUri["lesto://routes"]).not.toHaveProperty("description");

    expect(byUri["lesto://openapi"]?.description).toContain("Route-shape skeleton only");
    expect(byUri["lesto://schema"]?.description).toContain("Declared shape only");
  });
});

describe("describeApp", () => {
  it("returns the same four-part contract as the resources (no drift)", async () => {
    const ctx = context({
      openApiInfo: { title: "Estate", version: "1.0.0" },
      schema: { migrations: ["001_create_posts"], tables: [] },
      loadContent: fakeLoadContent([{ name: "posts", entries: [1, 2] }]),
    });

    const payload = await describeApp(ctx);
    const resources = buildResources(ctx);
    const read = (uri: string): Promise<unknown> | unknown =>
      resources.find((resource) => resource.uri === uri)?.read();

    expect(payload.routes).toEqual(await read("lesto://routes"));
    expect(payload.openapi).toEqual(await read("lesto://openapi"));
    expect(payload.collections).toEqual(await read("lesto://collections"));
    expect(payload.schema).toEqual(await read("lesto://schema"));
  });

  it("graceful-degrades on a content-less, schema-less app", async () => {
    const payload = await describeApp(context());

    expect(payload.collections).toEqual([]);
    expect(payload.schema).toEqual({ migrations: [], tables: [] });
  });
});

describe("readResource", () => {
  it("renders a resource body as JSON text under MCP `contents`", async () => {
    const resources = buildResources(context());

    expect(await readResource(resources, "lesto://routes")).toEqual({
      contents: [
        { uri: "lesto://routes", mimeType: "application/json", text: JSON.stringify(routes) },
      ],
    });
  });

  it("refuses an unknown URI with MCP_UNKNOWN_RESOURCE", async () => {
    const resources = buildResources(context());

    await expect(readResource(resources, "lesto://nope")).rejects.toMatchObject({
      code: "MCP_UNKNOWN_RESOURCE",
    });

    const error = await readResource(resources, "lesto://nope").catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(McpError);
  });
});
