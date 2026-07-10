# Wedge demo — shooting script

**The asset:** a 75–90 second screencast (plus a 6–10s looping GIF cut) that shows
the one thing no incumbent framework can: **operating a real, running Lesto app
from Claude over MCP** — publish content, generate UI, drive the app — then
shipping it. This is the lead asset for the launch post, the README hero, and
social.

> Owned by DevRel. The recording is a human step; this script makes it
> reproducible and keeps every on-screen claim true. Read the **Claims guardrail**
> before filming.

---

## Logline

> "This is a running app. Watch me change it — add a post, build a UI, hit the
> API — from Claude, without opening my editor. Then ship it."

## Audience & tone

Mid/senior TypeScript devs who've felt the Next.js "assemble-the-backend" pain.
Tone: calm, fast, zero hype. Let the tool calls do the talking. No music bed over
the VO, or a very low ambient pad.

## Target length

- **Hero cut:** 75–90s (launch post, YouTube, docs).
- **GIF/loop cut:** 6–10s, silent, captioned — Act 1 only (publish a post from a
  sentence → it appears live). This is the README/social loop.

---

## Prep checklist (before you hit record)

1. A running Lesto app the MCP server can boot. `lesto mcp` loads `./lesto.app.ts`
   from the working directory, so the stage **must** ship one —
   [`examples/estate`](../../examples/estate) is the pick: it has a `lesto.app.ts`,
   a rich two-zone marketing + app UI, and live JSON routes (great for
   `list_routes`, `handle_request`, and `generate_ui`). Do **not** use
   `examples/blog` — it has no `lesto.app.ts`, so `lesto mcp` won't boot there.
   estate ships no content collection out of the box, so the content beats
   (`create_content_entry` / `query_content`, beat 2 + the GIF cut) need a stage
   with the content peers (`@lesto/content-core`, `@lesto/content-store`) installed,
   a collection declared, AND a route that renders it — estate has none, so the
   browser-refresh payoff needs this stage work. Set that up first, or cut those
   beats and drive the app through `handle_request` instead.
