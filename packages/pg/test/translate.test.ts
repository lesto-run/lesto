import { describe, expect, it } from "vitest";

import { translate } from "../src/translate";

describe("translate (? -> $n)", () => {
  it("numbers each placeholder left to right", () => {
    expect(translate("SELECT * FROM t WHERE a = ? AND b = ?")).toBe(
      "SELECT * FROM t WHERE a = $1 AND b = $2",
    );
  });

  it("leaves SQL with no placeholders unchanged", () => {
    expect(translate("SELECT COUNT(*) FROM t")).toBe("SELECT COUNT(*) FROM t");
  });

  it("does not translate a `?` inside a single-quoted string literal", () => {
    expect(translate("SELECT * FROM t WHERE label = '?' AND a = ?")).toBe(
      "SELECT * FROM t WHERE label = '?' AND a = $1",
    );
  });

  it("treats an escaped quote ('') as a pair of toggles, preserving state", () => {
    // The `?` after the closed string is still translated.
    expect(translate("WHERE name = 'o''connor' AND id = ?")).toBe(
      "WHERE name = 'o''connor' AND id = $1",
    );
  });
});
