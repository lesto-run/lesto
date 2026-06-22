import { describe, expect, it } from "vitest";

import {
  CONTENT_PACKAGES_HINT,
  missingContentError,
  rethrowUnlessMissingContentPeer,
} from "../src/content-peer";
import { McpError } from "../src/errors";

/** A Node `ERR_MODULE_NOT_FOUND` error with a given message — the import-failure shape. */
function moduleNotFound(message: string): Error {
  const error = new Error(message);
  (error as Error & { code?: string }).code = "ERR_MODULE_NOT_FOUND";

  return error;
}

describe("missingContentError", () => {
  it("is a coded McpError carrying the shared install hint", () => {
    const error = missingContentError();

    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe("MCP_CONTENT_PACKAGES_MISSING");
    expect(error.message).toBe(CONTENT_PACKAGES_HINT);
    expect(CONTENT_PACKAGES_HINT).toContain("npm i @lesto/content-core @lesto/content-store");
  });
});

describe("rethrowUnlessMissingContentPeer", () => {
  it("converts a missing @lesto/content-* peer into the coded refusal", () => {
    const cause = moduleNotFound(
      "Cannot find package '@lesto/content-core' imported from /app/x.ts",
    );

    expect(() => rethrowUnlessMissingContentPeer(cause)).toThrow(McpError);

    try {
      rethrowUnlessMissingContentPeer(cause);
    } catch (error) {
      expect((error as McpError).code).toBe("MCP_CONTENT_PACKAGES_MISSING");
    }
  });

  it("also matches the `Cannot find module` phrasing", () => {
    const cause = moduleNotFound("Cannot find module '@lesto/content-store'");

    expect(() => rethrowUnlessMissingContentPeer(cause)).toThrow(
      expect.objectContaining({ code: "MCP_CONTENT_PACKAGES_MISSING" }),
    );
  });

  it("rethrows untouched when a NON-content package is missing (a real broken dep)", () => {
    // A genuine failure inside an installed content package — its own undeclared
    // transitive dep — must NOT be masked as "go install the content packages".
    const cause = moduleNotFound("Cannot find package 'some-transitive-dep' imported from /x");

    expect(() => rethrowUnlessMissingContentPeer(cause)).toThrow(cause);
  });

  it("rethrows when the message names no quoted module (regex misses)", () => {
    const cause = moduleNotFound("ERR_MODULE_NOT_FOUND with no parseable specifier");

    expect(() => rethrowUnlessMissingContentPeer(cause)).toThrow(cause);
  });

  it("rethrows an Error whose code is not ERR_MODULE_NOT_FOUND", () => {
    const cause = new Error("Cannot find package '@lesto/content-core'");
    (cause as Error & { code?: string }).code = "ERR_SOMETHING_ELSE";

    expect(() => rethrowUnlessMissingContentPeer(cause)).toThrow(cause);
  });

  it("rethrows a plain Error with no code property", () => {
    const cause = new Error("boom");

    expect(() => rethrowUnlessMissingContentPeer(cause)).toThrow(cause);
  });

  it("rethrows a non-Error rejection verbatim", () => {
    expect(() => rethrowUnlessMissingContentPeer("nope")).toThrow();

    try {
      rethrowUnlessMissingContentPeer("nope");
    } catch (error) {
      expect(error).toBe("nope");
    }
  });
});
