import { describe, it, expect } from "vitest";
import {
  createImport,
  createNamedImport,
  isImportReference,
  IMPORT_MARKER,
  ImportCollector,
} from "../imports";

describe("imports", () => {
  describe("Import Reference Creation", () => {
    it("createImport() creates reference with IMPORT_MARKER", () => {
      const ref = createImport("react");

      expect(ref[IMPORT_MARKER]).toBe(true);
    });

    it("createImport() sets path, name is undefined", () => {
      const ref = createImport("react");

      expect(ref.path).toBe("react");
      expect(ref.name).toBeUndefined();
    });

    it("createNamedImport() sets both name and path", () => {
      const ref = createNamedImport("useState", "react");

      expect(ref[IMPORT_MARKER]).toBe(true);
      expect(ref.path).toBe("react");
      expect(ref.name).toBe("useState");
    });
  });

  describe("Import Detection", () => {
    it("isImportReference() returns true for default import ref", () => {
      const ref = createImport("react");

      expect(isImportReference(ref)).toBe(true);
    });

    it("isImportReference() returns true for named import ref", () => {
      const ref = createNamedImport("useState", "react");

      expect(isImportReference(ref)).toBe(true);
    });

    it("isImportReference() returns false for plain object", () => {
      const obj = { path: "react", name: "useState" };

      expect(isImportReference(obj)).toBe(false);
    });

    it("isImportReference() returns false for null/undefined", () => {
      expect(isImportReference(null)).toBe(false);
      expect(isImportReference(undefined)).toBe(false);
    });

    it("isImportReference() returns false for primitives", () => {
      expect(isImportReference("react")).toBe(false);
      expect(isImportReference(42)).toBe(false);
      expect(isImportReference(true)).toBe(false);
    });
  });

  describe("Import Collector", () => {
    it("getVarName() returns unique variable names (__v_0, __v_1, etc)", () => {
      const collector = new ImportCollector();

      const var1 = collector.getVarName(createImport("react"));
      const var2 = collector.getVarName(createImport("vue"));

      expect(var1).toBe("__v_0");
      expect(var2).toBe("__v_1");
    });

    it("getVarName() reuses same var for same import", () => {
      const collector = new ImportCollector();

      const var1 = collector.getVarName(createImport("react"));
      const var2 = collector.getVarName(createImport("react"));

      expect(var1).toBe("__v_0");
      expect(var2).toBe("__v_0");
      expect(collector.getImports()).toHaveLength(1);
    });

    it("getVarName() differentiates default vs named from same path", () => {
      const collector = new ImportCollector();

      const defaultVar = collector.getVarName(createImport("react"));
      const namedVar = collector.getVarName(createNamedImport("useState", "react"));

      expect(defaultVar).toBe("__v_0");
      expect(namedVar).toBe("__v_1");
      expect(collector.getImports()).toHaveLength(2);
    });

    it("getImports() returns all collected imports", () => {
      const collector = new ImportCollector();

      collector.getVarName(createImport("react"));
      collector.getVarName(createNamedImport("useState", "react"));

      const imports = collector.getImports();

      expect(imports).toHaveLength(2);
      expect(imports[0]).toEqual({
        varName: "__v_0",
        path: "react",
        name: undefined,
      });
      expect(imports[1]).toEqual({
        varName: "__v_1",
        path: "react",
        name: "useState",
      });
    });

    it("hasImports() returns false when empty, true otherwise", () => {
      const collector = new ImportCollector();

      expect(collector.hasImports()).toBe(false);

      collector.getVarName(createImport("react"));

      expect(collector.hasImports()).toBe(true);
    });

    it("generateImportStatements() generates correct default import syntax", () => {
      const collector = new ImportCollector();

      collector.getVarName(createImport("react"));

      const statements = collector.generateImportStatements();

      expect(statements).toBe('import __v_0 from "react";');
    });

    it("generateImportStatements() generates correct named import syntax", () => {
      const collector = new ImportCollector();

      collector.getVarName(createNamedImport("useState", "react"));

      const statements = collector.generateImportStatements();

      expect(statements).toBe('import { useState as __v_0 } from "react";');
    });

    it("generateImportStatements() handles multiple imports", () => {
      const collector = new ImportCollector();

      collector.getVarName(createImport("react"));
      collector.getVarName(createNamedImport("useState", "react"));
      collector.getVarName(createImport("vue"));

      const statements = collector.generateImportStatements();

      expect(statements).toContain('import __v_0 from "react";');
      expect(statements).toContain('import { useState as __v_1 } from "react";');
      expect(statements).toContain('import __v_2 from "vue";');
      expect(statements.split("\n")).toHaveLength(3);
    });
  });
});
