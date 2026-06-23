---
title: Let an agent drive your app — and keep the receipts
description: Lesto exposes its operations to an MCP server, so an agent can operate your running app from Claude or ChatGPT — read-only by default, destructive actions gated behind an explicit mode, and every action audited.
date: "2026-06-22"
author: The Lesto team
---

# Let an agent drive your app — and keep the receipts

Everyone is bolting AI onto apps. Far fewer are letting an agent actually *do* things inside one — and for good reason. The moment an agent can change your data, two questions get sharp: **what is it allowed to touch, and what did it just do?** The usual answer is a shrug: hand the model an API token, expose some endpoints, and hope. No floor on its permissions, no record of its actions.

Lesto takes the opposite stance. The agent surface is a first-class, *governed* part of the framework — not a bolt-on. An agent can operate your running app from an MCP client (Claude, ChatGPT, an editor agent), but only through one choke point that is **read-only by default**, gates destructive actions behind an explicit mode, and **audits every action**. This is the part of "agent-native" that's actually novel, and it's shipped.

## One operations layer, three equal surfaces

The reason this works is structural. In Lesto, every capability is an *operation* in one core layer; the CLI, the UI, and the **MCP server** are three thin front-ends over that same layer (this is a founding principle, not a feature). So "operate your app from Claude" isn't a special AI integration — it's the MCP surface calling the exact operations the CLI already calls. An agent can't do anything you couldn't do from the command line; it's the same operations, a different caller.

Today the MCP server (`@lesto/mcp`) exposes nine operations:

- **Inspect:** `list_routes` (what the app answers), `query_content` / `list_content_collections` / `get_content_entry` (read the content).
- **Change content:** `create_content_entry`, `update_content_entry`, `delete_content_entry`.
- **Generate UI:** `generate_ui` (a Lesto UI tree from a prompt).
- **Drive the app:** `handle_request` (dispatch a real request through the running app and get its response).

So an agent can read your routes, publish and edit content, and exercise your live endpoints — in plain language, from the client you already use. (Note the honest boundary: schema migrations are *not* on this surface — those stay in code and the CLI.)

## The novel part: it's governed at one choke point

Every tool call goes through one `dispatch`, and `dispatch` does two things no "give-the-agent-an-API" setup does.

**It defaults closed.** A server has a mode, and the floor is read-only:

```ts
type McpMode = "read-only" | "operator"; // unset → "read-only"
```

A tool that mutates state or drives the live app — the content writes, `handle_request` — is marked destructive, and a destructive tool **refuses outside `operator` mode**. The safety property that matters: if you forget to configure the mode, the agent gets the *safe* surface, not the dangerous one. You opt *in* to letting an agent change things; you don't opt out of a wide-open default.

**It audits everything.** The audit sink is mandatory, and there is **no un-audited path to a tool**. Every dispatch — success or failure — writes one record before the result surfaces:

```ts
interface McpAuditRecord {
  tool: string;
  inputHash: string; // a hash, not the (possibly sensitive) raw arguments
  outcome: "ok" | "error";
  durationMs: number;
}
```

So you always have the receipts: which tool an agent invoked, whether it succeeded, how long it took — and, deliberately, a *hash* of the input rather than the raw arguments, so the audit trail itself doesn't become a place sensitive data leaks. Point the sink at your logs, a table, wherever; the guarantee is that nothing an agent runs is invisible.

## What no one else ships

Next.js, Rails, Laravel — none of them have an agent control plane at all. You can of course expose your own endpoints to a model, but then *you* own the permission model and the audit trail, hand-rolled, per app. Lesto makes the agent surface part of the framework, with the floor and the paper trail built in. That's the difference between "you *can* let an agent call your API" and "your framework knows how to be operated by an agent, safely."

And because it's the same operations layer underneath, the story composes: the CLI, the visual surface, and the agent are interchangeable front-ends. Drive a change from Claude when you're away from your editor; do the identical thing from the CLI in CI. Neither is privileged; both are audited the same way.

## Try it

The control plane is real today. The fastest way to feel it is to point an MCP client at a Lesto app and ask it to list the routes, then publish a piece of content — and watch the audit records land. The agent-native design, and what's shipped versus on the roadmap, is laid out in [Why Lesto](/why-lesto).
