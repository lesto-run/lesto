import { describe, expect, it } from "vitest";

import type { DeployPlan } from "@keel/deploy";

import {
  CloudflareError,
  toFetchHandler,
  withAssets,
  wranglerConfig,
  type AssetFetcher,
  type EdgeDispatch,
  type EdgeRequestOptions,
} from "../src/index";

// A dispatcher that records what it was called with and echoes a fixed response.
function recordingDispatch(response: {
  status: number;
  body: string;
  headers?: Record<string, string>;
}): {
  dispatch: EdgeDispatch;
  calls: Array<{ method: string; path: string; options: EdgeRequestOptions }>;
} {
  const calls: Array<{ method: string; path: string; options: EdgeRequestOptions }> = [];

  const dispatch: EdgeDispatch = (method, path, options) => {
    calls.push({ method, path, options });

    return Promise.resolve({
      status: response.status,
      headers: response.headers ?? {},
      body: response.body,
    });
  };

  return { dispatch, calls };
}

describe("toFetchHandler", () => {
  it("adapts method, path, query, and headers into the dispatcher", async () => {
    const { dispatch, calls } = recordingDispatch({ status: 200, body: "ok" });
    const handler = toFetchHandler(dispatch);

    const response = await handler(
      new Request("https://example.com/mls/listings?sort=price&beds=4", {
        headers: { "x-test": "1" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");

    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.path).toBe("/mls/listings");
    expect(calls[0]?.options.query).toEqual({ sort: "price", beds: "4" });
    expect(calls[0]?.options.headers["x-test"]).toBe("1");
    expect(calls[0]?.options.body).toBeUndefined();
  });

  it("passes response headers through — a Set-Cookie survives to the browser", async () => {
    const { dispatch } = recordingDispatch({
      status: 302,
      body: "",
      headers: { "set-cookie": "__Host-keel_session=abc; Secure", location: "/mls" },
    });

    const response = await toFetchHandler(dispatch)(
      new Request("https://example.com/mls/api/sign-in", { method: "POST" }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toBe("__Host-keel_session=abc; Secure");
    expect(response.headers.get("location")).toBe("/mls");
  });

  it("parses a JSON body when the content-type says so", async () => {
    const { dispatch, calls } = recordingDispatch({ status: 200, body: "ok" });

    await toFetchHandler(dispatch)(
      new Request("https://example.com/mls/api/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ listing: "bel-air-glen" }),
      }),
    );

    expect(calls[0]?.options.body).toEqual({ listing: "bel-air-glen" });
  });

  it("answers a malformed JSON body with 400, before dispatch", async () => {
    const { dispatch, calls } = recordingDispatch({ status: 200, body: "ok" });

    const response = await toFetchHandler(dispatch)(
      new Request("https://example.com/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );

    expect(response.status).toBe(400);
    expect(calls).toEqual([]); // never reached the app
  });

  it("keeps a non-JSON body as raw text", async () => {
    const { dispatch, calls } = recordingDispatch({ status: 200, body: "ok" });

    await toFetchHandler(dispatch)(
      new Request("https://example.com/x", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "hello",
      }),
    );

    expect(calls[0]?.options.body).toBe("hello");
  });
});

// An assets binding that answers a fixed status for a known path, else 404.
function assetsServing(path: string, body: string): AssetFetcher {
  return {
    fetch: (request) =>
      Promise.resolve(
        new URL(request.url).pathname === path
          ? new Response(body, { status: 200 })
          : new Response("not found", { status: 404 }),
      ),
  };
}

// An app handler that returns a fixed body — the fall-through target.
const fixedApp =
  (body: string) =>
  (_request: Request): Promise<Response> =>
    Promise.resolve(new Response(body, { status: 200 }));

describe("withAssets", () => {
  it("serves an asset hit without touching the app", async () => {
    let appCalled = false;
    const app = (_request: Request): Promise<Response> => {
      appCalled = true;

      return Promise.resolve(new Response("app", { status: 200 }));
    };

    const handler = withAssets(assetsServing("/client.js", "/* bundle */"), app);

    const response = await handler(new Request("https://example.com/client.js"));

    expect(await response.text()).toBe("/* bundle */");
    expect(appCalled).toBe(false);
  });

  it("falls through to the app on an asset 404", async () => {
    const handler = withAssets(assetsServing("/client.js", "x"), fixedApp("app"));

    const response = await handler(new Request("https://example.com/mls"));

    expect(await response.text()).toBe("app");
  });
});

describe("wranglerConfig", () => {
  const planWithDynamic: DeployPlan = {
    targets: [
      {
        kind: "static",
        site: "marketing",
        basePath: "/",
        routing: { basePath: "/", mode: "static" },
        files: [],
      },
      {
        kind: "node",
        site: "mls",
        basePath: "/mls",
        routing: { basePath: "/mls", mode: "dynamic" },
        run: "keel serve",
        needsDatabase: true,
      },
    ],
    routing: [
      { basePath: "/mls", mode: "dynamic" },
      { basePath: "/", mode: "static" },
    ],
  };

  it("emits a worker config with nodejs_compat and an assets binding", () => {
    const config = wranglerConfig(planWithDynamic, {
      name: "estate",
      main: "worker.ts",
      compatibilityDate: "2026-06-01",
      assetsDir: "out",
    });

    expect(config).toEqual({
      name: "estate",
      main: "worker.ts",
      compatibility_date: "2026-06-01",
      compatibility_flags: ["nodejs_compat"],
      assets: { directory: "out", binding: "ASSETS" },
    });
  });

  it("honors a custom assets binding name", () => {
    const config = wranglerConfig(planWithDynamic, {
      name: "estate",
      main: "worker.ts",
      compatibilityDate: "2026-06-01",
      assetsDir: "out",
      assetsBinding: "STATIC",
    });

    expect(config.assets.binding).toBe("STATIC");
  });

  it("refuses a plan with no dynamic zone (nothing for a Worker to run)", () => {
    const staticOnly: DeployPlan = {
      targets: [
        {
          kind: "static",
          site: "marketing",
          basePath: "/",
          routing: { basePath: "/", mode: "static" },
          files: [],
        },
      ],
      routing: [{ basePath: "/", mode: "static" }],
    };

    try {
      wranglerConfig(staticOnly, {
        name: "estate",
        main: "worker.ts",
        compatibilityDate: "2026-06-01",
        assetsDir: "out",
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CloudflareError);
      expect((error as CloudflareError).code).toBe("CLOUDFLARE_NO_DYNAMIC_ZONE");
    }
  });
});
