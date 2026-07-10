---
title: Environment
description: Typed, validated environment variables — declare a schema once, fail fast at boot, and read every value typed. Works the same on Node, Bun, and the Cloudflare edge.
section: Batteries
order: 10
---

# Environment

`@lesto/env` turns the environment from an untyped `process.env` bag into a
schema you declare once. `defineEnv` validates it **at boot** — a missing or
malformed variable fails immediately with a coded error that names *every*
problem at once, instead of surfacing as an `undefined` deep inside a request.
The result is frozen and fully typed, so config never drifts after start-up.

## Define the schema

`defineEnv` takes a map of variable names to fields and returns the validated,
read-only values:

```ts
import { defineEnv, envField } from "@lesto/env";

export const env = defineEnv({
  PORT: envField.port().default(3000),
  NODE_ENV: envField.oneOf(["development", "production", "test"]).default("development"),
  DATABASE_URL: envField.string(),            // required — boot throws if it is unset
  LESTO_DEMO: envField.boolean().default(false),
});

env.PORT;          // number
env.NODE_ENV;      // "development" | "production" | "test"
env.DATABASE_URL;  // string
env.LESTO_DEMO;    // boolean
```

Read each value off `env` — never `process.env` — and you get a typed,
already-validated value at the use site.

## Fields

Every variable arrives as a string or not at all, so each field's job is to
coerce a present value or say why it cannot:

- `envField.string()` — a non-empty string, verbatim.
- `envField.number()` — a finite number (`"3.14"` → `3.14`).
- `envField.port()` — an integer from 1 to 65535.
- `envField.boolean()` — reads `true/1/yes/on` vs `false/0/no/off`
  (case-insensitive). It does **not** have the `Boolean("false") === true` footgun
  of a naive cast — `"0"` is `false`.
- `envField.oneOf([...])` — one of a fixed set, typed as the literal union.

Each field is **required** by default. Relax it with a chain:

- `.optional()` — the value may be unset; its type becomes `T | undefined`.
- `.default(value)` — a fallback used when the variable is unset (or empty).

```ts
LOG_LEVEL: envField.oneOf(["debug", "info", "warn"]).default("info"),
SENTRY_DSN: envField.string().optional(),     // string | undefined
```

An empty string counts as unset (a placeholder that resolved to `""` is the same
as never having been set), so a blank variable falls back to its default or is
reported as missing rather than slipping through as `""`.

## Failing fast

When validation fails, `defineEnv` throws a coded `EnvError`
(`code: "ENV_VALIDATION_FAILED"`) whose message lists every offending variable —
one boot surfaces the whole problem set:

```
Invalid environment — 2 problems:
  DATABASE_URL is required but not set
  PORT must be a port (an integer from 1 to 65535)
```

Branch on the `code`, never the message string.

## Where values come from

`defineEnv` reads `process.env` by default — it does **not** load `.env` files
itself; it validates what the runtime already populated.

**Local dev.** `lesto dev` and `lesto build` run under Bun, which automatically
loads `.env` and `.env.local` into `process.env`. So put local configuration in
`.env`, and **secrets in `.env.local`** — the scaffold's `.gitignore` ignores
`.env*` (and re-includes `.env.example`), so secrets are never committable.
Commit a secret-free `.env.example` listing the variable *names* a teammate must
set:

```sh
# .env.local  (gitignored)
DATABASE_URL=postgres://localhost/myapp
SESSION_SECRET=…

# .env.example  (committed — names only)
DATABASE_URL=
SESSION_SECRET=
```

## On the Cloudflare edge

A Worker has no `process.env`. Cloudflare passes configuration on the `env`
binding — the second argument to `fetch(request, env, ctx)` — populated from
`wrangler secret put NAME` (secrets) and `vars` in `wrangler.jsonc` (plain
config). Validate it with the **same** schema by passing the binding as the
second argument to `defineEnv`:

```ts
export default {
  fetch(request: Request, workerEnv: Env, ctx: ExecutionContext) {
    const env = defineEnv(
      { SESSION_SECRET: envField.string(), API_BASE: envField.string() },
      workerEnv,                       // ← read from the Worker binding, not process.env
    );
    // …use env.SESSION_SECRET, typed and validated, exactly as on Node.
  },
};
```

`workerEnv` is a generated `interface Env` carrying non-string bindings (an
`ASSETS` fetcher, KV/DO namespaces); `defineEnv` accepts it as-is and reads only
the string keys your schema names, so a binding never pollutes a validated value.

Set the secret once at deploy time, and keep a local copy in `.dev.vars` for
`wrangler dev` (the scaffold's `.gitignore` ignores `.dev.vars`, so it is never
committed):

```sh
wrangler secret put SESSION_SECRET     # production
echo 'SESSION_SECRET=local-dev-value' >> .dev.vars   # local `wrangler dev`
```

The default source is edge-safe (`globalThis.process?.env ?? {}`), so importing
`@lesto/env` never throws a `ReferenceError` where there is no `process`.

## Split server and client halves

`defineEnv` also takes a two-sided schema — `server` for secrets, `client` for
public config — and enforces the boundary structurally, not by convention. The
scaffold ships this layout: a browser-safe `env.client.ts` declaring the
`PUBLIC_*` schema, imported by the full `env.ts`:

```ts
// env.client.ts — the PUBLIC_* schema, shared with islands and the bundler.
import { envField } from "@lesto/env/client";
import type { ClientSchema } from "@lesto/env/client";

export const clientEnv = {
  PUBLIC_APP_NAME: envField.string().default("My app"),
} satisfies ClientSchema;
```

```ts
// env.ts — the full schema. Server keys are leak-guarded.
import { defineEnv, envField } from "@lesto/env";
import { clientEnv } from "./env.client";

export const env = defineEnv({
  server: { SESSION_SECRET: envField.string() },
  client: clientEnv,
});
```

Two guarantees, both loud and early:

- **Client keys must be named `PUBLIC_*`.** A misnamed one throws
  `ENV_CLIENT_NOT_PUBLIC` as the schema is built — the prefix is the leak
  contract the bundler keys off.
- **Server keys never reach the browser.** Reading a server key from a browser
  context throws `ENV_SERVER_LEAK` naming the variable, instead of silently
  bundling `undefined` — or the secret itself.

In an island, read public config through `@lesto/env/client`, a surface that by
construction imports no server schema:

```ts
// app/islands/hello.tsx
import { defineClientEnv } from "@lesto/env/client";
import { clientEnv } from "../../env.client";

const publicEnv = defineClientEnv(clientEnv);
publicEnv.PUBLIC_APP_NAME; // string — inlined into the bundle at build time
```

A browser has no `process.env`, so `lesto dev` and `lesto build` read
`env.client.ts` and inline the validated `PUBLIC_*` values into the island
bundle; a missing or malformed required `PUBLIC_*` variable fails the *build*,
not hydration. On the server the same `defineClientEnv` call falls back to
`process.env`, so it works in both places.

Secrets still have no business in client code: when an island needs a
server-derived value, pass it down as a prop from a server page or loader.

## Where to go next

- [Data](/batteries/data) — point `DATABASE_URL` at the typed data layer.
- [Deploy to Cloudflare](/deploy/cloudflare) — Worker bindings, secrets, and
  `.dev.vars` in full.
- [Quickstart](/quickstart) — the scaffold that ships `env.ts` and
  `env.client.ts` wired up.
