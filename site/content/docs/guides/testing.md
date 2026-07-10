---
title: Testing
description: Test a Lesto app by booting the real thing on an in-memory database and dispatching requests in-process — no HTTP server, no mocking framework.
section: Guides
order: 2
---

# Testing

Lesto apps are fast and honest to test because of two things the framework already gives you: an app is a **pure request handler** (`app.handle(method, path)` returns a response — no socket required), and the database driver runs **in memory** with zero config. So a test boots the *real* app against a throwaway database and calls it directly. No running server, no HTTP client, no mocking layer.

The test runner is [vitest](https://vitest.dev) — the same runner every `@lesto/*` package uses.

## The setup: a fresh app per test

Because your app is built through a `buildApp(db)` factory (the shape `create-lesto` scaffolds), a test can hand it a brand-new in-memory database. `openSqlite()` with no filename is in-memory, and `createApp` runs your migrations against it on boot — so every test starts from a clean, fully-migrated schema, and there's nothing to tear down:

```ts
import { createApp, type App } from "@lesto/kernel";
import { createDb } from "@lesto/db";
import { openSqlite } from "@lesto/runtime";
import { beforeEach, expect, it } from "vitest";

import { buildApp, migrations } from "../src/app"; // your factory + migration list

let app: App;

beforeEach(async () => {
  const { db: handle } = await openSqlite(); // fresh in-memory DB, per test
  app = await createApp({
    db: handle,
    app: buildApp(createDb(handle)),
    migrations,
    secure: { originCheck: {} }, // the scaffold's default — test what you ship
  });
});
```

A new in-memory database per `beforeEach` *is* your isolation: tests can't leak state into one another, and there's no transaction to roll back or table to truncate.

## Driving the app

`app.handle(method, path, options?)` is the exact code path a real request (and the static prerender) takes. It returns `{ status, headers, body }`, where `body` is the response string — `JSON.parse` it for a JSON route:

```ts
it("creates a post, then lists it", async () => {
  const created = await app.handle("POST", "/posts", {
    // State-changing requests are origin-checked (CSRF) by default, so send the
    // header a browser would — the same one you'd pass to curl by hand.
    headers: { "sec-fetch-site": "same-origin" },
    body: { title: "Hello, Lesto", body: "First post." },
  });
  expect(created.status).toBe(201);

  const listed = await app.handle("GET", "/posts");
  expect(listed.status).toBe(200);
  expect(JSON.parse(listed.body).posts).toHaveLength(1);
});
```

## Test the boundary, not just the happy path

The most valuable tests prove your validation holds. A handler that runs untrusted input through `c.valid(Schema)` returns a **422** on a bad body — never a crash, never a write. Assert that:

```ts
it("rejects an invalid body at the boundary", async () => {
  const response = await app.handle("POST", "/posts", {
    headers: { "sec-fetch-site": "same-origin" },
    body: { title: "", body: "" }, // fails the Zod schema
  });
  expect(response.status).toBe(422);
});
```

You don't need a separate test for "what if the title is missing" at every layer — validation lives in exactly one place (the boundary), so one test of the schema's contract covers it.

## Seeding data

Need rows before you dispatch? Insert them through the same typed `@lesto/db` handle your handlers use — it's just code, inside the test:

```ts
const db = createDb(handle);
await db.insert(posts).values({ title: "Seeded", body: "…", createdAt: now, updatedAt: now }).run();
```

## Routes that read request context

A handler that reads the request id or client IP needs that context present. Wrap the dispatch in `runWithContext` (from `@lesto/web`) to supply it:

```ts
import { runWithContext } from "@lesto/web";

const response = await runWithContext({ requestId: "test-1", ip: "127.0.0.1" }, () =>
  app.handle("GET", "/whoami"),
);
```

## Coverage

Lesto itself holds a non-negotiable **100% coverage** bar — every package's `vitest.config.ts` sets the thresholds, enforced in CI:

```ts title="vitest.config.ts" {3}
test: {
  coverage: {
    thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
  },
}
```

Your app doesn't have to match that, but the same machinery is there — `vitest run --coverage` reports it, and you set the bar your team wants. A line you can't cover is usually a line you didn't need.

## Next step

The pattern scales to every battery: a queue worker, a mailer, an admin route — all bootable on an in-memory database and drivable through `app.handle`. See [Concepts](/concepts) for how the pieces fit, and the batteries guides for each one's surface.
