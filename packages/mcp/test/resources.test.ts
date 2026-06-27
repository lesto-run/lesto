import { describe, expect, it } from "vitest";

import { buildResources, listResources, readResource } from "../src/resources";
import { McpError } from "../src/errors";

import type { App } from "@lesto/kernel";
import type { LestoMcpContext } from "../src/tools";

const routes = [
  { method: "GET", pattern: "/posts" },
  { method: "POST", pattern: "/posts" },
];

// `buildResources` reads only `context.routes` in Increment 1; the rest of the
// context is unused here, so a minimal stub suffices.
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
  it("returns the route-map resource with a stable URI and JSON mimeType", () => {
    const resources = buildResources(context());

    expect(resources.map((resource) => resource.uri)).toEqual(["lesto://routes"]);
    expect(resources[0]?.name).toBe("Route map");
    expect(resources[0]?.mimeType).toBe("application/json");
  });

  it("route-map read() returns the context's routes", async () => {
    const resources = buildResources(context());

    expect(await resources[0]?.read()).toEqual(routes);
  });
});

describe("listResources", () => {
  it("projects each resource to its metadata only, in stable order", () => {
    const resources = buildResources(context());

    expect(listResources(resources)).toEqual({
      resources: [{ uri: "lesto://routes", name: "Route map", mimeType: "application/json" }],
    });
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
