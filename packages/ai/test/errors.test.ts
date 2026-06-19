import { describe, expect, it } from "vitest";

import { LestoError } from "@lesto/errors";

import { AiError } from "../src/errors";

describe("AiError", () => {
  it("is a LestoError carrying a code, message, and frozen details", () => {
    const error = new AiError("AI_HTTP_ERROR", "boom", { status: 500 });

    expect(error).toBeInstanceOf(LestoError);
    expect(error.name).toBe("AiError");
    expect(error.code).toBe("AI_HTTP_ERROR");
    expect(error.message).toBe("boom");
    expect(error.details).toEqual({ status: 500 });
    expect(Object.isFrozen(error.details)).toBe(true);
  });

  it("defaults details to an empty bag", () => {
    expect(new AiError("AI_STREAM_MALFORMED", "x").details).toEqual({});
  });
});
