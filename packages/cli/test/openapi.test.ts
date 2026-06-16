import { beforeEach, describe, expect, it } from "vitest";

import { keel } from "@keel/web";
import type { KeelAppConfig, KernelDatabase } from "@keel/kernel";

import { runOpenApi } from "../src/openapi";
import type { OpenApiDeps } from "../src/openapi";

// The CLI core never touches the db — it reads the declared route list off the
// `keel()` app — so a sentinel stands in for it.
const sentinelDb = {} as unknown as KernelDatabase;

// A representative app: public posts routes plus a health probe and an admin
// zone, so the exclude filter has something to drop.
function buildConfig(): KeelAppConfig {
  const app = keel()
    .get("/posts", (c) => c.json({ posts: [] }))
    .post("/posts", (c) => c.json({ created: true }, 201))
    .get("/posts/:id", (c) => c.json({ id: c.param("id") }))
    .get("/healthz", (c) => c.json({ ok: true }))
    .get("/admin/flush", (c) => c.json({ flushed: true }));

  return { db: sentinelDb, app };
}

// Capture the written file and the printed output.
let written: { path: string; contents: string }[];
let lines: string[];

function depsWith(overrides: Partial<OpenApiDeps> = {}): OpenApiDeps {
  return {
    loadApp: () => Promise.resolve(buildConfig()),
    write: (path, contents) => {
      written.push({ path, contents });

      return Promise.resolve();
    },
    out: (line) => lines.push(line),
    ...overrides,
  };
}

beforeEach(() => {
  written = [];
  lines = [];
});

function writtenSpec(): Record<string, unknown> {
  return JSON.parse(written[0]?.contents ?? "{}") as Record<string, unknown>;
}

describe("runOpenApi", () => {
  it("writes a valid OpenAPI 3.1 document to openapi.json by default", async () => {
    const code = await runOpenApi([], depsWith());

    expect(code).toBe(0);
    expect(written[0]?.path).toBe("openapi.json");

    const spec = writtenSpec();

    expect(spec["openapi"]).toBe("3.1.0");
    expect(spec["info"]).toEqual({ title: "Keel API", version: "0.0.0" });

    const paths = spec["paths"] as Record<string, unknown>;

    // Every public route appears (params templated); nothing was filtered.
    expect(Object.keys(paths).toSorted()).toEqual([
      "/admin/flush",
      "/healthz",
      "/posts",
      "/posts/{id}",
    ]);
  });

  it("honors --out for the destination path", async () => {
    await runOpenApi(["--out", "docs/api.json"], depsWith());

    expect(written[0]?.path).toBe("docs/api.json");
  });

  it("excludes routes under a --exclude prefix", async () => {
    await runOpenApi(["--exclude", "/healthz", "--exclude", "/admin"], depsWith());

    const paths = writtenSpec()["paths"] as Record<string, unknown>;

    expect(Object.keys(paths).toSorted()).toEqual(["/posts", "/posts/{id}"]);
  });

  it("tolerates a trailing --exclude with no value", async () => {
    await runOpenApi(["--exclude"], depsWith());

    // No prefix named, so nothing is excluded.
    const paths = writtenSpec()["paths"] as Record<string, unknown>;

    expect(Object.keys(paths)).toHaveLength(4);
  });

  it("reports the written path, the exported path count, and the schema limitation", async () => {
    await runOpenApi(["--exclude", "/admin"], depsWith());

    expect(lines).toEqual([
      "wrote openapi.json: 3 paths",
      "note: request/response schemas are not yet emitted (Zod extraction is post-1.0)",
    ]);
  });
});