2. The `@lesto/mcp` control plane served over stdio and connected to Claude
   Desktop (or any MCP client). **Start it in operator mode** — `lesto mcp
   --operator` — because the demo drives destructive tools (`create_content_entry`,
   `handle_request`). Read-only is the safe default: without `--operator` those
   calls refuse with `MCP_OPERATOR_REQUIRED`, so you opt *in* to writes on camera.
   Confirm readiness by *calling* a tool, not by reading the panel. `buildTools`
   unconditionally advertises all ten framework tools — `list_routes`,
   `describe_app`, `handle_request`, and the content tools
   (`list_content_collections`, `query_content`, `create_content_entry`,
   `update_content_entry`, `delete_content_entry`) are listed whether or not the
   content peers are installed; a missing peer surfaces only *at call time* as
   `MCP_CONTENT_PACKAGES_MISSING`. So in the dry run, actually call
   `list_content_collections` — a clean result (not that error) is your proof the
   content stage is wired. Only `generate_ui` is conditionally *omitted* from the
   list: it appears **only when** an Anthropic key + a component registry are
   configured (it's a preview generator, omitted otherwise).
3. Two windows tiled: **left** = Claude; **right** = the browser on the app.
   Terminal in a third space for the final ship beat.
4. Pre-seed nothing you'll create on camera. Clear the post you're about to add so
   the "before" is honestly empty.
5. Font scale up in both Claude and the browser (recording reads small).
6. Do one dry run end-to-end — MCP tool latency varies; you want the beats tight.
7. For the ship beat (beat 5), estate deploys with its own runbook `bun run deploy`
   (`routes:gen` → `build.ts` → `wrangler deploy`) — **not** `lesto deploy
   --cloudflare`, which would mismatch estate's Preact-SSR worker. Run `wrangler
   login` once, and **`wrangler secret put SESSION_SECRET`** before deploying —
   without it the deployed Worker fail-closes on the first request.

---

## Beat sheet

| # | Time | On screen | Voiceover / on-screen text | Real action |
|---|---|---|---|---|
| 0 | 0:00–0:07 | Title card → cut to the live app in the browser | **VO:** "This is a real Lesto app, running right now." On-screen text: *Lesto — the framework you can drive from Claude.* | — |
| 1 | 0:07–0:18 | Cut to Claude; the Lesto MCP tools panel visible | **VO:** "Lesto exposes its operations as MCP tools — so Claude can see the app, not just talk about it." | Type: *"What routes does this app serve?"* → Claude calls **`list_routes`**, lists them. |
| 2 | 0:18–0:42 | Claude (left), browser (right) | **VO:** "Let me add a blog post — in plain English." | Type: *"Publish a post titled 'Shipping from Claude' — a short note that our launch is live."* → Claude calls **`create_content_entry`**. Cut to browser, refresh → **the post is live.** |
| 3 | 0:42–1:02 | Claude → browser | **VO:** "Now build some UI — from a sentence." | Type: *"Generate a hero section: a headline 'Batteries-included. Agent-native.' and a 'Get started' button."* → Claude calls **`generate_ui`** — a **preview** generator backed by `@lesto/ui-generate`, present only when an Anthropic key + a component registry are configured — which returns a validated UI tree; show it rendered. On-screen text: *preview — validated against the component registry.* Only film this beat if the key + registry are wired; otherwise cut it. |
| 4 | 1:02–1:18 | Claude | **VO:** "And it's the real running app — here's the live API." | Type: *"Fetch a live JSON route and show me the response."* → Claude calls **`handle_request`** against a route the stage actually serves (on estate, e.g. `GET /lab/api/listings/:id`) → real JSON straight from the running app. |
| 5 | 1:18–1:30 | Terminal → browser at the deployed URL | **VO:** "Then ship it — one command to the edge." | Run `bun run deploy` (estate's runbook). Cut to the live `*.workers.dev` URL — the app, live at the edge. |
| 6 | 1:30–1:38 | Title card | On-screen text: **Batteries-included. Agent-native.** / `lesto.run` | **VO:** "Lesto. The batteries are in the box — and an agent can drive them." | — |

---

## The exact prompts to type (copy/paste into Claude)

1. `What routes does this app serve?`
2. `Publish a post in the "blog" collection titled "Shipping from Claude" — a short note that our launch is live.`
3. `Generate a hero section for the homepage: a headline "Batteries-included. Agent-native." and a "Get started" button.`
4. `Fetch a live JSON route from the running app and show me the response.` *(point it at a route your stage serves — e.g. estate's `GET /lab/api/listings/:id`.)*

Each maps to a real tool (beats 1–4). Prompt 2 (`create_content_entry`) needs the
content-collection stage from the Prep checklist, and prompt 3 (`generate_ui`)
needs the Anthropic key + registry — cut whichever isn't wired. If a call needs an
argument Claude doesn't infer (e.g. a slug), let it ask and answer naturally on
camera — the back-and-forth *is* the proof it's a real control plane, not a canned
script.

---

## GIF / loop cut (6–10s, silent, captioned)

Just beat 2, tightened: caption *"Publish a blog post — from one sentence in
Claude"* → the `create_content_entry` call → hard cut to the browser refresh with
the post live. End on the tagline frame. This is the single most shareable moment;
it earns the click to the full video.

> **Blocked on the beat-2 stage work.** The "refresh → the post is live" payoff
> needs a content collection *and a route that renders it* — estate ships neither
> (see prep item 1). This cut cannot be filmed against bare estate; build that
> content stage first, then record it.

---

## Claims guardrail (do not break these on camera)

The wedge is real — keep it real. Per [`docs/brand/messaging.md`](../brand/messaging.md):

- **Show only tools that exist — on the stage you're filming.** The always-on
  control plane is `list_routes`, `describe_app`, and `handle_request`.
  `generate_ui` is a **preview** tool (present only with an Anthropic key +
  component registry); the content CRUD tools resolve only when the content peers
  are installed and a collection is declared. Film only what your stage actually
  advertises.
- **Do NOT stage a "migrate the schema from Claude" beat.** There is no
  schema/migration MCP tool yet — schema changes go through the CLI or code.
  Implying otherwise is the kind of overclaim that sinks credibility. (If/when a
  migration tool ships, add a beat — not before.)
- **Deploy is the CLI step**, narrated as "ship it." The agent makes the changes;
  `lesto deploy` ships them. Don't imply the agent deploys.
- **`generate_ui` is a preview generator** (backed by `@lesto/ui-generate`) — present
  only when an Anthropic key + a component registry are configured, omitted otherwise.
  It returns a validated UI tree rendered to React; show that, not a fully
  auto-published homepage redesign unless you've actually wired the render. If the
  key/registry aren't set for the recording, cut the beat — don't fake it.
- No fake latency edits that imply it's faster than it is. Tight is fine; dishonest
  is not.

## Distribution (after the cut is approved)

- README hero (GIF) + the launch post (full video) — the launch post is
  blocked on publish day; this asset unblocks its hero.
- Native upload to X/Bluesky/LinkedIn (don't just link YouTube).
- A 3–4 tweet thread: hook (GIF) → "how it works" (MCP tools) → "try it" (link).
