/**
 * `validateBody` — the request-boundary validation helper (ADR 0005).
 *
 * Two paths: a body that satisfies the schema returns the parsed, typed value;
 * a body that does not throws `WEB_VALIDATION_FAILED` (mapped to 422 by the
 * shared error boundary) carrying the Zod issues for any caller that wants them.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { WebError } from "../src/errors";
import type { KeelRequest } from "../src/types";
import { validateBody } from "../src/validate";

const NewPost = z.object({
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
});

/** A minimal request carrying just the body the helper reads. */
function requestWithBody(body: unknown): KeelRequest {
  return { method: "POST", path: "/posts", params: {}, query: {}, headers: {}, body };
}

describe("validateBody", () => {
  it("returns the parsed, typed value when the body satisfies the schema", () => {
    const input = validateBody(NewPost, requestWithBody({ title: "Hi", body: "There" }));

    expect(input).toEqual({ title: "Hi", body: "There" });
  });

  it("applies the schema's transforms (trim) to the returned value", () => {
    const input = validateBody(NewPost, requestWithBody({ title: "  Hi  ", body: "  yo  " }));

    expect(input).toEqual({ title: "Hi", body: "yo" });
  });

  it("throws WEB_VALIDATION_FAILED, carrying the Zod issues, on a bad body", () => {
    let thrown: unknown;

    try {
      validateBody(NewPost, requestWithBody({ title: 1234 }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WebError);

    const error = thrown as WebError;

    expect(error.code).toBe("WEB_VALIDATION_FAILED");

    const issues = error.details?.["issues"] as ReadonlyArray<{ path: readonly unknown[] }>;

    // Both fields are wrong: title has the wrong type, body is missing.
    expect(issues.length).toBeGreaterThanOrEqual(2);
    expect(issues.some((issue) => issue.path.includes("title"))).toBe(true);
    expect(issues.some((issue) => issue.path.includes("body"))).toBe(true);
  });
});
