/**
 * The optional content-peer boundary — the ONE place that decides "the content
 * packages aren't here" and turns it into a coded refusal.
 *
 * `@lesto/content-core` / `@lesto/content-store` are OPTIONAL PEERS of `@lesto/mcp`
 * (so a default install never pulls them, ADR/publish-day step 5). The content tools
 * reach them two ways, and BOTH funnel through here so the message and the
 * classification live once, tested:
 *   - the seam was never wired (`context.loadContent` absent) → {@link missingContentError};
 *   - the seam ran the real dynamic import and it failed because the peer is absent →
 *     {@link rethrowUnlessMissingContentPeer} (the real `import()` itself stays in the
 *     coverage-excluded `server.ts`; the CLASSIFICATION is here, covered).
 */

import { McpError } from "./errors";

/** The one human-facing hint for an absent content peer — shared so it can't drift. */
export const CONTENT_PACKAGES_HINT =
  "The content tools need the content packages — run `npm i @lesto/content-core @lesto/content-store`.";

/** The coded refusal both absent-peer paths raise. */
export function missingContentError(): McpError {
  return new McpError("MCP_CONTENT_PACKAGES_MISSING", CONTENT_PACKAGES_HINT);
}

/**
 * Convert a missing optional content PEER into the coded refusal, and rethrow any
 * other error untouched — a real failure INSIDE an installed content package (its own
 * undeclared transitive dep, a syntax error) must NOT be masked as "go install it".
 *
 * Node's `ERR_MODULE_NOT_FOUND` names the missing specifier in its message
 * (`Cannot find package '<x>'`), so we classify on the EXTRACTED specifier — only a
 * missing `@lesto/content-*` is the absent-peer case. Mirrors `@lesto/cli`'s loader.
 */
export function rethrowUnlessMissingContentPeer(error: unknown): never {
  if (error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
    const missing = /Cannot find (?:package|module) '([^']+)'/.exec(error.message)?.[1];

    if (missing?.startsWith("@lesto/content-")) {
      throw missingContentError();
    }
  }

  throw error;
}
