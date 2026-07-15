# Plan 027: Design + implement `toolChoice` on the `LanguageModel` seam

> **Executor instructions**: This plan has a small, well-scoped implementation
> (add `toolChoice` to the seam) plus a larger follow-on (migrate `ui-generate`
> off the raw SDK). Do the seam change first; scope the `ui-generate` migration as
> a follow-up unless it falls out cleanly. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 164bcaa..HEAD -- packages/ai/ packages/ui-generate/`

## Status

- **Priority**: P2 (direction)
- **Effort**: coarse S (seam) / M (with the ui-generate migration)
- **Risk**: LOW (additive to the seam)
- **Depends on**: none
- **Category**: direction / architecture
- **Planned at**: commit `164bcaa`, 2026-07-11

## Why this matters

ADR 0021 says `@lesto/ai` owns a model-agnostic `LanguageModel` fetch seam (not
an SDK dependency), and the seam should be tightened, not bypassed. But the seam
**cannot express a forced tool call**: `packages/ai/src/types.ts:197` has
`tools?: ToolSet` and there is **no** `toolChoice`/`tool_choice` anywhere in
`packages/ai/src`. That missing capability is exactly why `ui-generate` bypasses
the seam — it imports `@anthropic-ai/sdk` raw (`ui-generate/src/anthropic.ts:11`)
with a hardcoded `claude-opus-4-8` to force its tool. Adding `toolChoice` to the
seam is the fill-in work that unblocks the tracked migration (`L-74c3cf1e`), makes
UI generation model-agnostic (local models via `createOpenAICompatible`) and
traceable under the ADR 0031 `ai.*` span vocabulary, and drops a heavyweight
vendored SDK from a published package.

## Current state

- `packages/ai/src/types.ts:197` — `tools?: ToolSet`, but **no** `toolChoice`
  field (grep `packages/ai/src` for `toolChoice`/`tool_choice` → nothing).
- Providers to wire it through: `packages/ai/src/anthropic.ts` (Anthropic wire
  format) and `packages/ai/src/openai-compatible.ts` (OpenAI-compatible wire).
- `packages/ui-generate/src/anthropic.ts:11` imports `@anthropic-ai/sdk` directly
  and hardcodes the model to force its tool — the bypass ADR 0021:218 (F23, task
  `L-74c3cf1e`) already names.
- `packages/ai/src/index.ts:73-75` shows the seam is span-vocabulary-aligned for
  one-trace observability — raw SDK calls from `ui-generate` are invisible to it.
- `ui-generate`'s SDK dep is at `^0.102.0` (0.x caret = frozen) vs the current
  release.

### Conventions to follow

- ADR 0021: own a fetch seam, not the vendor SDK. `toolChoice` must be expressed
  in the seam's own types and translated per-provider to each wire format — not by
  leaking a vendor type.
- Anthropic and OpenAI-compatible tool-choice wire shapes differ (`tool_choice`
  object vs. string/enum) — translate in each provider.
- `@lesto/ai` is 100%-coverage-gated; both providers' `toolChoice` translation
  needs full coverage.

## What to produce

1. **Seam change (do this):** add a `toolChoice` field to the request type
   (e.g. `"auto" | "required" | "none" | { name }` — pick the union that both
   providers can honor), translate it in the Anthropic and OpenAI-compatible
   providers to their wire formats, with tests.
2. **Migration design (scope, implement if clean):** replace
   `ui-generate/src/anthropic.ts`'s raw SDK usage with the seam (using the new
   `toolChoice`), making the model injectable rather than hardcoded; drop the
   `@anthropic-ai/sdk` dependency from `ui-generate` if nothing else needs it.

## Steps

### Step 1: Add `toolChoice` to the request type

Extend the seam's request type (`packages/ai/src/types.ts` near `tools`, `:197`)
with a `toolChoice` field. Document the union and that each provider translates
it. Three requirements from review:
- **It must ride `streamText` too**, not just the non-streaming call. Note this
  lands adjacent to the in-flight streaming-tool-call fix (`L-a65b7ede`) —
  coordinate so the two don't collide in the stream types.
- **`toolChoice: { name }` naming an undeclared tool must fail LOUD** at the
  boundary (ADR 0005: validate at the boundary), not silently forward.
- **Document the per-endpoint honoring caveat**: OpenAI-*compatible* local
  servers (Ollama/LM Studio/vLLM) honor `required`/forced-tool unevenly. The seam
  forwards the wire value; say in the union's doc what happens when a provider
  silently ignores it (the STOP condition covers the *un-mappable* case; the doc
  must cover the *silently-ignored* case).

**Verify**: `cd packages/ai && bun run typecheck` → exit 0.

### Step 2: Translate per provider + test

Wire `toolChoice` into the Anthropic and OpenAI-compatible request builders;
add tests for each translation (forced tool, auto, none, required as applicable).

**Verify**: `cd packages/ai && bun run typecheck && bun run test:cov` → exit 0, 100%.

### Step 3: Design (and, if clean, execute) the ui-generate migration

Replace the raw SDK path with the seam + `toolChoice`; make the model injectable;
drop the SDK dep if unused. If the migration is more than mechanical, STOP after
the seam change and record the migration as a follow-up (it's the tracked
`L-74c3cf1e`).

⚠️ **`ui-generate/src/anthropic.ts` is currently coverage-EXCLUDED**
(`packages/ui-generate/vitest.config.ts:13`). Once it is seam-backed and the
model is injectable, the migration must **remove that exclusion** and cover the
file with a fake `LanguageModel` — otherwise "`test:cov` 100%" is hollow for the
one file this plan exists to fix.

**Verify** (if executed): `cd packages/ui-generate && bun run typecheck && bun run test:cov` → exit 0, 100% **with the `anthropic.ts` coverage exclusion removed**; `grep -rn "@anthropic-ai/sdk" packages/ui-generate/src` empty.

## Done criteria

- [ ] `grep -rn "toolChoice" packages/ai/src` shows the field + both provider translations
- [ ] `cd packages/ai && bun run test:cov` exit 0, 100%, translation tests present
- [ ] A `ui-generate` migration design exists (executed if it fell out cleanly)
- [ ] `plans/README.md` status row for 027 updated (with the seam done + migration status)

## STOP conditions

- The two providers can't honor a common `toolChoice` union without leaking a
  vendor-specific shape — report the minimal union that works and what's dropped.
- The `ui-generate` migration needs behavior changes beyond swapping the client —
  ship the seam change and scope the migration separately (it's `L-74c3cf1e`).

## Maintenance notes

- Once the seam has `toolChoice`, no published package should import a vendor AI
  SDK directly (ADR 0021) — note that so the bypass doesn't reappear.
- Reviewer should confirm the seam stays vendor-neutral and that any `ui-generate`
  change keeps its output under the `ai.*` trace vocabulary.
