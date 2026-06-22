# Lesto — Messaging & Voice (v0)

The single source of truth for how we talk about Lesto in public. Owned by DevRel.
Every launch surface — README, docs, landing page, social, talks — pulls from here
so the story stays consistent and, above all, **honest**.

> Status: v0, drafted 2026-06-21 from the codebase audit. Tagline finalists need a
> gut-check before they're locked. The claims guardrail (below) is binding now.

---

## 1. The name

**Lesto** — Italian for *quick, nimble, light on its feet*. Pronounced "LEH-stoh".
Lowercase in prose and code (`lesto()`, `lesto` CLI, `@lesto/*`). The journey here
was Keel → Volo → Lesto; only the final name ships. Don't reference the old names
publicly.

## 2. Tagline finalists

Pick one hero line and stick to it everywhere. Finalists, in recommended order:

1. **"Batteries-included. Agent-native."** — *(recommended)* Two words do the whole
   job: the Rails/Laravel promise plus the one thing no incumbent has. Short enough
   for an OG image, a nav bar, and a tweet. This is what the shipped `og.svg` uses.
2. **"The full-stack TypeScript framework you can drive from Claude."** — One
   sentence, leads with the wedge. Best as the sub-hero line under #1.
3. **"The framework agents can drive."** — Punchiest, but undersells the
   batteries-included half that does most of the day-one work.

**Hero stack we ship today** (landing + OG image):

> # Batteries-included. Agent-native.
> The full-stack TypeScript framework you can drive from Claude, the CLI, or code.

## 3. Elevator pitches (three lengths)

- **One line:** Lesto is the batteries-included, agent-native, full-stack TypeScript
  framework.
- **One paragraph:** Lesto gives TypeScript the in-house "hard parts" Rails and
  Laravel ship in the box — ORM, queues, workflows, cache, auth, email, admin,
  content, observability — built on one substrate, the SQL database (SQLite local,
  Postgres at scale), with React SSR on the frontend and Cloudflare-edge deploys.
  The twist no incumbent has: every capability is an operation you can drive from an
  MCP client inside Claude or ChatGPT, not just your editor.
- **The wedge, alone:** Change your app's content, UI, schema, and data — and ship
  it — by asking your agent. The CLI and the visual UI are alternative surfaces over
  the same operations; neither is required.

## 4. Voice & tone

- **Honest over hype.** We name what's preview and what's deferred. Credibility is
  the asset; one overclaim a skeptical HN reader catches costs more than ten
  features. (See §5.)
- **Concrete over abstract.** Show the `npm create lesto` → running-app path, the
  real query, the real trace. Code samples are complete and runnable, not snippets.
- **Architectural, not breathless.** Explain the *why* (one substrate, no service
  zoo) before the *what*. Assume a competent TypeScript reader; don't condescend.
- **Confident, not contemptuous.** We respect Next.js, Rails, Laravel, Supabase — we
  borrow their best ideas openly. Never punch down at the tools people use today.
- **Plain words.** No "blazing-fast", "revolutionary", "game-changing", "10x".

## 5. The claims guardrail (binding)

External copy must match shipped reality. Use this table; when in doubt, downgrade
the claim. ARCHITECTURE.md is the internal source of truth for status.

| Claim | How we may say it |
|---|---|
| ORM / data layer | "Typed schema, migrations, relational queries with joins." **Not** "a full ActiveRecord-class ORM" — eager-loading/`relations()` is partial. |
| Queue / cache / pub-sub / mail / auth / RBAC / webhooks / admin | Say it plainly — **shipped and supported.** |
| Browser→server tracing | "One trace spans browser → API → DB" — **shipped**, proven in the integration suite. Safe to claim. |
| Workflows | "Resumable step memoization." **Not** "durable, crash-safe workflows" — automatic resume-after-crash is post-1.0. |
| Content / CMS | "A content engine: schema-driven collections, markdown/MDX, store + CLI + MCP." Search/embeddings/prose/seo tooling and most components are **preview** — label them. **No** "visual CMS / Studio editor" claim; it isn't in the v1 surface. |
| Plugins / themes / extensibility | **Do not claim.** Designed but deferred post-1.0 (ADR 0014). May say "an extensibility model is on the roadmap." |
| Realtime / pub-sub over the wire | DB-backed pub/sub ships; Postgres `LISTEN/NOTIFY` realtime is roadmap — don't imply live sockets. |
| "Lesto Cloud" / managed hosting | **Do not claim.** Future commercial layer, unscoped. |
| Agent / MCP control plane | **The wedge — claim it confidently, but precisely.** Real MCP control-plane tools today: publish/edit content (`create_content_entry`/`update_content_entry`/`query_content`), generate UI (`generate_ui`), and inspect/drive the running app (`list_routes`/`handle_request`). **Schema migrations are NOT an MCP tool yet** (CLI/code only) — do not imply "migrate the schema from Claude." Say "operate your app — content, UI, requests — from Claude/ChatGPT." |

Rule of thumb: if a docs page or package README doesn't tag something "preview", it's
held to the full bar and you may claim it. If it's tagged preview or deferred, mark
it as such in public copy too.

## 6. Positioning one-liners (per competitor)

- **vs. Next.js:** "Keep React and SSR; stop assembling the backend from a zoo of
  vendors."
- **vs. Rails / Laravel:** "The same batteries, in strict TypeScript, edge-deployable."
- **vs. Supabase:** "Postgres-as-the-platform, but from the framework down — app,
  batteries, and the agent surface are one coherent thing."
- **vs. WordPress:** "The content + admin + extensibility model, rebuilt on a typed
  substrate." (Mind the extensibility guardrail.)

## 7. Brand assets

- **Mark:** the indigo rounded-square "L" (`#4f46e5`), as in the favicon and
  `site/src/og.ts`. Wordmark is "Lesto" in a system sans, weight 800.
- **Social card:** shipped as `og.svg` (built by `site/build.ts`, referenced by
  every docs page's `og:image`/`twitter:image`). A 1200×630 **PNG export** of the
  same design is the remaining belt-and-suspenders asset for unfurlers that reject
  SVG (Twitter/iMessage) — tracked as the OG-image board task.
- **Colors:** indigo `#4f46e5` primary, `#3730a3` deep, `#c7d2fe`/`#e0e7ff` light
  accents on dark. Keep it restrained.

## 8. Do / Don't

- ✅ "Lesto runs the same app on a Node server and the Cloudflare edge."
- ✅ "No Redis — the queue, cache, and pub/sub live on the database."
- ✅ "Operate it from Claude over MCP."
- ❌ "The fastest framework ever built." (unproven, and we don't talk like that)
- ❌ "A full visual CMS." (not shipped)
- ❌ "Durable, crash-proof workflows." (post-1.0)
- ❌ Any benchmark number we haven't actually measured and published.
