import { request as httpRequest } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { currentContext } from "@keel/web";

import { serve } from "../src/index";
import { establishContext } from "../src/server";

import type { ContextSource } from "../src/server";
import type { App } from "@keel/kernel";
import type { AccessEntry, Server } from "../src/index";

describe("establishContext", () => {
  it("stamps the request id and the socket peer ip with trustProxy off", () => {
    const source: ContextSource = {
      socket: { remoteAddress: "203.0.113.5" },
      headers: { "x-forwarded-for": "1.2.3.4", "x-forwarded-proto": "https" },
    };

    const context = establishContext(source, false, "id-1");

    expect(context.requestId).toBe("id-1");
    expect(context.ip).toBe("203.0.113.5");
    expect(context.protocol).toBe("http");
  });

  it("believes the forwarding headers when the peer is trusted", () => {
    const source: ContextSource = {
      socket: { remoteAddress: "10.0.0.1" },
      headers: { "x-forwarded-for": "1.2.3.4", "x-forwarded-proto": "https" },
    };

    const context = establishContext(source, true, "id-2");

    expect(context.ip).toBe("1.2.3.4");
    expect(context.protocol).toBe("https");
  });

  it("collapses a repeated forwarding header to its first value", () => {
    const source: ContextSource = {
      socket: { remoteAddress: "10.0.0.1" },
      headers: { "x-forwarded-for": ["1.2.3.4", "9.9.9.9"], "x-forwarded-proto": ["https"] },
    };

    const context = establishContext(source, true, "id-3");

    expect(context.ip).toBe("1.2.3.4");
    expect(context.protocol).toBe("https");
  });

  it("omits the ip key entirely when no address is resolvable", () => {
    const context = establishContext({ headers: {} }, false, "id-4");

    expect("ip" in context).toBe(false);
    expect(context.protocol).toBe("http");
  });
});

// Track the live server so each test tears its socket down, even on failure.
let server: Server | undefined;

afterEach(async () => {
  if (server !== undefined) {
    await server.close();
    server = undefined;
  }
});

function get(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method: "GET", path }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("serve — per-request context", () => {
  it("runs each request inside its own context and logs its id", async () => {
    const entries: AccessEntry[] = [];

    // The app reads currentContext() — the proof the runtime established it
    // around app.handle — and echoes the request id back in the body.
    const app: App = {
      migrationsApplied: [],
      handle: async () => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: currentContext()?.requestId ?? null }),
      }),
    };

    let n = 0;

    server = await serve(app, {
      port: 0,
      logRequest: (entry) => entries.push(entry),
      newRequestId: () => `req-${++n}`,
    });

    const first = JSON.parse(await get(server.port, "/")) as { requestId: string };
    const second = JSON.parse(await get(server.port, "/")) as { requestId: string };

    // Each request saw a distinct id inside its handler...
    expect(first.requestId).toBe("req-1");
    expect(second.requestId).toBe("req-2");

    // ...and the access log carries the matching ids — no leak between them.
    expect(entries.map((e) => e.requestId)).toEqual(["req-1", "req-2"]);
  });

  it("does not leak one request's context into the next (interleaved on the loop)", async () => {
    // Two concurrent requests share the event loop. The handler parks at an
    // await, so both are in flight at once; each must still observe only its
    // own context. If the ALS store leaked, the ids would cross.
    const seen: Record<string, string | null> = {};

    let n = 0;

    const app: App = {
      migrationsApplied: [],
      handle: async (_method, path) => {
        const id = currentContext()?.requestId ?? null;

        // Yield so the other request also enters its handler before we read.
        await new Promise((resolve) => setTimeout(resolve, 10));

        // Re-read after the await: still our own context, never the other's.
        seen[path] = currentContext()?.requestId ?? null;

        return { status: 200, headers: {}, body: JSON.stringify({ id }) };
      },
    };

    server = await serve(app, { port: 0, newRequestId: () => `id-${++n}`, logRequest: () => {} });

    await Promise.all([get(server.port, "/a"), get(server.port, "/b")]);

    // Each path observed a distinct id after its await — strict isolation.
    expect(seen["/a"]).not.toBeUndefined();
    expect(seen["/b"]).not.toBeUndefined();
    expect(seen["/a"]).not.toBe(seen["/b"]);
  });

  it("resolves the client ip from X-Forwarded-For when trustProxy is on", async () => {
    const app: App = {
      migrationsApplied: [],
      handle: async () => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ip: currentContext()?.ip ?? null }),
      }),
    };

    server = await serve(app, { port: 0, trustProxy: true, logRequest: () => {} });

    const body = await new Promise<string>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: server!.port,
          method: "GET",
          path: "/",
          headers: { "x-forwarded-for": "1.2.3.4" },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(JSON.parse(body)).toEqual({ ip: "1.2.3.4" });
  });
});
