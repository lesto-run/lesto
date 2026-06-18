import { defineConfig } from "vitest/config";

// Coverage is enforced via thresholds. Volo's bar is 100%; this package reaches
// 100% functions and ~98.6% statements/lines. The remaining gap is a small set
// of genuinely defensive / structurally-unreachable branches that we will not
// game with istanbul-ignore:
//
//   - client.ts 109 (AbortSignal.any compose — no public path sets options.signal),
//     291/342-344 (SSE buffer.pop()??"" and trailing-[DONE] sub-branches).
//   - http.ts 923-929 (createMcpHttpServer CallTool catch — every handler catches
//     its own client errors and returns a string, so handleToolCall never throws;
//     the StudioNotRunningError/instanceof-Error split is dead defensive code).
//     Plus validateToolArgs' properties??{} and Array.isArray(type) branches,
//     unreachable with the tools this server advertises.
//   - server.ts 387/438 (resolved-path-prefix guard — defense in depth; the slug
//     guard already rejects traversal and update paths come from the engine) and
//     593 (CallTool generic catch — handlers never throw a non-ValidationError).
//
// Thresholds are pinned to the current numbers so coverage can only ratchet up.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/__tests__/**"],
      thresholds: {
        statements: 98,
        branches: 90,
        functions: 100,
        lines: 98,
      },
    },
  },
});
