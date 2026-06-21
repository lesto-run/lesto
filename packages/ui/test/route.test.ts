import { describe, expect, it } from "vitest";

import { UiError } from "../src/errors";
import { route } from "../src/route";

describe("route", () => {
  it("substitutes a typed :param into the pattern, URL-encoding the value", () => {
    expect(route("/lab/gallery/:id", { id: "bel-air" })).toBe("/lab/gallery/bel-air");
    expect(route("/files/:name", { name: "a b/c" })).toBe("/files/a%20b%2Fc");
  });

  it("substitutes every :param of a multi-segment pattern", () => {
    expect(route("/shop/:category/:id", { category: "homes", id: "7" })).toBe("/shop/homes/7");
  });

  it("returns a param-less pattern verbatim (no second argument)", () => {
    expect(route("/lab/gallery")).toBe("/lab/gallery");
  });

  it("throws a coded UiError when a param is missing at runtime (an untyped caller)", () => {
    // The types require the params, but a JS caller can omit them — fail loud rather
    // than substitute `undefined` into the URL.
    let error: unknown;

    try {
      (route as (pattern: string) => string)("/blog/:slug");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(UiError);
    expect((error as UiError).code).toBe("UI_ROUTE_MISSING_PARAM");
  });
});
