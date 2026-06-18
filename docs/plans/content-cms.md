# Content / Docks CMS — v1 plan

Derived from `docs/reviews/content-cms.md`, reconciled with `docs/ROADMAP-V1.md` (which rules).
Packages: the 15 `content-*` packages. **Scope ruling (roadmap §1):** v1 ships the
**store/MCP/CLI seam** (`content-store`, `content-core` engine, `volo content:build`,
`@volo/mcp` content tools) as supported surface; the rest of the folded-in Docks estate ships
tagged **experimental/preview**, remains coverage-gate-exempt, and does not gate launch beyond
the items below.

**The bar (supported-surface increments):** TS/ESM/Bun; oxlint/oxfmt clean; 100% vitest coverage
on `content-store` (the natively-built package — keep its threshold); frozen-baseline packages
take targeted tests for the touched behavior without a full ratchet; `ws:typecheck` + the serial
coverage gate green; coded errors; one conventional commit on `main`.

## Increments (ordered)

1. **Fix `sanitizeHtml` packaging + fail-loud** — `[Wave 0 | P0 | blocker #5]`
   Files: `packages/content-shared/src/sanitize.ts:16-27`, `packages/content-shared/package.json` — move `jsdom` to `dependencies` (or make the DOM an explicit injection); replace the bare `require("jsdom")` with `createRequire`/dynamic import so Node ESM works; when no DOM implementation is available (DOMPurify `isSupported === false`, i.e. Cloudflare Workers), **throw a coded `SecurityError`** instead of returning the input unchanged.
   Acceptance: a Workers-shaped runtime test proves the throw; a Node ESM consumer test proves the import; the React/Vue `HtmlContent` paths still sanitize.

2. **Airtight store: transactional persist + slug pinning** — `[Wave 1 | P1 — lands with the dialect wave so it's proven on both drivers]`
   Files: `packages/content-store/src/persist.ts:56-81` (wrap `persistEntries` in a single transaction — also collapses 10k round trips into one on PG), `packages/content-store/src/write.ts` (pin `slug` alongside `id`/`collection`/`file` in `updateEntry`, or document slug mutability — call: **pin it**; the slug index must not desync from the entry-id path).
   Acceptance: a crash-mid-persist test leaves the table fully old or fully new; `--prune` after a failed persist is safe; slug immutability pinned; suite runs in the `db-parity-postgres` leg.

3. **Renderer security parity** — `[Wave 2 | P1]`
   Files: `packages/content-markdown/src/renderer.ts:50-77` (add `rehype-sanitize` to the unified pipeline and the md4w-WASM-failure fallback, sharing one schema with the hybrid path), `packages/content-components/svelte/HtmlContent.ts` (sanitize by default with the same `unsanitized` escape hatch — or delete the adapter; call: **sanitize it**, deletion costs a framework-matrix claim).
   Acceptance: both markdown paths produce identically-sanitized output for a hostile fixture; the Svelte helper matches React/Vue behavior.

4. **Delete `content-mcp` + stale artifacts** — `[Wave 2 | P1 | cheap coherence]`
   Remove `packages/content-mcp` (its Studio API target at `localhost:4400` does not exist in this repo; `@volo/mcp` supersedes it) and the stale `REVIEW.md` files in `content-mcp`/`content-vite`; add the missing package.json descriptions (content-lint, content-prose, content-seo).
   Acceptance: workspace compiles; `@volo/mcp` content tools unaffected; no `@usedocks` self-reviews left to mislead an auditor.

5. **Document the MDX trust boundary** — `[Wave 2 | P2]`
   Files: `packages/content-mdx/src/compiler.ts` / `components/MDXContent.tsx` doc headers — "MDX is code; never compile untrusted input"; note the CSP `'unsafe-eval'` cost; state explicitly that the `@volo/mcp` write tools produce `.md`, never `.mdx`, and keep it that way.
   Acceptance: the boundary is stated at both API points; an MCP-tools test pins the md-only output shape.

6. **Mark the preview boundary in docs** — `[Wave 5 | P1 | part of the docs truth-up]`
   README/ARCHITECTURE/package descriptions: supported = store/engine/CLI/MCP seam; preview = search, embeddings, prose, lint, seo, query, vite, components beyond HtmlContent. Document the search `<10k docs` ceiling and the embeddings cold-build model download while there.

## Owned elsewhere (do not duplicate)

- The MCP server itself, `volo mcp`, tool authz/audit → **operability-dx** items 4 (the content tools ride that governance).
- Dialect layer the store's PG leg depends on → **data-persistence** item 1.

## Deferred post-1.0 (deliberate, in order of likely value)

1. **Consolidation wave** to ~7 packages: fold `content-query` into core's `query.ts`; merge `content-lint`+`content-prose` (dedupe the byte-identical `position.ts`) or park them outside the monorepo; reconcile `content-seo` with `@volo/seo` into one JSON-LD source of truth (three escape implementations today).
2. **Observability wiring**: connect the pipeline's existing event vocabulary + cache hit rates to `@volo/observability`; expose build metrics in `GenerateResult`.
3. **`/api/embed` decision**: ship the query-embedding endpoint as a Volo route or remove the option; surface the silent keyword-only degradation either way.
4. **Coverage ratchet** for the frozen 14, starting with content-markdown (1 test file for a dual renderer) and content-components.
5. Move voice/voice-training/RAG (~3.4k lines) out of `content-core` to a subpath or `content-ai`; switch umbra to `CORE_SCHEMA`; size guards on fetched search indexes.
