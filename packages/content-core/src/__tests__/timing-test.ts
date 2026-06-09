import { describe, it, expect } from "vitest";
import { z } from "zod";

describe("timing", () => {
  it("just zod", () => {
    const schema = z.object({ title: z.string() });
    expect(schema).toBeDefined();
  });
});
