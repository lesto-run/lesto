import { describe, it, expect } from "vitest";
import { nn } from "./test-utils";
import {
  validateSerializable,
  hasCriticalIssues,
  formatSerializationIssues,
} from "../serialization";

describe("serialization", () => {
  describe("validateSerializable", () => {
    describe("valid serialization", () => {
      it("validates primitive string", () => {
        const result = validateSerializable("hello");
        expect(result.valid).toBe(true);
        expect(result.issues).toHaveLength(0);
      });

      it("validates primitive number", () => {
        const result = validateSerializable(42);
        expect(result.valid).toBe(true);
        expect(result.issues).toHaveLength(0);
      });

      it("validates primitive boolean", () => {
        const result = validateSerializable(true);
        expect(result.valid).toBe(true);
        expect(result.issues).toHaveLength(0);
      });

      it("validates null", () => {
        const result = validateSerializable(null);
        expect(result.valid).toBe(true);
        expect(result.issues).toHaveLength(0);
      });

      it("validates plain object", () => {
        const result = validateSerializable({ name: "test", value: 123 });
        expect(result.valid).toBe(true);
        expect(result.issues).toHaveLength(0);
      });

      it("validates array", () => {
        const result = validateSerializable([1, 2, 3, "test"]);
        expect(result.valid).toBe(true);
        expect(result.issues).toHaveLength(0);
      });

      it("validates nested objects", () => {
        const result = validateSerializable({
          data: {
            nested: {
              field: "value",
            },
          },
        });
        expect(result.valid).toBe(true);
        expect(result.issues).toHaveLength(0);
      });

      it("validates nested arrays", () => {
        const result = validateSerializable([[1, 2], [3, 4], [[5]]]);
        expect(result.valid).toBe(true);
        expect(result.issues).toHaveLength(0);
      });

      it("validates Date objects", () => {
        const result = validateSerializable(new Date());
        expect(result.valid).toBe(true);
        expect(result.issues).toHaveLength(0);
      });

      it("validates empty object", () => {
        const result = validateSerializable({});
        expect(result.valid).toBe(true);
        expect(result.issues).toHaveLength(0);
      });

      it("validates empty array", () => {
        const result = validateSerializable([]);
        expect(result.valid).toBe(true);
        expect(result.issues).toHaveLength(0);
      });

      it("validates objects with toJSON method", () => {
        const obj = {
          value: 123,
          toJSON() {
            return { value: this.value };
          },
        };
        const result = validateSerializable(obj);
        expect(result.valid).toBe(true);
        expect(result.issues).toHaveLength(0);
      });
    });

    describe("invalid serialization", () => {
      it("detects functions with type 'function'", () => {
        const result = validateSerializable({ fn: () => {} });
        expect(result.valid).toBe(false);
        expect(result.issues).toHaveLength(1);
        expect(nn(result.issues[0]).type).toBe("function");
        expect(nn(result.issues[0]).path).toBe("fn");
      });

      it("detects symbols with type 'symbol'", () => {
        const result = validateSerializable({ sym: Symbol("test") });
        expect(result.valid).toBe(false);
        expect(result.issues).toHaveLength(1);
        expect(nn(result.issues[0]).type).toBe("symbol");
        expect(nn(result.issues[0]).path).toBe("sym");
      });

      it("detects bigint with type 'bigint'", () => {
        const result = validateSerializable({ big: 123n });
        expect(result.valid).toBe(false);
        expect(result.issues).toHaveLength(1);
        expect(nn(result.issues[0]).type).toBe("bigint");
        expect(nn(result.issues[0]).path).toBe("big");
      });

      it("detects circular references with type 'circular'", () => {
        const obj: Record<string, unknown> = { name: "test" };
        obj.self = obj;

        const result = validateSerializable(obj);
        expect(result.valid).toBe(false);
        expect(result.issues).toHaveLength(1);
        expect(nn(result.issues[0]).type).toBe("circular");
        expect(nn(result.issues[0]).path).toBe("self");
      });

      it("detects undefined values with type 'undefined'", () => {
        const result = validateSerializable({ value: undefined });
        expect(result.valid).toBe(false);
        expect(result.issues).toHaveLength(1);
        expect(nn(result.issues[0]).type).toBe("undefined");
        expect(nn(result.issues[0]).path).toBe("value");
      });

      it("detects multiple issues", () => {
        const result = validateSerializable({
          fn: () => {},
          sym: Symbol("test"),
          undef: undefined,
        });
        expect(result.valid).toBe(false);
        expect(result.issues).toHaveLength(3);
        expect(result.issues.map((i) => i.type)).toEqual(["function", "symbol", "undefined"]);
      });
    });

    describe("issue paths", () => {
      it("reports root level issues with simple path", () => {
        const result = validateSerializable(() => {});
        expect(nn(result.issues[0]).path).toBe("");
      });

      it("reports nested object issues with full path", () => {
        const result = validateSerializable({
          data: {
            nested: {
              field: () => {},
            },
          },
        });
        expect(nn(result.issues[0]).path).toBe("data.nested.field");
      });

      it("reports array issues with indexed path", () => {
        const result = validateSerializable({
          items: [{ value: 1 }, { value: 2 }, { fn: () => {} }],
        });
        expect(nn(result.issues[0]).path).toBe("items[2].fn");
      });

      it("reports nested array issues with complex path", () => {
        const result = validateSerializable({
          matrix: [
            [1, 2],
            [3, () => {}],
          ],
        });
        expect(nn(result.issues[0]).path).toBe("matrix[1][1]");
      });

      it("reports mixed object and array path", () => {
        const result = validateSerializable({
          data: {
            items: [{ nested: { fn: () => {} } }],
          },
        });
        expect(nn(result.issues[0]).path).toBe("data.items[0].nested.fn");
      });
    });
  });

  describe("hasCriticalIssues", () => {
    it("returns false for undefined-only issues", () => {
      const result = validateSerializable({ value: undefined });
      expect(hasCriticalIssues(result)).toBe(false);
    });

    it("returns false for multiple undefined issues", () => {
      const result = validateSerializable({
        a: undefined,
        b: undefined,
        c: undefined,
      });
      expect(hasCriticalIssues(result)).toBe(false);
    });

    it("returns true for function issues", () => {
      const result = validateSerializable({ fn: () => {} });
      expect(hasCriticalIssues(result)).toBe(true);
    });

    it("returns true for symbol issues", () => {
      const result = validateSerializable({ sym: Symbol("test") });
      expect(hasCriticalIssues(result)).toBe(true);
    });

    it("returns true for bigint issues", () => {
      const result = validateSerializable({ big: 123n });
      expect(hasCriticalIssues(result)).toBe(true);
    });

    it("returns true for circular reference issues", () => {
      const obj: Record<string, unknown> = {};
      obj.self = obj;
      const result = validateSerializable(obj);
      expect(hasCriticalIssues(result)).toBe(true);
    });

    it("returns true when critical and undefined issues are mixed", () => {
      const result = validateSerializable({
        fn: () => {},
        undef: undefined,
      });
      expect(hasCriticalIssues(result)).toBe(true);
    });

    it("returns false for valid result with no issues", () => {
      const result = validateSerializable({ value: 123 });
      expect(hasCriticalIssues(result)).toBe(false);
    });
  });

  describe("formatSerializationIssues", () => {
    it("formats single issue as bullet list", () => {
      const result = validateSerializable({ fn: () => {} });
      const formatted = formatSerializationIssues(result.issues);
      expect(formatted).toBe('  - Function at "fn" is not serializable');
    });

    it("formats multiple issues as bullet list", () => {
      const result = validateSerializable({
        fn: () => {},
        sym: Symbol("test"),
      });
      const formatted = formatSerializationIssues(result.issues);
      expect(formatted).toContain('  - Function at "fn" is not serializable');
      expect(formatted).toContain('  - Symbol at "sym" is not serializable');
      expect(formatted.split("\n")).toHaveLength(2);
    });

    it("formats empty issues as empty string", () => {
      const formatted = formatSerializationIssues([]);
      expect(formatted).toBe("");
    });

    it("includes full path in formatted message", () => {
      const result = validateSerializable({
        data: { nested: { fn: () => {} } },
      });
      const formatted = formatSerializationIssues(result.issues);
      expect(formatted).toContain('Function at "data.nested.fn"');
    });

    it("formats bigint message with conversion hint", () => {
      const result = validateSerializable({ big: 123n });
      const formatted = formatSerializationIssues(result.issues);
      expect(formatted).toContain("Convert to string or number first");
    });

    it("formats undefined message with omission note", () => {
      const result = validateSerializable({ value: undefined });
      const formatted = formatSerializationIssues(result.issues);
      expect(formatted).toContain("will be omitted during serialization");
    });

    it("formats circular reference message", () => {
      const obj: Record<string, unknown> = {};
      obj.self = obj;
      const result = validateSerializable(obj);
      const formatted = formatSerializationIssues(result.issues);
      expect(formatted).toContain("Circular reference detected");
    });
  });
});
