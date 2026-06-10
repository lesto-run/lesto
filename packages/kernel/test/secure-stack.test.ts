import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetConnection } from "@keel/orm";
import { Router } from "@keel/router";
import { Controller, currentContext, runWithContext } from "@keel/web";
import { generateToken } from "@keel/csrf";

import { createApp, secureStack } from "../src/index";

import type { KernelDatabase } from "../src/index";

function adapt(raw: Database.Database): KernelDatabase {
  return {
    exec: (sql) => raw.exec(sql),

    prepare: (sql) => {
      const statement = raw.prepare(sql);

      return {
        run: (params = []) => statement.run(...(params as never[])),
        get: (params = []) => statement.get(...(params as never[])),
        all: (params = []) => statement.all(...(params as never[])),
      };
    },
  };
}

const SECRET = "kernel-secret";
const SESSION = "anon";

// A controller exercising both a state-changing action and reading the context.
class ApiController extends Controller {
  create(): ReturnType<Controller["json"]> {
    return this.json({ created: true }, 201);
  }

  whoami(): ReturnType<Controller["json"]> {
    return this.json({ requestId: currentContext()?.requestId ?? null });
  }
}

function buildRouter(): Router {
  const router = new Router();

  router.post("/api/items", "api#create");
  router.get("/api/whoami", "api#whoami");

  return router;
}

let raw: Database.Database;
let db: KernelDatabase;

beforeEach(() => {
  raw = new Database(":memory:");
  db = adapt(raw);
});

afterEach(() => {
  resetConnection();
  raw.close();
});

describe("secureStack — cors + rateLimit (safe to enable)", () => {
  it("attaches CORS headers to a normal response", async () => {
    const app = createApp({
      db,
      router: buildRouter(),
      controllers: { api: ApiController },
      middleware: secureStack({ cors: { origin: "*" } }),
    });

    const response = await app.handle("GET", "/api/whoami");

    expect(response.headers["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("answers a CORS preflight (OPTIONS) with 204", async () => {
    const app = createApp({
      db,
      router: buildRouter(),
      controllers: { api: ApiController },
      middleware: secureStack({ cors: { origin: "*" } }),
    });

    const response = await app.handle("OPTIONS", "/api/items");

    expect(response.status).toBe(204);
    expect(response.headers["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("trips a 429 once a burst exhausts the rate limit", async () => {
    const app = createApp({
      db,
      router: buildRouter(),
      controllers: { api: ApiController },
      // capacity 2, negligible refill: the third request in a burst is throttled.
      middleware: secureStack({ rateLimit: { capacity: 2, refillPerSecond: 0.0001 } }),
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

  it("a controller reads the requestId off the context the runtime set", async () => {
    const app = createApp({
      db,
      router: buildRouter(),
      controllers: { api: ApiController },
      middleware: secureStack({ cors: { origin: "*" } }),
    });

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
    const app = createApp({
      db,
      router: buildRouter(),
      controllers: { api: ApiController },
      middleware: secureStack({
        cors: { origin: "*" },
        rateLimit: { capacity: 100, refillPerSecond: 1 },
      }),
    });

    const response = await app.handle("POST", "/api/items", { body: "name=widget" });

    expect(response.status).toBe(201);
  });

  it("the same token-less POST is 403 once CSRF IS mounted", async () => {
    const app = createApp({
      db,
      router: buildRouter(),
      controllers: { api: ApiController },
      middleware: secureStack({
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

    const app = createApp({
      db,
      router: buildRouter(),
      controllers: { api: ApiController },
      middleware: secureStack({ csrf: { secret: SECRET, sessionFor: () => SESSION } }),
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
});
