---
version: Unreleased
date: "2026-06-22"
title: The road to 0.1.0
---

Lesto hasn't published to npm yet — this entry tracks what the first release
(`0.1.0`) will contain. Once the packages publish, each release will get its own
entry here, generated from changesets.

Until then, try Lesto with no install via the
[Codespace](https://codespaces.new/lesto-run/lesto), or scaffold from the repo
(see the [Quickstart](/quickstart)).

### Supported in the first release

- **Data** — typed schema + migrations (`@lesto/db`, `@lesto/migrate`), relational
  queries with joins, and Postgres + Cloudflare (D1 / Hyperdrive) behind one
  database seam.
- **Async** — a durable job queue on the database (`@lesto/queue`), TTL cache, and
  in-process pub/sub. No Redis.
- **Comms** — transactional email with react-email templates (`@lesto/mail`),
  Ghost-style mailing lists, and signed webhooks.
- **Identity** — password auth, sessions, and a declarative RBAC policy
  (`@lesto/auth`, `@lesto/authz`).
- **Web** — a code-first router, file-based routing, React SSR with hydrated
  islands, and an admin surface.
- **Platform** — in-house distributed tracing that stitches browser → API → DB
  into one trace, with no OpenTelemetry dependency.
- **Agent control plane** — operate a running app from an MCP client (publish and
  edit content, generate UI, drive requests).
- **Deploy** — Node and Cloudflare Workers, from one app.

### Preview (experimental, may change)

- Parts of the content engine — search, embeddings, prose/lint/SEO tooling, and
  content components beyond `HtmlContent` — plus the AI primitives.
