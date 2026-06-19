# Bun native-test discovery root (intentionally empty)

Lesto's tests run under **vitest** (`bun run test` / `bun run ws:test`), not Bun's
native `bun test` runner. The root [`bunfig.toml`](../../bunfig.toml) points Bun's
test discovery at this empty directory so a bare `bun test` finds nothing and exits
0 — instead of auto-discovering the vitest `*.test.ts` suites and running them under
Bun's runtime, where vitest-only APIs (e.g. `vi.stubGlobal`) are absent and produce
confusing false failures.

To run the real test suite: `bun run test` (one package) or `bun run ws:test` (all).
