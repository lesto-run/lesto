/**
 * The Sites front door, end to end over a real socket.
 *
 * `dispatchSites` is unit-tested as a pure function with a fake reader; this
 * boots it behind a real `node:http` server with the *real* `nodeStaticReader`
 * over a *real* directory, and proves the two-zones-one-origin model at the HTTP
 * layer: prerendered files for the static zone, the live app for the dynamic
 * one, an asset (`/client.js`) served from disk, and longest-prefix routing —
 * the runtime-level counterpart to the example's pipeline test.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "@volo/kernel";
import type { VoloAppConfig, KernelDatabase } from "@volo/kernel";
import { dispatchSites, nodeStaticReader, serve } from "@volo/runtime";
import type { Server } from "@volo/runtime";
import { defineSites } from "@volo/sites";
import { volo } from "@volo/web";

function adapt(raw: Database.Database): KernelDatabase {
  const adapted: KernelDatabase = {
    exec: async (sql) => {
      raw.exec(sql);
    },
    prepare: (sql) => {
      const statement = raw.prepare(sql);

      return {
        run: async (params = []) => statement.run(...(params as never[])),
        get: async (params = []) => statement.get(...(params as never[])),
        all: async (params = []) => statement.all(...(params as never[])),
      };
    },
    transaction: async (fn) => {
      raw.exec("BEGIN");

      try {
        const out = await fn(adapted);
        raw.exec("COMMIT");

        return out;
      } catch (error) {
        try {
          raw.exec("ROLLBACK");
        } catch {
          /* preserve the original error */
        }

        throw error;
      }
    },
  };

  return adapted;
}

// The dynamic zone: a live app mounted under /app that reflects what it gets.
function buildDynamicApp(database: Database.Database): VoloAppConfig {
  const app = volo()
    .get("/app", (c) => c.json({ zone: "app" }))
    .get("/app/echo", (c) => c.json({ cookie: c.header("cookie") ?? null }));

  return { db: adapt(database), app };
}

const sites = defineSites([
  { name: "marketing", render: "static", basePath: "/", pages: ["/", "/about"] },
  { name: "app", render: "dynamic", basePath: "/app" },
]);

let database: Database.Database;
let server: Server;
let outDir: string;
let base: string;

beforeAll(async () => {
  // The prerendered static zone on disk, plus the island bundle beside it.
  outDir = await mkdtemp(join(tmpdir(), "volo-sites-int-"));
  await mkdir(join(outDir, "marketing", "about"), { recursive: true });
  await writeFile(join(outDir, "marketing", "index.html"), "<h1>Static Home</h1>", "utf8");
  await writeFile(join(outDir, "marketing", "about", "index.html"), "<h1>About</h1>", "utf8");
  await writeFile(join(outDir, "marketing", "client.js"), "/* island bundle */", "utf8");

  database = new Database(":memory:");
  const app = await createApp(buildDynamicApp(database));

  const dispatch = dispatchSites({
    sites,
    handle: app.handle.bind(app),
    readStatic: nodeStaticReader(outDir),
  });

  server = await serve({ handle: dispatch, migrationsApplied: [] }, { port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  database.close();
  await rm(outDir, { recursive: true, force: true });
});

describe("the sites front door over HTTP", () => {
  it("serves the static zone's prerendered home from disk", async () => {
    const response = await fetch(`${base}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("Static Home");
  });

  it("serves a nested static page (clean URL → index.html)", async () => {
    expect(await (await fetch(`${base}/about`)).text()).toContain("About");
  });

  it("serves the island bundle as an asset (/client.js → marketing/client.js)", async () => {
    const response = await fetch(`${base}/client.js`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(await response.text()).toBe("/* island bundle */");
  });

  it("routes the dynamic zone to the live app", async () => {
    const response = await fetch(`${base}/app`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ zone: "app" });
  });

  it("threads headers into the dynamic zone (longest-prefix routing picks /app)", async () => {
    const response = await fetch(`${base}/app/echo`, { headers: { cookie: "sid=zzz" } });

    expect(await response.json()).toEqual({ cookie: "sid=zzz" });
  });

  it("404s a static path with no prerendered file", async () => {
    expect((await fetch(`${base}/no-such-page`)).status).toBe(404);
  });
});
