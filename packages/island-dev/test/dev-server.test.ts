/**
 * `createIslandDevServer` is pure orchestration over the injected Vite backend, so a
 * fake `IslandDevDeps` drives every branch: the dialect is validated BEFORE any IO,
 * the islands feed the synthesized entry + config handed to the backend, the four
 * seams delegate, and a backend that fails to start is wrapped as a coded error.
 */

import type { IslandFile } from "@lesto/assets";
import { describe, expect, it, vi } from "vitest";

import type { CreateBackendRequest, IslandDevBackend, IslandDevDeps } from "../src/dev-server";
import { createIslandDevServer } from "../src/dev-server";
import { IslandDevError } from "../src/errors";

const island: IslandFile = {
  name: "Counter",
  importPath: "/abs/app/islands/counter.tsx",
  lazy: false,
  ssr: false,
};

const okOptions = {
  root: "/proj",
  islandsDir: "/proj/app/islands",
  dialect: "react",
  vitePort: 24677,
  hmrPort: 24678,
} as const;

/** A fake backend whose three seams are spies returning canned values. */
function fakeBackend(): IslandDevBackend {
  return {
    handle: vi.fn(async () => ({ status: 200, headers: {}, body: "module-code" })),
    transformHtml: vi.fn(async (_url: string, html: string) => `${html}<!--vite-->`),
    close: vi.fn(async () => undefined),
  };
}

/** Fake deps, capturing the backend request and letting tests override the two seams. */
function fakeDeps(
  over: Partial<{
    islands: readonly IslandFile[];
    backend: IslandDevBackend;
    createBackend: IslandDevDeps["createBackend"];
  }> = {},
): {
  deps: IslandDevDeps;
  listIslands: ReturnType<typeof vi.fn>;
  requests: CreateBackendRequest[];
} {
  const requests: CreateBackendRequest[] = [];
  const backend = over.backend ?? fakeBackend();

  const listIslands = vi.fn(async () => over.islands ?? [island]);

  const createBackend =
    over.createBackend ??
    (async (request: CreateBackendRequest) => {
      requests.push(request);

      return backend;
    });

  return { deps: { listIslands, createBackend }, listIslands, requests };
}

describe("createIslandDevServer", () => {
  it("lists islands, builds the entry + config, and delegates the four seams", async () => {
    const { deps, requests } = fakeDeps();

    const server = await createIslandDevServer(okOptions, deps);

    // The backend got the synthesized entry, the react config, and the plugin spec.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.pluginSpec).toEqual({ dialect: "react", module: "@vitejs/plugin-react" });
    expect(requests[0]?.entrySource).toContain("/abs/app/islands/counter.tsx");
    expect(requests[0]?.config.server.port).toBe(24677);
    expect(requests[0]?.config.resolve.alias).toEqual([]);

    // ownsPath is the shared predicate.
    expect(server.ownsPath("/client.js")).toBe(true);
    expect(server.ownsPath("/about")).toBe(false);

    // handle / transformHtml / close delegate to the backend.
    const response = await server.handle("GET", "/client.js");
    expect(response.body).toBe("module-code");

    expect(await server.transformHtml("/", "<html></html>")).toBe("<html></html><!--vite-->");

    await server.close();
  });

  it("threads the public-env define into the backend config", async () => {
    const publicEnvDefine = { "process.env.PUBLIC_X": '"1"' };
    const { deps, requests } = fakeDeps();

    await createIslandDevServer({ ...okOptions, publicEnvDefine }, deps);

    expect(requests[0]?.config.define).toEqual(publicEnvDefine);
  });

  it("validates the dialect BEFORE any IO", async () => {
    const { deps, listIslands } = fakeDeps();

    await expect(
      createIslandDevServer({ ...okOptions, dialect: "vue" }, deps),
    ).rejects.toMatchObject({ code: "ISLAND_DEV_UNKNOWN_DIALECT" });

    expect(listIslands).not.toHaveBeenCalled();
  });

  it("wraps a backend startup failure as a coded error carrying the cause", async () => {
    const cause = new Error("EADDRINUSE: hmr port taken");
    const { deps } = fakeDeps({
      createBackend: async () => {
        throw cause;
      },
    });

    let caught: unknown;

    try {
      await createIslandDevServer(okOptions, deps);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(IslandDevError);
    expect((caught as IslandDevError).code).toBe("ISLAND_DEV_SERVER_FAILED");
    expect((caught as IslandDevError).details).toEqual({ cause });
  });
});
