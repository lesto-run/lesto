---
title: From Express
description: Port an Express API to Lesto — the request/response model, routing, validation, and what batteries replace the glue you assembled by hand.
section: Migrate
order: 0
---

# From Express

You have an Express API. It works, but every real feature pulled in another
dependency — a validator, an ORM, a job runner, a Redis, an auth library — and
gluing them together is most of the codebase. Lesto keeps the part you like (a
small, explicit router) and ships the rest in the box, typed, on one SQL substrate.

This guide ports a small Express app and maps every concept across.

## The shape of the port

A minimal Express app:

```ts
import express from "express";

const app = express();
app.use(express.json());

app.get("/posts", async (req, res) => {
  const posts = await db.query("SELECT * FROM posts ORDER BY id");
  res.json({ posts });
});

app.post("/posts", async (req, res) => {
  const { title, body } = req.body; // untyped, unvalidated
  if (!title || !body) return res.status(422).json({ error: "missing fields" });
  const post = await db.query(
    "INSERT INTO posts (title, body) VALUES ($1, $2) RETURNING *",
    [title, body],
  );
  res.status(201).json({ post });
});

app.listen(3000);
```

The same app in Lesto:

```ts
import { createDb, createTableSql, defineTable, integer, text } from "@lesto/db";
import type { Db } from "@lesto/db";
import type { LestoAppConfig } from "@lesto/kernel";
import type { MigrationEntry } from "@lesto/migrate";
import { openSqlite } from "@lesto/runtime";
import { lesto } from "@lesto/web";
import { z } from "zod";

// Schema as a value: it backs both the migration's DDL and the row type.
const posts = defineTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  body: text("body").notNull(),
});

const createPosts: MigrationEntry = {
  version: "001_create_posts",
  migration: { up: (s) => s.execute(createTableSql(posts)), down: () => {} },
};

const NewPost = z.object({ title: z.string().min(1), body: z.string().min(1) });

function buildApp(db: Db) {
  return lesto()
    .get("/posts", async (c) => {
      const rows = await db.select().from(posts).orderBy(posts.id, "asc").all();
      return c.json({ posts: rows });
    })
    .post("/posts", async (c) => {
      const input = c.valid(NewPost); // typed + validated, or a 422
      const post = await db.insert(posts).values(input).returning().get();
      return c.json({ post }, 201);
    });
}

const { db: handle } = await openSqlite("app.db");
const config: LestoAppConfig = {
  db: handle,
  app: buildApp(createDb(handle)),
  migrations: [createPosts],
  secure: { originCheck: {} }, // CSRF origin check, over the always-on rate-limit baseline
};

export default config;
```

Run it with `lesto dev` (hot reload) or `lesto serve`, or stand the hardened
`node:http` server in front of it yourself — boot the config through
`createApp` (which runs the migrations) and serve the booted app:

```ts
import { createApp } from "@lesto/kernel";
import { serve } from "@lesto/runtime";

const app = await createApp(config);
const server = await serve(app, { port: 3000 });
```

## Concept map

| Express | Lesto |
|---|---|
| `app.get(path, (req, res) => …)` | `.get(path, (c) => …)` — one context `c`, not two objects |
| `req.params.id` | `c.param("id")` |
| `req.query.sort` | `c.query("sort")` |
| `req.body` (+ a validator) | `c.valid(Schema)` — validated at the boundary, typed past it |
| `res.json(x)` | `return c.json(x)` |
| `res.status(201).json(x)` | `return c.json(x, 201)` |
| `res.send(text)` | `return c.text(text)` |
| middleware `(req, res, next)` | `(c, next)` — same idea, chained with `.use(...)` |
| `express.json()` | built in — `c.valid` parses and validates the body |
| your error handler | every failure is a `LestoError` with a stable `code` you branch on |
| `app.listen(port)` | `serve(app, { port })`, or `lesto dev` / `lesto serve` |

## What you get to delete

The dependencies Express made you assemble are now first-party batteries on the
same SQL substrate:

- **Validation glue** (`joi`/`zod` wiring, `express-validator`) → `c.valid(Schema)`.
- **Your ORM + migration tool** (Knex, Prisma, raw SQL) → `@lesto/db` + `@lesto/migrate`.
- **A job queue + Redis** (BullMQ) → `@lesto/queue`, durable on the DB. See
  [Adopt one battery](/migrate/adopt-a-battery).
- **Auth boilerplate** (Passport, sessions, bcrypt) → `@lesto/identity`
  (register/login/verify/reset) on `@lesto/auth` (hashing, sessions) +
  `@lesto/authz` (roles and permissions).
- **A transactional-email service wiring** → `@lesto/mail` (queued, react-email).
- **An admin panel** you hand-rolled → `@lesto/admin`.

## You don't have to port everything at once

If you're not ready to leave Express, you can pull a single Lesto battery into
your existing app — they depend on interfaces (a database handle, a transport),
not on the framework. The [Adopt one battery](/migrate/adopt-a-battery) guide
adds the durable queue to a plain Node app without touching your router.

## Next step

When you're ready for the full framework, the [Quickstart](/quickstart) scaffolds
the structure above — tables, migrations, routes, security, and a React frontend —
in one command. [Concepts](/concepts) explains how the pieces fit.
