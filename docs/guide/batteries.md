# Batteries

Volo is batteries-included: each capability is an in-house API on the one SQL
substrate (SQLite local → Postgres at scale), with thin drivers only at the
irreducible edges. Every battery below links the runnable example that proves it —
the project's QA bar is that a feature isn't done until an example runs it.

> The example gallery is growing toward one runnable proof per battery (see
> [`docs/plans/examples-gallery.md`](../plans/examples-gallery.md) and
> [`docs/BEYOND-V1.md`](../BEYOND-V1.md)). Batteries marked _estate_ are exercised by
> the integrated flagship app rather than a dedicated example yet.

## Data

| Battery | What it gives you | Proof |
|---|---|---|
| `@volo/db` | Schema-as-value tables, typed queries, SQLite/Postgres dialects | [`examples/blog`](../../examples/blog) |
| `@volo/migrate` | Version-stamped, idempotent migrations over `@volo/db` DDL | [`examples/blog`](../../examples/blog) |
| `@volo/pg` | The Postgres adapter behind the `@volo/db` seam | _CI db-parity job_ |
| `@volo/storage` | Object storage behind one API (memory / FS / S3+R2 SigV4) | _estate_ |

## Async

| Battery | What it gives you | Proof |
|---|---|---|
| `@volo/queue` | Durable job queue — at-least-once, `SKIP LOCKED`, visibility reclaim | [`examples/mailing-lists`](../../examples/mailing-lists) |
| `@volo/cache` | TTL cache over an injected clock (memory / SQL store) | _estate_ |
| `@volo/workflows` | Resumable step memoization on the DB (caller-driven resume) | _unit-tested_ |
| `@volo/pubsub` | In-process publish/subscribe hub | _unit-tested_ |

## Comms

| Battery | What it gives you | Proof |
|---|---|---|
| `@volo/mail` | Mailers — react-email templates, queued delivery, pluggable transport | [`examples/mailing-lists`](../../examples/mailing-lists) |
| `@volo/mailing-lists` | Double opt-in subscriber lists + broadcasts | [`examples/mailing-lists`](../../examples/mailing-lists) |
| `@volo/webhooks` | HMAC-signed outbound delivery (retried) + inbound verification, SSRF-guarded | _unit-tested_ |
| `@volo/feeds` · `@volo/seo` · `@volo/i18n` | RSS/Atom, sitemap/JSON-LD, plural-correct i18n | _unit-tested_ |

## Identity & security

| Battery | What it gives you | Proof |
|---|---|---|
| `@volo/identity` | register / verify-email / login / reset on the DB | _estate_ |
| `@volo/auth` | scrypt hashing (fail-closed), tokens, durable SQL sessions | _estate_ |
| `@volo/authz` | declarative role/permission policy + guard middleware | _estate_ |
| `@volo/csrf` · `@volo/cors` · `@volo/ratelimit` | the secure stack, on by default via the kernel | [`examples/estate`](../../examples/estate) |

## UI / Web / Runtime

| Battery | What it gives you | Proof |
|---|---|---|
| `@volo/web` + `@volo/router` | code-first `volo()` app: routes, pages, middleware | [`examples/blog`](../../examples/blog) |
| `@volo/ui` + `@volo/assets` | islands pipeline, Preact-by-default ~10 KB client bundle | [`examples/estate`](../../examples/estate) |
| `@volo/runtime` | hardened `node:http` server (timeouts, body cap, drain) | [`examples/blog`](../../examples/blog) (`serve.ts`) |
| `@volo/kernel` | assembles db + migrations + app into one bootable unit | [`examples/blog`](../../examples/blog) |

## Platform & agent plane

| Battery | What it gives you | Proof |
|---|---|---|
| `@volo/observability` | OTLP-shaped distributed tracing (env-driven) | _estate (edge OTLP)_ |
| `@volo/mcp` | the agent control plane — `volo mcp`, read-only by default, audit-sinked | _CLI_ |
| `@volo/openapi` | route-skeleton OpenAPI 3.1 export — `volo openapi` | _CLI_ |
| `@volo/cloudflare` | the Workers edge adapter + `wrangler` config | [`examples/estate`](../../examples/estate) |

## Content

The content engine's supported surface is the store/CLI/MCP seam: `@volo/content-core`,
`@volo/content-store`, `volo content:build`, and the `@volo/mcp` content tools. The rest
of the `content-*` packages ship **preview** (experimental). See
[ARCHITECTURE.md](../../ARCHITECTURE.md) §3 for the supported-vs-preview boundary.
