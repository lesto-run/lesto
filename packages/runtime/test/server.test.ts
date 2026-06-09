import { request as httpRequest } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { serve } from "../src/index";
import { requestLineOf } from "../src/server";

import type { Server } from "../src/index";
import type { App } from "@keel/kernel";

// Track the live server so each test tears its socket down, even on failure.
let server: Server | undefined;

afterEach(async () => {
  if (server !== undefined) {
    await server.close();
    server = undefined;
  }
});

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Make a real socket request to the running server and read the full response. */
function makeRequest(
  port: number,
  options: { method: string; path: string; body?: string; contentType?: string },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};

    if (options.contentType !== undefined) {
      headers["content-type"] = options.contentType;
    }

    const req = httpRequest(
      { host: "127.0.0.1", port, method: options.method, path: options.path, headers },
      (res) => {
        const chunks: Buffer[] = [];

        res.on("data", (chunk: Buffer) => chunks.push(chunk));

        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );

    req.on("error", reject);

    if (options.body !== undefined) {
      req.write(options.body);
    }

    req.end();
  });
}

describe("serve", () => {
  it("answers a real GET request through the socket, echoing path and query", async () => {
    // A stub App typed as the real interface — enough to exercise the full
    // socket -> toKeelRequest -> handle -> applyResponse path live.
    const app: App = {
      migrationsApplied: [],

      handle: async (method, path, options) => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method, path, query: options?.query, body: options?.body }),
      }),
    };

    server = await serve(app, { port: 0 });

    expect(server.port).toBeGreaterThan(0);

    const response = await makeRequest(server.port, {
      method: "GET",
      path: "/posts?tag=math",
    });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(response.body)).toEqual({
      method: "GET",
      path: "/posts",
      query: { tag: "math" },
    });
  });

  it("reads a JSON POST body off the socket and hands it to the app", async () => {
    const app: App = {
      migrationsApplied: [],

      handle: async (_method, _path, options) => ({
        status: 201,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ received: options?.body }),
      }),
    };

    server = await serve(app, { port: 0 });

    const response = await makeRequest(server.port, {
      method: "POST",
      path: "/posts",
      contentType: "application/json",
      body: '{"title":"Hello"}',
    });

    expect(response.status).toBe(201);
    expect(JSON.parse(response.body)).toEqual({ received: { title: "Hello" } });
  });

  it("defaults to an ephemeral port and the loopback host when no options are given", async () => {
    const app: App = {
      migrationsApplied: [],

      handle: async () => ({ status: 200, headers: {}, body: "ok" }),
    };

    server = await serve(app);

    expect(server.port).toBeGreaterThan(0);

    const response = await makeRequest(server.port, { method: "GET", path: "/" });

    expect(response.body).toBe("ok");
  });

  it("binds the host when one is given", async () => {
    const app: App = {
      migrationsApplied: [],

      handle: async () => ({ status: 204, headers: {}, body: "" }),
    };

    server = await serve(app, { port: 0, host: "127.0.0.1" });

    const response = await makeRequest(server.port, { method: "GET", path: "/" });

    expect(response.status).toBe(204);
  });
});

describe("requestLineOf", () => {
  it("passes through the method and url of a real server request", () => {
    expect(requestLineOf({ method: "POST", url: "/x" })).toEqual({ method: "POST", url: "/x" });
  });

  it("defaults a missing method and url defensively", () => {
    expect(requestLineOf({ method: undefined, url: undefined })).toEqual({
      method: "GET",
      url: "/",
    });
  });
});
