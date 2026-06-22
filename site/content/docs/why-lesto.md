---
title: Why Lesto
description: Why Lesto exists, what makes it different from Next.js, Rails, Laravel, and Supabase, and — honestly — when not to use it.
section: Getting started
order: 1
---

# Why Lesto

**Lesto is the batteries-included, agent-native, full-stack TypeScript framework.** If you've ever shipped a real app on Next.js and watched a one-page idea sprawl into a stack of seven SaaS subscriptions — a hosted Postgres, a Redis for the queue, a separate job runner, a transactional-email vendor, an auth provider, a search service, an analytics pixel — Lesto is the answer to "why isn't this just *in the box*?"

It is, here.

## The problem Lesto solves

The JavaScript ecosystem has a world-class frontend story and no backend story. Next.js, Remix, and Astro give you React, server rendering, file routing, and great DX — then hand you a blank page for the *hard parts*: the ORM, migrations, jobs, durable workflows, caching, pub/sub, email, mailing lists, auth, roles, webhooks, crons, content management, an admin UI, observability.

Rails, Laravel, and WordPress solved this fifteen years ago — by *owning* those hard parts as first-party, in-house APIs. Lesto brings that bet to TypeScript, with one structural twist they predate: **one substrate.** Every battery — the queue, the cache, pub/sub, workflows, auth, search — is an in-house Lesto API built on **the SQL database itself** (SQLite for zero-config local, Postgres at scale). No Redis. No broker. No service zoo to provision, wire, and pay for. Thin drivers live only at the irreducible edges — email transport, object storage, OAuth.

The result: `npm create lesto` runs on nothing, and the same app code that boots on your laptop's SQLite scales to Postgres and deploys to the Cloudflare edge — unchanged above the driver seam.

## The twist: Lesto is designed to be driven by an agent

This is the part no incumbent has, because they all predate it.

Every Lesto capability is an *operation* in a single core layer. The CLI, the UI, and the **Lesto MCP server** are three equal front-ends over that same layer. That means you can change your app's **content, UI, schema, and data — and ship it — from an MCP client inside Claude or ChatGPT**, not just from your editor.

Add a database table, write a migration, publish a blog post, render a new page — by asking your agent, with the framework's own operations doing the work safely. The CLI and the visual UI are alternative surfaces over the same operations; neither is required. "Agent-first, editor optional" is a real architectural stance here, not a marketing line.

## How Lesto compares

A framework is a set of trade-offs. Here is an honest one.

| | **Lesto** | **Next.js** | **Rails / Laravel** | **Supabase** |
|---|---|---|---|---|
| Language | TypeScript (strict, ESM) | TypeScript | Ruby / PHP | Any (BaaS) |
| Frontend | React SSR + islands | React SSR — best in class | Server views (+ Hotwire/Livewire) | Bring your own |
| Backend batteries | **In-house, first-party** | Assemble from third parties | **In-house, first-party** | Postgres-as-platform |
| Jobs / queue | On the SQL DB, no Redis | Third-party | Solid Queue / Horizon | pg-based (pgmq) |
| Auth / RBAC | In-house | Third-party (NextAuth, …) | In-house / packages | Built-in (GoTrue) |
| Content / CMS | In-house engine | Third-party (headless CMS) | Gems / packages | Bring your own |
| One DB substrate | **Yes — SQLite → Postgres** | No | Mostly | **Yes — Postgres** |
| Edge-deployable | **Yes — Cloudflare Workers** | Yes (Vercel) | No | N/A |
| Agent / MCP control | **Yes — first-class** | No | No | No |

Reading the table:

- **vs. Next.js** — you keep React and SSR; you stop assembling the backend from a zoo of vendors. The batteries are first-party and consistent, and they run on one database you can reason about.
- **vs. Rails / Laravel** — the same batteries-included philosophy and the same Solid-trifecta-on-the-database bet, but in modern strict TypeScript with React on the frontend, and *edge-deployable* (D1 or Hyperdrive behind one `SqlDatabase` seam) in a way Rails and Laravel are not.
- **vs. Supabase** — Supabase made Postgres the platform from the database up; Lesto makes it the platform from the *framework* down, so your app code, batteries, and the agent surface are one coherent thing rather than a backend you integrate against.
- **vs. WordPress** — Lesto borrows the content + admin + extensibility model that made WordPress a *platform you build onto*. (See the honesty note below on which parts of that are shipped today.)

## When *not* to use Lesto

Credibility matters more to us than conversion, so:

- **You want a static marketing site or blog with zero backend.** Astro or plain HTML is a better fit; Lesto's batteries are dead weight you won't use.
- **You're deep in an existing Rails/Django/Spring shop.** The pull of an established ecosystem and your team's fluency usually beats a greenfield framework.
- **You need a specific managed backend's exact feature** (e.g. Supabase Realtime's RLS-aware channels) and won't trade it for consolidation.
- **You need a large hiring pool of framework-experienced engineers today.** Lesto is new; Next.js and Rails are not.

Lesto shines when you're building a *real, full-stack application* — one with data, jobs, email, auth, and an admin surface — and you'd rather own a coherent in-house stack than integrate a half-dozen services. And it shines uniquely if you want to operate that app from an agent.

## Where Lesto is today (the honest status)

Lesto holds a strict engineering bar — strict TypeScript, ESM, 100% test coverage on its supported surface, stable error codes — but it is young, and we'd rather you know exactly what's load-bearing versus preview:

- **Shipped and supported:** the data layer + migrations, the DB-backed queue, cache, pub/sub, mail + mailing lists, webhooks, auth + RBAC, the router/controllers/kernel, React SSR + islands, the admin surface, observability (including browser→server trace stitching), the content store/engine/CLI/MCP seam, and Cloudflare + Node deployment.
- **Preview (experimental, may change):** parts of the content engine — search (brute-force, practical to ~10k docs), embeddings, prose/lint/seo tooling, and content components beyond `HtmlContent` — plus the AI primitives.
- **Designed but deferred (post-1.0):** the WordPress-style plugin/theme **extensibility** model, crash-safe durable **workflows** (the step-memoization half ships today; the automatic resume-after-crash half does not), and a managed "Lesto Cloud."

We tag preview surfaces in the docs and the package READMEs. If a page doesn't say preview, it's held to the full bar.

## Next step

Convinced enough to try it? The [Quickstart](/quickstart) scaffolds a real app — typed schema, a migration, an SSR page with a hydrated island, a JSON API, security on by default — and gets it running locally in about five minutes. Then [Concepts](/concepts) explains how the pieces fit.
