# Content / Docks CMS — Architecture Review

## Domain summary

Docks is the most mature-looking and least framework-integrated domain in Volo: 13 of 15 packages were folded in wholesale from the external `@usedocks/*` project (vitest.config.ts headers say "FROZEN BASELINE — folded in from Docks"), and the CI coverage gate explicitly skips all of them (`scripts/coverage-gate.ts:27`). The core engine (parse → validate → cache → query), the SQL persistence seam (`content-store`, the only package written natively in Volo, at 100% coverage), markdown rendering with build-time sanitization, and build-time embeddings/search are all real, working code — not stubs. **This domain does not gate the v1 launch on its own**, with one carve-out: `@volo/mcp` (an agent-control-plane launch bet) and `@volo/cli` import `content-core`/`content-store` directly (`packages/mcp/src/tools.ts:13-15`, `packages/cli/src/run.ts:19`), so that seam — which is the best-built part of the domain — must work, and it does. The single P0 is a security packaging defect: `sanitizeHtml()` silently becomes a no-op on non-Node runtimes (Cloudflare Workers, Volo's primary deploy target) and crashes for any npm consumer because `jsdom` is a devDependency. The dominant structural problem is over-fragmentation and duplication: 15 packages where ~7 would do, with three copies of JSON-LD escaping, two query APIs, two MCP servers, and a `content-mcp` package that targets a Studio API server that does not exist in this repository.

## Package inventory

| package | maturity | one-line reality (verified) |
|---|---|---|
| content-core | built (legacy) | 21.5k-line engine; parse→validate→cache→query path is solid (`src/pipeline.ts:294-331`); ~3.4k lines of voice/RAG/training modules are real code but produce prompts/JSONL only — no LLM calls |
| content-store | built (native) | The ADR 0006 seam, verified: real migration (`src/migration.ts:20`), parameterized upsert (`src/persist.ts:21-31`), hydrate into runtime via `setData` (`src/hydrate.ts:14-16`); 100% coverage thresholds, 25 tests |
| content-query | built (legacy) | Real 246-line fluent builder; duplicates `content-core/src/query.ts:249-257`; barely imported anywhere |
| content-search | built (legacy) | Real: cosine + Hamming search, binary/zero-copy index formats with magic+version validation, BK-tree typo tolerance, React hook; brute-force O(n), fine <10k docs |
| content-embeddings | built (legacy) | Real: loads `Xenova/all-MiniLM-L6-v2` via `@huggingface/transformers` at build time (`src/embeddings.ts:25-39`), 384-d vectors, SHA-256 cache, 32x binary quantization; local-only, no API fallback |
| content-markdown | built (legacy) | Real dual renderer: md4w+rehype-sanitize fast path (`src/hybrid-renderer.ts:118`), unified fallback **without** rehype-sanitize (`src/renderer.ts:50-77`) |
| content-mdx | built (legacy) | Real mdx-bundler compiler (`src/compiler.ts:141`); renders via `new Function(code)` (`src/components/MDXContent.tsx:46`) — MDX is arbitrary code by design |
| content-components | built (legacy) | React/Vue `HtmlContent` sanitize by default; Svelte adapter is a bare props helper with **no sanitization** (`svelte/HtmlContent.ts:6-8`) |
| content-prose | built, unused | Real 6.9k-line prose linter (fillers/weasels/passive/spelling/custom rules); imported by nothing in the repo |
| content-umbra | built (legacy) | Real frontmatter/YAML/JSON parser, actively used by core/mcp; js-yaml v4 `DEFAULT_SCHEMA` + `sanitizeObject` post-parse (`src/frontmatter.ts:49`, `:249`) |
| content-lint | built, unused | Real a11y/structural markdown linter with 5 test files in `test/`; zero deps; imported by nothing |
| content-seo | built, partial | Real SEO analysis + JSON-LD builders with safe `</script>` escaping; overlaps `@volo/seo` ("pure string builders for … JSON-LD") |
| content-mcp | legacy | Two MCP servers; `http.ts` wraps a "Studio API" at `localhost:4400` that exists nowhere in this repo (`src/client.ts:58`); duplicates `@volo/mcp` content tools |
| content-vite | built (legacy) | Real 242-line Vite plugin (generate on buildStart, watch+HMR, bundle-size guard); carries a stale self-review (`REVIEW.md`) listing issues that have since been fixed in code |
| content-shared | built (legacy) | Real grab-bag (sanitize, cache, mutex, slugify, xml, shutdown…); 12 test files; contains the P0 sanitize defect |

## Performance

- **P2** `packages/content-store/src/persist.ts:56-81` — `persistEntries` awaits one prepared `statement.run()` per entry in a serial loop with no transaction. On Postgres at 10k entries that is 10k network round trips per `content:build`. Recommendation: wrap the loop in a transaction and/or batch inserts; this also fixes the durability issue below.
- **P2** `packages/content-core/src/parser.ts:235-236` — every build re-reads and re-hashes all files (`Promise.allSettled` over the full file list); cache hits skip validation but not I/O. Acceptable for v1 (xxhash + parse/transform caches in `cache/manager.ts:60-69` are correct); note as a known ceiling, revisit if builds exceed ~5k files.
- **P2** `packages/content-search/src/similarity.ts:64-96` — search is brute-force O(n) cosine over all candidates (Hamming variant at `binary.ts:202-287` is ~50x faster but still O(n)). The code's own comment caps practicality at <10k documents. Document this limit; no work needed pre-1.0.
- **P2** `packages/content-embeddings/src/embeddings.ts:25-39` — model (`Xenova/all-MiniLM-L6-v2`, ~25MB) downloads per fresh build environment; no API-based fallback. Cache the model directory in CI; document the cold-build cost.
- Positive: the hybrid md4w renderer (`content-markdown/src/hybrid-renderer.ts:174-181`, ~44x faster than unified), 32x binary quantization, two-tier progressive index loading (`content-search/src/load-index.ts:113-185`), and LRU rejection-evicting index cache (`load-index.ts:254-266`) are genuinely good engineering.

## Security

- **P0** `packages/content-shared/src/sanitize.ts:16-27` + `packages/content-shared/package.json` — `sanitizeHtml()` is broken outside this monorepo and outside Node. (a) `jsdom` is declared only in `devDependencies`, so any npm consumer's server render of `HtmlContent` throws "Cannot find module 'jsdom'". (b) On non-Node runtimes (`isNode === false`) it uses `DOMPurify` without a window; on Cloudflare Workers — Volo's primary deploy target — DOMPurify sets `isSupported = false` and **returns the input unchanged**, a silent sanitization bypass in the function documented "Use for all user-generated or markdown-rendered HTML" (line 44). (c) `require("jsdom")` at line 24 in an ESM (`"type": "module"`) package only works on Bun, not Node ESM. Recommendation: move `jsdom` to `dependencies` (or make it an explicit injection), use `createRequire`/dynamic import, and **fail loudly** (throw `SecurityError`) when no DOM implementation is available instead of returning unsanitized HTML. This mirrors the already-tracked P0 pattern "CF adapter bypasses all hardening" from the server/streaming review.
- **P1** `packages/content-mdx/src/components/MDXContent.tsx:46` — `new Function(...scope, code)` evaluates bundled MDX in the client. This is the standard mdx-bundler pattern, but it (a) makes MDX a remote-code-execution surface if any MDX ever comes from untrusted input (e.g., agent-authored entries via the `@volo/mcp` write tools at `packages/mcp/src/tools.ts:14` — today those produce `.md` virtual entries, not MDX, but nothing documents the boundary), and (b) forces `'unsafe-eval'` into the CSP of every page using `MDXContent`. Recommendation: document "MDX is code; never compile untrusted input" at the `compileMDX` API, and note the CSP cost; consider a server-eval-only mode.
- **P1** `packages/content-components/svelte/HtmlContent.ts:6-8` — the Svelte adapter is just `createHtmlContentProps()` returning the raw HTML; React (`react/HtmlContent.tsx:24`) and Vue (`vue/HtmlContent.ts:35`) sanitize by default. A Svelte user following the same docs renders `{@html}` unsanitized. Recommendation: sanitize in the helper by default with the same `unsanitized` escape hatch, or delete the adapter until it is real.
- **P1** `packages/content-markdown/src/renderer.ts:50-77` — the unified renderer (and the silent fallback when md4w WASM init fails, `hybrid-renderer.ts:168-171`) has no `rehype-sanitize` step; the hybrid path does (`hybrid-renderer.ts:118`). Today this is mitigated because `remark-rehype` drops raw HTML by default, but the two paths have different security postures and a user-supplied rehype plugin or `allowDangerousHtml` flips the unified path open with no warning. Recommendation: add `rehype-sanitize` to the unified pipeline so both paths share one schema.
- **P2** `packages/content-umbra/src/frontmatter.ts:49` — `yaml.load` with `DEFAULT_SCHEMA`. In js-yaml v4 (`package.json:47`, `^4.1.0`) this is safe — code-execution types were removed in v4 — and `sanitizeObject()` is applied post-parse (`frontmatter.ts:249`, blocking `__proto__`/`constructor`/`prototype`, verified in `content-shared/src/sanitize.ts:118`). Recommendation: switch to `CORE_SCHEMA` for least surprise; not a vulnerability.
- **P2** `packages/content-search/src/load-index.ts:114` — fetched indexes validate magic/version/offsets (`zero-copy.ts:109-133`, good) but check neither Content-Type nor any size bound before allocation, and have no integrity hash. Low risk (same-origin static assets); add a max-size guard post-launch.
- Positive: JSON-LD escaping is correct (`content-shared/src/sanitize.ts:84-91` escapes `<`, `>`, `&`, U+2028/9; used by `content-components/react/JsonLd.tsx:38`), MCP slug handling rejects traversal (`content-mcp/src/server.ts:345-359`), store SQL is fully parameterized (`content-store/src/persist.ts:21-31`), and store writes pin identity fields after the data spread (`content-store/src/write.ts:40-44`).

## Simplicity

- **P1 (coherence)** — 15 packages is over-fragmented; the boundary set is wrong in four places, each with concrete duplication:
  - Two query APIs: `content-query/src/index.ts:129-234` vs `content-core/src/query.ts:249-257`. Keep core's, delete the package.
  - Two MCP servers: `content-mcp` (whose `http.ts` mode wraps a Studio API at `localhost:4400` — `src/client.ts:58` — that exists nowhere in this repo) vs the native `@volo/mcp` content tools (`packages/mcp/src/tools.ts:13-15`). The native one is the launch bet; `content-mcp` is dead weight from the @usedocks era.
  - Three JSON-LD/script-escape implementations: `content-shared/src/sanitize.ts:84`, `content-seo`, and `@volo/seo` (`packages/seo/package.json`: "pure string builders for … JSON-LD"); `packages/ui/src/serialize.ts:113` even comments that it mirrors both.
  - Two markdown linters with byte-identical `position.ts` files: `content-prose/src/position.ts` and `content-lint/src/position.ts`, and neither package is imported by anything in the repo.
  - Recommendation: target shape ~7 packages — core, store, markdown (+mdx), components, search (+embeddings), shared, vite — and fold lint/prose/seo/query/mcp/umbra in or delete them.
- **P2** `packages/content-core` — ~3.4k lines of voice/voice-training/RAG modules (`src/voice.ts` 949 LoC, `src/voice-training.ts` 700 LoC, `src/rag.ts` 357 LoC) in a v1 CMS core. They are real (prompt/JSONL generation, no LLM calls — `ai-config.ts` only validates env keys) but belong behind a subpath export or separate package.
- **P2** — stale @usedocks artifacts: `content-mcp/REVIEW.md` and `content-vite/REVIEW.md` are old self-reviews still referencing `@usedocks/*` names (and the vite one lists issues already fixed in `src/plugin.ts:91-104`); three packages ship with no `description` in package.json (content-lint, content-prose, content-seo). Delete the REVIEW.md files; add descriptions.

## Durability

- **P1** `packages/content-store/src/persist.ts:56-81` — no transaction around the persist loop: a crash mid-`content:build` leaves the table half old, half new content, and `--prune` (`packages/cli/src/run.ts:143`) compounds this. Recommendation: single transaction per persist run.
- **P1** `packages/content-store/src/write.ts` (updateEntry) — doc says "Identity … is held fixed" but only `id`, `collection`, `file` are re-pinned after the merge; `input.data.slug` silently rewrites the `slug` column via `readString(entry, "slug")` (`persist.ts:67`), desyncing the slug index from the load-by-`entry_id` path. Pin `slug` too, or document slug mutability.
- **P2** — build durability in core is good and verified: per-file errors are collected, not thrown (`content-core/src/parser.ts:235-250`), pipeline reports and continues (`pipeline.ts:302`), coded error classes carry context (`types.ts:733-783`; `content-store/src/errors.ts` uses Volo-style `CONTENT_STORE_*` codes); search index cache evicts rejected promises so a transient failure isn't poisoned for 24h (`content-search/src/load-index.ts:254-266`); corrupt stored documents fail loudly (`content-store/src/load.ts:67-74`).
- **P2** — coverage: only `content-store` enforces thresholds (100%, `vitest.config.ts:11-16`); the other 14 are frozen baselines explicitly skipped by the CI gate (`scripts/coverage-gate.ts:27`). Tests that exist are real (e.g., wire-format regression pins in `content-search/test/binary-roundtrip.test.ts:70-139`) but thin in places (content-markdown: 1 test file for the entire dual-renderer). Ratchet per the existing plan; prioritize content-markdown and content-components.

## Observability

- **P1** — the domain is invisible to Volo's observability stack. Logging is bare `console.warn` with a `[docks]` prefix (`content-core/src/pipeline.ts:246-290`, `content-embeddings/src/cache.ts:67-70`); the engine defines a full build-event vocabulary (`content-core/src/events.ts`) but only `generate()` accepts an emitter and nothing wires it to `@volo/observability` (which already ships OTLP tracing). Recommendation: one increment — connect pipeline events + cache stats (`cache/manager.ts:36 getStats()`, `content-embeddings/src/cache.ts:167-172` hit rates) to the framework logger/tracer.
- **P1** `packages/content-search/src/react.tsx:155-181` — query-time semantic search POSTs to `/api/embed`, an endpoint no Volo package provides; on failure `getQueryEmbedding()` returns `null` and the hook silently degrades to keyword-only search with no signal to the developer. Recommendation: ship the embed endpoint as a Volo route or remove the option; at minimum surface `resultSource` degradation as a console warning/metric.
- **P2** — no build metrics in `GenerateResult` beyond duration/entryCount; expose cache hit rates and per-stage timings so `content:build` regressions are visible.

## Top launch-blockers

1. **P0 — `sanitizeHtml` silent no-op on Workers + jsdom packaging defect** (`content-shared/src/sanitize.ts:16-27`). The only P0, and it is conditional: it blocks launch **only if v1 ships content rendering as a supported battery** (the `@volo/mcp` content tools and `volo content:build` CLI already ship it implicitly). The fix is small — dependency move + fail-loud guard — so take it regardless.

Otherwise: **this domain does not gate launch.** The framework-facing seam (`content-store` ← `@volo/mcp`/`@volo/cli`) is the one natively-built, 100%-covered piece and it works. Everything else is a folded-in legacy estate that can harden post-launch.

## Recommended plan items

Pre-v1 (small, ordered):
1. Fix `sanitizeHtml` packaging: `jsdom` → dependencies (or injected), `createRequire`, throw `SecurityError` when no DOM is available instead of returning input (`content-shared/src/sanitize.ts`). Add a Workers-runtime test.
2. Wrap `persistEntries` in a transaction; pin `slug` in `updateEntry` (`content-store/src/persist.ts`, `write.ts`). The store is the launch seam — keep it airtight.
3. Sanitize-by-default in the Svelte helper or delete it; add `rehype-sanitize` to the unified renderer path so both renderers share one schema (`content-components/svelte/HtmlContent.ts`, `content-markdown/src/renderer.ts`).
4. Document the MDX trust boundary ("MDX is code") and its CSP `'unsafe-eval'` cost at `compileMDX`/`MDXContent`.
5. Delete `content-mcp` (its Studio API target doesn't exist; `@volo/mcp` supersedes it) and the stale `REVIEW.md` files. Cheap coherence win before anyone audits the repo.

Deferrable (post-launch):
6. Consolidation wave: fold `content-query` into core's `query.ts`; merge `content-lint`+`content-prose` (dedupe `position.ts`) or park them out of the monorepo; reconcile `content-seo` with `@volo/seo` into one JSON-LD source of truth.
7. Wire pipeline events + cache stats into `@volo/observability`; expose build metrics in `GenerateResult`.
8. Ship or remove the `/api/embed` query-embedding endpoint; surface silent search degradation.
9. Coverage ratchet for the frozen 14, starting with content-markdown and content-components.
10. Move voice/voice-training/RAG out of `content-core` (subpath export or `content-ai` package); switch umbra to `CORE_SCHEMA`; add size guards to fetched search indexes.
