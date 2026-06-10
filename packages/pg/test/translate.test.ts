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

  it("does not translate a `?` inside a double-quoted identifier", () => {
    expect(translate('SELECT "weird?col" FROM t WHERE a = ?')).toBe(
      'SELECT "weird?col" FROM t WHERE a = $1',
    );
  });

  it("a single quote inside an identifier is an ordinary char (no string toggle)", () => {
    // The `'` inside "o'brien" must NOT open a string; the trailing `?` still binds.
    expect(translate('SELECT "o\'brien" FROM t WHERE a = ?')).toBe(
      'SELECT "o\'brien" FROM t WHERE a = $1',
    );
  });

  it("a double quote inside a string literal is an ordinary char (no identifier toggle)", () => {
    // The `"` inside the string must NOT open an identifier; the `?` in the string
    // stays literal and the one after binds.
    expect(translate("WHERE note = 'say \"hi\" to ?' AND a = ?")).toBe(
      "WHERE note = 'say \"hi\" to ?' AND a = $1",
    );
  });
});
