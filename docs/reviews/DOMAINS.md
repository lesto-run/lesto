# Keel — Domain Map (for the v1 launch review)

The codebase split into eight review domains. Each domain gets one Fable
chief-architect review (`docs/reviews/<slug>.md`) across five lenses —
**performance, security, simplicity, durability, observability** — and one
synthesized plan (`docs/plans/<slug>.md`). The CTO roadmap
(`docs/ROADMAP-V1.md`) rules over all of them.

| # | Domain | Slug | Packages |
|---|--------|------|----------|
| 1 | Core Runtime & HTTP | `core-runtime` | kernel, runtime, web, router, config, errors, hooks |
| 2 | Data & Persistence | `data-persistence` | db, pg, orm, migrate, cache, storage, queue, pubsub, workflows, admin |
| 3 | Auth & Security | `auth-security` | auth, authz, identity, rbac, csrf, cors, ratelimit, flags |
| 4 | UI & Client Pipeline | `ui-client` | ui, ui-kit, ui-generate, assets, forms |
| 5 | Content / Docks CMS | `content-cms` | content-core, content-store, content-query, content-search, content-embeddings, content-markdown, content-mdx, content-components, content-prose, content-umbra, content-lint, content-seo, content-mcp, content-vite, content-shared |
| 6 | Edge, Deploy & Sites | `edge-deploy` | cloudflare, deploy, sites |
| 7 | Comms, SEO & Web Primitives | `web-primitives` | mail, mailing-lists, feeds, seo, i18n |
| 8 | Operability, API Surface & DX | `operability-dx` | observability, mcp, openapi, webhooks, cli, create-keel, integration, e2e |

## Cross-cutting anchors (read before reviewing any domain)

- `docs/ARCHITECTURE.md` — the (aspirational) canonical doc; verify "built" claims against code.
- `docs/adr/` — ADR 0001–0013. The latest (0006 async data layer, 0009–0013 islands & durable stores) are the live design line.
- `docs/ATTACK-PLAN-2026.md` — the strategy/positioning bet.
- `docs/plans/durable-stores.md` — the most recent implemented increment (ADR 0013).

## Review discipline

This repo has a documented history of aspirational docs outrunning reality.
Every reviewer **reads the actual code and tests**, scores each finding
`P0` (launch-blocking) / `P1` (pre-1.0) / `P2` (post-launch), and cites
`file:line` evidence. A claim of "done" in a doc is not evidence of done.
