/**
 * The HTTP spine, end to end over a real socket.
 *
 * Every other suite tests the dispatcher as a pure function — `app.handle` with
 * a fabricated request. This one boots an actual `node:http` server with
 * `@keel/runtime`'s `serve`, then hits it with the platform's real `fetch`. That
 * exercises the layer the pure tests *mock*: the socket read, body decoding,
 * header flattening, the response write, and the per-request error boundary.
 *
 * It is here because that boundary is where launch-blocking bugs hide — a
 * request header that never reaches a controller, a malformed body that crashes
 * the process, a response cookie dropped on the way out. Each is a case below.
 */

import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "@keel/kernel";
import type { KeelAppConfig, KernelDatabase } from "@keel/kernel";
import { serve } from "@keel/runtime";
import type { Server } from "@keel/runtime";
import { keel } from "@keel/web";

// ---- A real-enough app: handlers that report back what they received. ----

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

function buildConfig(database: Database.Database): KeelAppConfig {
  const app = keel()
    // Render an HTML page.
    .get("/", (c) => c.html("<h1>Home</h1>"))
    // Reflect the request's cookie header — proves headers reach the handler.
    .get("/echo/headers", (c) => c.json({ cookie: c.header("cookie") ?? null }))
    // Reflect the decoded body — proves the JSON body path.
    .post("/echo/body", (c) => c.json({ body: c.req.body }))
    // Reflect the parsed query string.
    .get("/echo/query", (c) => c.json({ query: c.req.query }))
    // Set a cookie — proves a response Set-Cookie survives to the client.
    .post("/session", () => ({
      status: 200,
      headers: { "Set-Cookie": "sid=abc; HttpOnly" },
      body: "ok",
    }))
    // Throw — proves the per-request error boundary maps it to 500, not a crash.
    .get("/boom", () => {
      throw new Error("kaboom");
    });

  return {
    db: adapt(database),
    app,
  };
}

let database: Database.Database;
let server: Server;
let base: string;

beforeAll(async () => {
  database = new Database(":memory:");

  // Silence the expected 500's log line so the boundary test isn't noisy.
  server = await serve(await createApp(buildConfig(database)), { port: 0, logError: () => {} });

  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  database.close();
});

describe("the live HTTP server", () => {
  it("renders an HTML page", async () => {
    const response = await fetch(`${base}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("<h1>Home</h1>");
  });

  it("threads request headers through to the controller (the cookie a session reads)", async () => {
    const response = await fetch(`${base}/echo/headers`, { headers: { cookie: "sid=xyz" } });

    expect(await response.json()).toEqual({ cookie: "sid=xyz" });
  });

  it("returns the controller's Set-Cookie verbatim to the client", async () => {
    const response = await fetch(`${base}/session`, { method: "POST" });

    expect(response.headers.get("set-cookie")).toBe("sid=abc; HttpOnly");
  });

  it("parses a JSON request body", async () => {
    const response = await fetch(`${base}/echo/body`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Hello" }),
    });

    expect(await response.json()).toEqual({ body: { title: "Hello" } });
  });

  it("answers a malformed JSON body with 400 — and stays up", async () => {
    const bad = await fetch(`${base}/echo/body`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    expect(bad.status).toBe(400);

    // The process survived a malformed client body — the next request is fine.
    expect((await fetch(`${base}/`)).status).toBe(200);
  });

  it("parses the query string", async () => {
    const response = await fetch(`${base}/echo/query?a=1&b=two`);

    expect(await response.json()).toEqual({ query: { a: "1", b: "two" } });
  });

  it("contains a throwing controller at 500 — the error boundary holds the process", async () => {
    const boom = await fetch(`${base}/boom`);

    expect(boom.status).toBe(500);
    expect(await boom.text()).not.toContain("kaboom"); // internals never leak

    // The server did not crash: a normal request still succeeds afterward.
    expect((await fetch(`${base}/`)).status).toBe(200);
  });

  it("404s an unknown route", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});

describe("the body-size limit", () => {
  it("refuses a body past the limit with 413 (no unbounded memory)", async () => {
    const db = new Database(":memory:");
    const tiny = await serve(await createApp(buildConfig(db)), { port: 0, maxBodyBytes: 16 });

    try {
      const response = await fetch(`http://127.0.0.1:${tiny.port}/echo/body`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: "x".repeat(1000) }),
      });

      expect(response.status).toBe(413);
    } finally {
      await tiny.close();
      db.close();
    }
  });
});
