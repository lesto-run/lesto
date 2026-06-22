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

## Server-only — keep secrets out of the browser

`@lesto/env` is a **server** module. Do not import an `env` schema into an
`app/islands/*` component: islands are bundled to the browser, where there is no
`process.env`, so a required variable would throw at hydration — and a secret has
no business in client code at all. When an island needs a value, pass it down as
a prop from a server page or loader (a public API base URL, a feature flag),
never by importing the server environment into the bundle.

> [!IMPORTANT]
> Today this is a convention, not an enforced boundary — Lesto does not yet split
> a schema into server/client halves or refuse a client import at build time (the
> way t3-env or Astro's `astro:env` do). Treat `env.ts` as server-only by hand.
