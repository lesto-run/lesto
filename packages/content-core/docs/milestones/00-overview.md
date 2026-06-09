# Docks Core Refactor: Milestone Overview

## Goal
Restructure `@usedocks/core` to implement strongly-typed content collections following content-collections patterns with a clean pipeline architecture.

## Key Architectural Changes
1. **Pipeline Architecture**: Config → Collect → Parse → Transform → Write
2. **Schema-Based Types**: Extract types from Zod schemas, not runtime data
3. **Explicit Collections**: Each collection defines `name`, `directory`, `include`, `exclude`
4. **Rich Transform Context**: `documents()`, `cache()`, `skip()` utilities
5. **Single Import Source**: Everything from `@usedocks/core`

## Milestones

| # | Milestone | Deliverable | Files |
|---|-----------|-------------|-------|
| 1 | [Core Types & Context](./01-types-and-context.md) | New type system + TransformContext | 2 files |
| 2 | [Pipeline: Config & Collect](./02-config-and-collect.md) | Stage 1-2 with tests | 2 files |
| 3 | [Pipeline: Parse](./03-parse.md) | Stage 3 with validation | 1 file |
| 4 | [Pipeline: Transform](./04-transform.md) | Stage 4 with concurrency | 1 file |
| 5 | [Type Generation](./05-typegen.md) | Schema-based type extraction | 1 file |
| 6 | [Writer & Pipeline](./06-writer-and-pipeline.md) | Stage 5 + orchestrator | 2 files |
| 7 | [Synchronizer](./07-synchronizer.md) | Incremental watch updates | 1 file |
| 8 | [Engine & Runtime](./08-engine-and-runtime.md) | Engine rewrite + API | 2 files |
| 9 | [Next.js Integration](./09-nextjs-integration.md) | Plugin update | 2 files |
| 10 | [Templates & Cleanup](./10-templates-and-cleanup.md) | Template + delete old files | 4 files |
| 11 | [Vite Integration](./11-vite-integration.md) | Vite plugin + templates | 6+ files |

## Definition of Done (Each Milestone)
- [ ] Code compiles without errors
- [ ] All tests pass
- [ ] No regressions in existing functionality (until milestone 10)
- [ ] Code reviewed and documented

## Dependencies

```
M1 (Types) ──┬── M2 (Config/Collect) ──┬── M3 (Parse) ── M4 (Transform) ── M5 (Typegen)
             │                         │                                        │
             │                         └────────────────────────────────────────┘
             │                                              │
             └── M6 (Writer/Pipeline) ◄────────────────────┘
                        │
                        ├── M7 (Synchronizer)
                        │
                        └── M8 (Engine/Runtime) ── M9 (Next.js) ── M10 (Cleanup) ── M11 (Vite)
```

## Timeline Estimate
Each milestone is designed to be completable independently. Start with Milestone 1 and proceed sequentially.
