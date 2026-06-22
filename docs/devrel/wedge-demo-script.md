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

1. A running Lesto app with content + the MCP server attached. The
   [`examples/blog`](../../examples/blog) app plus the docs content collection is
   the cleanest stage; `examples/estate` if you want a richer-looking page.
2. The `@lesto/mcp` control plane served over stdio and connected to Claude
   Desktop (or any MCP client). Confirm the tools resolve: in Claude, the Lesto
   server should list `list_routes`, `handle_request`, `generate_ui`,
   `list_content_collections`, `query_content`, `create_content_entry`,
   `update_content_entry`, `delete_content_entry`.
3. Two windows tiled: **left** = Claude; **right** = the browser on the app.
   Terminal in a third space for the final ship beat.
4. Pre-seed nothing you'll create on camera. Clear the post you're about to add so
   the "before" is honestly empty.
5. Font scale up in both Claude and the browser (recording reads small).
6. Do one dry run end-to-end — MCP tool latency varies; you want the beats tight.

---

## Beat sheet

| # | Time | On screen | Voiceover / on-screen text | Real action |
|---|---|---|---|---|
| 0 | 0:00–0:07 | Title card → cut to the live app in the browser | **VO:** "This is a real Lesto app, running right now." On-screen text: *Lesto — the framework you can drive from Claude.* | — |
| 1 | 0:07–0:18 | Cut to Claude; the Lesto MCP tools panel visible | **VO:** "Lesto exposes its operations as MCP tools — so Claude can see the app, not just talk about it." | Type: *"What routes does this app serve?"* → Claude calls **`list_routes`**, lists them. |
| 2 | 0:18–0:42 | Claude (left), browser (right) | **VO:** "Let me add a blog post — in plain English." | Type: *"Publish a post titled 'Shipping from Claude' — a short note that our launch is live."* → Claude calls **`create_content_entry`**. Cut to browser, refresh → **the post is live.** |
| 3 | 0:42–1:02 | Claude → browser | **VO:** "Now build some UI — from a sentence." | Type: *"Generate a hero section: a headline 'Batteries-included. Agent-native.' and a 'Get started' button."* → Claude calls **`generate_ui`**, returns a validated UI tree; show it rendered. On-screen text: *validated against the component registry.* |
| 4 | 1:02–1:18 | Claude | **VO:** "And it's the real running app — here's the live API." | Type: *"Fetch the posts from the API."* → Claude calls **`handle_request`** (`GET /api/posts`) → real JSON response including the new post. |
| 5 | 1:18–1:30 | Terminal → browser at the deployed URL | **VO:** "Then ship it — one command to the edge." | Run `lesto deploy --cloudflare`. Cut to the live `*.workers.dev` URL showing the change. |
| 6 | 1:30–1:38 | Title card | On-screen text: **Batteries-included. Agent-native.** / `lesto.run` | **VO:** "Lesto. The batteries are in the box — and an agent can drive them." | — |

---

## The exact prompts to type (copy/paste into Claude)

1. `What routes does this app serve?`
2. `Publish a post in the "blog" collection titled "Shipping from Claude" — a short note that our launch is live.`
3. `Generate a hero section for the homepage: a headline "Batteries-included. Agent-native." and a "Get started" button.`
4. `Fetch the posts from the JSON API and show me the response.`

Each maps to a real tool (beats 1–4). If a call needs an argument Claude doesn't
infer (e.g. a slug), let it ask and answer naturally on camera — the back-and-forth
*is* the proof it's a real control plane, not a canned script.

---

## GIF / loop cut (6–10s, silent, captioned)

Just beat 2, tightened: caption *"Publish a blog post — from one sentence in
Claude"* → the `create_content_entry` call → hard cut to the browser refresh with
the post live. End on the tagline frame. This is the single most shareable moment;
it earns the click to the full video.

---

## Claims guardrail (do not break these on camera)

The wedge is real — keep it real. Per [`docs/brand/messaging.md`](../brand/messaging.md):

- **Show only tools that exist.** The control plane today is `list_routes`,
  `handle_request`, `generate_ui`, and content CRUD. Film those.
- **Do NOT stage a "migrate the schema from Claude" beat.** There is no
  schema/migration MCP tool yet — schema changes go through the CLI or code.
  Implying otherwise is the kind of overclaim that sinks credibility. (If/when a
  migration tool ships, add a beat — not before.)
- **Deploy is the CLI step**, narrated as "ship it." The agent makes the changes;
  `lesto deploy` ships them. Don't imply the agent deploys.
- **`generate_ui` returns a validated UI tree** rendered to React — show that, not
  a fully auto-published homepage redesign unless you've actually wired the render.
- No fake latency edits that imply it's faster than it is. Tight is fine; dishonest
  is not.

## Distribution (after the cut is approved)

- README hero (GIF) + the [launch post](../../) (full video) — the launch post is
  blocked on publish day; this asset unblocks its hero.
- Native upload to X/Bluesky/LinkedIn (don't just link YouTube).
- A 3–4 tweet thread: hook (GIF) → "how it works" (MCP tools) → "try it" (link).
