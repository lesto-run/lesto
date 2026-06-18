# UI & Client Pipeline — v1 plan

Derived from `docs/reviews/ui-client.md`, reconciled with `docs/ROADMAP-V1.md` (which rules).
Packages: `@volo/ui`, `@volo/ui-kit`, `@volo/ui-generate`, `@volo/assets`, `@volo/forms`.
`docs/plans/island-data-hardening.md` is **executed** (ADR 0012 inversion, primer hardening,
CLI↔assets wiring, blog proof — all verified by the review); nothing here re-lists it. This plan
**owns the `ui.dialect` key** end-to-end, including its CLI touch (operability-dx references it).

**The bar, every increment:** TS/ESM/Bun; oxlint/oxfmt clean; 100% vitest coverage on touched
packages; `bun run ws:typecheck` + the serial coverage gate green; coded errors; truthful doc
comments; one conventional commit on `main`.

## Increments (ordered)

1. **Scheme-guard `Button.href` and `Form.action`** — `[Wave 0 | P1 | ships in the stop-the-bleed pass]`
   Files: `packages/ui-kit/src/components.tsx:239`, `packages/forms/src/components.tsx:48` — allowlist `https:`/`http:`/relative (+ `mailto:` for Button); on refusal render a `<button>` / drop `action`, and report through the render-error channel. Closes the one real XSS vector in the AI-tree path.
   Acceptance: `javascript:`/`data:`/`vbscript:` and protocol-relative trickery covered; relative and absolute-https pass.

2. **Split the `@volo/ui` barrel** — `[Wave 2 | P0 | blocker #8, part 1]`
   Files: `packages/ui/src/index.ts` → isomorphic core (`Registry`, island types, `defineIsland`, data tokens, `hydrate`); new `@volo/ui/server` subpath export (render/stream/resolver/metadata/resources — everything touching `react-dom/server`); `packages/assets/src/synthesize.ts` imports isomorphic modules only; delete the two react-dom shims in `packages/assets/src/preact-alias.ts` this makes unnecessary; update `@volo/web`/examples imports.
   Acceptance: **bundle-size assertion tests** (measured via `Bun.build --minify` in CI): react entry ≤ 65 KB gzip, preact ≤ 15 KB — the regression can never silently return. All consumers compile.

3. **Land `ui: { dialect }` as the matched pair** — `[Wave 2 | P0 | blocker #8, part 2]`
   Files: `volo.config` schema + `packages/cli/src/bin.ts:78` (replace the hardcoded `"react"`); the key drives the client alias (`@volo/assets` preact plugin) AND the server renderer atomically (ADR 0008's matched pair); extend the `ServerRenderer` seam into `renderPageResponse` (`packages/web/src/render-page.tsx:213`, `packages/ui/src/stream.tsx`) — preact streaming adapter, or a documented buffered fallback under preact; `create-volo` scaffolds `dialect: "preact"` (ADR 0011 Increment 3; coordinate the scaffold file with operability-dx item 1 — they land in the same wave).
   Acceptance: a scaffolded app serves an `ssr: true` island under preact through `volo dev` and `volo build`; mismatched-pair configuration is a coded build error; estate's bespoke worker path keeps working.

4. **Write-then-sweep chunk builds** — `[Wave 2 | P1]`
   Files: `packages/assets/src/build-client.ts:127` — write new artifacts first, then sweep anything not in the new set (hashed names make this safe); production builds keep one previous generation for CDN-cached documents in flight.
   Acceptance: a rebuild during a simulated in-flight old-entry request serves the old chunks; crash-between-phases leaves a servable out-dir.

5. **Client error beacon** — `[Wave 4 | P1]` (pairs with operability-dx item 3's tracing wire)
   Files: `packages/assets/src/synthesize.ts` — the synthesized entry forwards `HydrationResult` (`failed`/`missing`) + `onMountError`/`onRecoverableError` to a sampled POST `/__volo/client-errors`; `packages/web` ships the receiving route feeding the kernel's OTLP pipeline; dev mode renders the ADR-0011-promised overlay instead.
   Acceptance: a deploy-skew unknown component produces an operator-visible event in the integration test; sampling bounded; no PII in payloads.

6. **Converge the island paths** — `[Wave 5 | P1 | ADR 0011 Increment 2]`
   Migrate estate onto `.page`/`defineIsland`/`hydrateDocumentIslands`; then demote the Registry-manifest island path (`hydrateIslands` public manifest form, page-wide `serializeManifest`) to the content/DB-driven niche or delete it; one client entry point; type `Registry.defineClient` or retire it (the item-9 deferral from island-data-hardening resolves here).
   Acceptance: every island invariant enforced in exactly one emission site; estate's Lighthouse posture (the regression canary) holds; `islandMount` stops needing heroics.

7. **Diagnostics polish batch** — `[Wave 5 | P2]` (small, one PR)
   Carry the thrown error on `render_threw` (`packages/ui/src/render.tsx:266` — `detail`/`cause` on `RenderError`); surface `validateProps` errors in the render walk as `invalid_props`; coded `ASSETS_BAD_ISLAND_MODULE` for malformed island modules (`packages/assets/src/bun.ts:50`); warn on Registry cross-namespace shadowing; `buildClient` emits per-artifact gzip sizes + a configurable budget that fails the build; refresh ADR 0011's stale status block.
   Acceptance: each diagnostic pinned by a test; the build narrates what it decided (ADR 0011's promise).

8. **Per-route opt-out of the app-wide `private` cache cliff** — `[Wave 5 | P2]`
   Files: `packages/web/src/volo.ts:237` — track at registration which pages' island graphs bind private sources, or a per-route override, so island-free marketing pages stay cacheable.
   Acceptance: a page with no private binds carries the default cache policy; estate/blog unchanged.

## Owned elsewhere (do not duplicate)

- The CLI's `volo dev`/`build` plumbing and scaffold e2e → **operability-dx** item 1 (this plan owns the dialect key the CLI reads).
- `/__volo/data` middleware-ordering hazard → folded into item 6's convergence (data routes composed at dispatch time).
- OTLP wiring the beacon feeds → **operability-dx** item 3.

## Deferred post-1.0 (deliberate)

- Nonce plumbing for primer/bootstrap inline scripts — one coherent CSP increment with core-runtime, post-1.0 (no served path enforces a CSP today).
- PropSpec → Zod fold (three validators → one); `defineClient` typed `data` — both die or land with the path convergence's aftermath.
- `ui-generate` provider adapters beyond Anthropic.
