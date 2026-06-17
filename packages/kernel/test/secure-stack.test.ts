import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { currentContext, fromRequestMiddleware, keel, runWithContext } from "@keel/web";
import type { Keel } from "@keel/web";
import { generateToken } from "@keel/csrf";

import { createApp, secureStack } from "../src/index";
import type { SecureStackOptions } from "../src/index";

import type { KernelDatabase } from "../src/index";

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

// >= 32 bytes: a real CSRF secret (the weak-secret guard rejects shorter).
const SECRET = "kernel-secret-0123456789abcdefghi";
const SESSION = "anon";

// A keel() app exercising both a state-changing route and reading the context,
// with the secure stack mounted as the app's outermost middleware. The security
// batteries are request-and-next middleware, bridged into the handler chain by
// `fromRequestMiddleware` — the production wiring (see create-keel's template).
function buildApp(options: SecureStackOptions): Keel {
  return keel()
    .use(...secureStack(options).map(fromRequestMiddleware))
    .post("/api/items", (c) => c.json({ created: true }, 201))
    .get("/api/whoami", (c) => c.json({ requestId: currentContext()?.requestId ?? null }));
}

let raw: Database.Database;
let db: KernelDatabase;

beforeEach(() => {
  raw = new Database(":memory:");
  db = adapt(raw);
});

afterEach(() => {
  raw.close();
});

describe("secureStack — cors + rateLimit (safe to enable)", () => {
  it("attaches CORS headers to a normal response", async () => {
    const app = await createApp({ db, app: buildApp({ cors: { origin: "*" } }) });

    const response = await app.handle("GET", "/api/whoami");

    expect(response.headers["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("answers a CORS preflight (OPTIONS) with 204", async () => {
    const app = await createApp({ db, app: buildApp({ cors: { origin: "*" } }) });

    // A real CORS preflight carries Access-Control-Request-Method; without it the
    // bare OPTIONS falls through to the app (auth-security#8 tightened this).
    const response = await app.handle("OPTIONS", "/api/items", {
      headers: { origin: "https://example.com", "access-control-request-method": "GET" },
    });

    expect(response.status).toBe(204);
    expect(response.headers["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("trips a 429 once a burst exhausts the rate limit", async () => {
    // capacity 2, negligible refill: the third request in a burst is throttled.
    const app = await createApp({
      db,
      app: buildApp({ rateLimit: { capacity: 2, refillPerSecond: 0.0001 } }),
    });

    // Drive each request inside a context with the same client IP, as the
    // runtime does — so all three share one bucket.
    const burst = async (): Promise<number> =>
      (
        await runWithContext({ requestId: "r", ip: "9.9.9.9" }, () =>
          app.handle("GET", "/api/whoami"),
        )
      ).status;

    expect(await burst()).toBe(200);
    expect(await burst()).toBe(200);
    expect(await burst()).toBe(429);
  });

  it("a handler reads the requestId off the context the runtime set", async () => {
    const app = await createApp({ db, app: buildApp({ cors: { origin: "*" } }) });

    const response = await runWithContext({ requestId: "trace-xyz" }, () =>
      app.handle("GET", "/api/whoami"),
    );

    expect(JSON.parse(response.body)).toEqual({ requestId: "trace-xyz" });
  });
});

describe("secureStack — csrf is opt-in only", () => {
  it("a token-less state-changing POST succeeds when CSRF is NOT mounted", async () => {
    // The backward-compatibility guarantee: no csrf option => no enforcement,
    // exactly the estate sign-in flow (a POST with no CSRF token).
    const app = await createApp({
      db,
      app: buildApp({
        cors: { origin: "*" },
        rateLimit: { capacity: 100, refillPerSecond: 1 },
      }),
    });

    const response = await app.handle("POST", "/api/items", { body: "name=widget" });

    expect(response.status).toBe(201);
  });

  it("the same token-less POST is 403 once CSRF IS mounted", async () => {
    const app = await createApp({
      db,
      app: buildApp({
        cors: { origin: "*" },
        csrf: { secret: SECRET, sessionFor: () => SESSION },
      }),
    });

    const response = await app.handle("POST", "/api/items", { body: "name=widget" });

    expect(response.status).toBe(403);
    // CORS headers still wrap the 403 — the onion order puts cors outermost.
    expect(response.headers["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("a valid token lets the POST through when CSRF is mounted", async () => {
    const token = generateToken(SESSION, SECRET);

    const app = await createApp({
      db,
      app: buildApp({ csrf: { secret: SECRET, sessionFor: () => SESSION } }),
    });

    const response = await app.handle("POST", "/api/items", { body: `_csrf=${token}` });

    expect(response.status).toBe(201);
  });
});

describe("secureStack composition", () => {
  it("is empty when nothing is configured (the no-op floor)", () => {
    expect(secureStack({})).toEqual([]);
  });

  it("includes one middleware per configured concern, cors→rateLimit→csrf", () => {
    const stack = secureStack({
      cors: { origin: "*" },
      rateLimit: { capacity: 1, refillPerSecond: 1 },
      csrf: { secret: SECRET, sessionFor: () => SESSION },
    });

    expect(stack).toHaveLength(3);
  });

  it("adds the origin check as its own layer when configured", () => {
    const stack = secureStack({
      cors: { origin: "*" },
      rateLimit: { capacity: 1, refillPerSecond: 1 },
      originCheck: {},
      csrf: { secret: SECRET, sessionFor: () => SESSION },
    });

    // cors + rateLimit + originCheck + csrf — all four present.
    expect(stack).toHaveLength(4);
  });
});

describe("secureStack — origin check (zero-config CSRF default)", () => {
  it("refuses a cross-site state-changing request with no token plumbing", async () => {
    const app = await createApp({ db, app: buildApp({ originCheck: {} }) });

    const response = await app.handle("POST", "/api/items", {
      headers: { "sec-fetch-site": "cross-site" },
      body: "name=widget",
    });

    expect(response.status).toBe(403);
  });

  it("allows a same-origin state-changing request without a token", async () => {
    const app = await createApp({ db, app: buildApp({ originCheck: {} }) });

    const response = await app.handle("POST", "/api/items", {
      headers: { "sec-fetch-site": "same-origin" },
      body: "name=widget",
    });

    expect(response.status).toBe(201);
  });
});
