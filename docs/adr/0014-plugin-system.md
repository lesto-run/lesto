# ADR 0014 — A first-class plugin/extensibility system (post-1.0)

- **Status:** Proposed / Deferred (post-1.0)
- **Date:** 2026-06-16
- **Supersedes:** the orphaned `@volo/hooks` and `@volo/config` packages, removed
  from the v1 surface (see "Context" and `docs/ROADMAP-V1.md` §1, §6).

## Context

ARCHITECTURE.md sells extensibility as a Volo pillar — "an extensibility model
(hooks/plugins/themes) built in", echoing the WordPress actions/filters lesson and
Laravel's events/listeners. Two packages were built toward it ahead of the rest of
the system:

- `@volo/hooks` — WordPress-style instance-based actions (side effects) and filters
  (value transforms), built and 100%-tested.
- `@volo/config` — a typed configuration loader, built and 100%-tested.

Both shipped as **orphans**: zero packages and zero examples imported either one
(verified across every `package.json` and source tree in the monorepo). The kernel
never fired a hook; nothing read config through the loader. They were dead public
surface that the architecture doc nonetheless advertised as load-bearing.

The roadmap's call (`docs/ROADMAP-V1.md` §6, "Hooks/config orphans"): **delete from
the v1 surface.** A plugin system designed under launch pressure, with no real
consumer pulling on its shape, would be the wrong plugin system — the worst of both
worlds is carrying dead surface into a 1.0 we then must not break. The WordPress-lesson
extensibility bet returns post-1.0 as its own designed increment — this ADR is its
placeholder so the intent is not lost.

## Decision (deferred)

Defer the extensibility system to **post-1.0** and design it then against real
consumers, not in the abstract. When taken up, it should reconcile (at minimum):

- **Lifecycle hooks** — named extension points the framework fires during boot and
  request handling (the actions/filters shape `@volo/hooks` prototyped), wired into
  the kernel and request lifecycle so they are reachable, not dangling.
- **Events & listeners** — domain events with async listeners that run as queued jobs
  (the Laravel half), distinct from synchronous hooks; clarify when each fires.
- **Plugin registration** — installable packages that register hooks, models, routes,
  jobs, admin panels, MCP tools, and UI components — and crucially are reachable from
  **agents** through the MCP control plane, per the AI-native north star.
- **Typed configuration** — whatever config surface plugins and the kernel actually
  need (the `@volo/config` prototype returned an untyped `Record`; a real design
  earns its "typed" claim against concrete call sites).
- **Themes/templates** — the Loom-as-theme-engine story, once there is a consumer.

## Consequences

- The two orphan packages are **deleted** in Wave 5 (`git rm -r packages/hooks
  packages/config`); the coverage-gate runtime shrinks by two suites. The gate is
  glob-based (`readdirSync(packages/)`, skip dirs without a `package.json`/`test:cov`)
  and the workspaces glob is `packages/*`, so the removal needs no gate or workspace
  edit.
- ARCHITECTURE.md's "built in" framing for hooks/plugins/themes is corrected to point
  at this deferred ADR, so the doc claims only what the code backs.
- No public extensibility API ships in 1.0 — a deliberate non-promise. Apps that need
  ad-hoc extension points compose plain functions/events in user space until this
  lands.

## Status block

| Item | State |
|---|---|
| `@volo/hooks` / `@volo/config` removed from v1 surface | Done (Wave 5) |
| Lifecycle hooks wired into kernel/request lifecycle | Deferred (post-1.0) |
| Events & listeners (queued) | Deferred (post-1.0) |
| Plugin registration (code + MCP/agent surface) | Deferred (post-1.0) |
| Typed configuration | Deferred (post-1.0) |
| Themes/templates | Deferred (post-1.0) |
