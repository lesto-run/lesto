import { describe, it, expect } from "vitest";
import {
  sanitizePathSegment,
  validatePathWithinBase,
  PathTraversalError,
  getVoiceSamplesPath,
  getVoiceCachePath,
} from "../voice";
import path from "node:path";

describe("Path Security", () => {
  describe("sanitizePathSegment", () => {
    it("allows valid path segments", () => {
      expect(sanitizePathSegment("valid-name")).toBe("valid-name");
      expect(sanitizePathSegment("collection_name")).toBe("collection_name");
      expect(sanitizePathSegment("author123")).toBe("author123");
      expect(sanitizePathSegment("John Smith")).toBe("John Smith");
    });

    it("sanitizes path traversal attempts with ../", () => {
      // Dangerous characters are stripped, making the path safe
      expect(sanitizePathSegment("../../../etc/passwd")).toBe("etcpasswd");
      // Pure traversal becomes invalid
      expect(() => sanitizePathSegment("..")).toThrow(PathTraversalError);
      expect(() => sanitizePathSegment("...")).toThrow(PathTraversalError);
    });

    it("sanitizes Windows-style path traversal", () => {
      expect(sanitizePathSegment("..\\..\\windows\\system32")).toBe("windowssystem32");
    });

    it("sanitizes mixed traversal attempts", () => {
      const result = sanitizePathSegment("valid/../../../etc/passwd");
      expect(result).not.toContain("..");
      expect(result).not.toContain("/");
      expect(result).toBe("validetcpasswd");
    });

    it("sanitizes null byte injection", () => {
      // Null bytes are stripped
      expect(sanitizePathSegment("\0malicious")).toBe("malicious");
      expect(sanitizePathSegment("normal\0text")).toBe("normaltext");
    });

    it("sanitizes absolute paths", () => {
      // Forward slashes are stripped
      expect(sanitizePathSegment("/absolute/path")).toBe("absolutepath");
    });

    it("sanitizes Windows drive paths", () => {
      // Colons and backslashes are stripped
      expect(sanitizePathSegment("C:\\Windows")).toBe("CWindows");
    });

    it("rejects empty strings", () => {
      expect(() => sanitizePathSegment("")).toThrow(PathTraversalError);
    });

    it("rejects strings that become empty after sanitization", () => {
      expect(() => sanitizePathSegment("../")).toThrow(PathTraversalError);
      expect(() => sanitizePathSegment("...")).toThrow(PathTraversalError);
      expect(() => sanitizePathSegment("/")).toThrow(PathTraversalError);
      expect(() => sanitizePathSegment("\\")).toThrow(PathTraversalError);
    });

    it("rejects strings that become only underscores", () => {
      expect(() => sanitizePathSegment("___")).toThrow(PathTraversalError);
    });

    it("removes leading dots", () => {
      expect(sanitizePathSegment(".hidden")).toBe("hidden");
      expect(sanitizePathSegment("..hidden")).toBe("hidden");
    });

    it("preserves valid characters after sanitization", () => {
      expect(sanitizePathSegment("my-collection")).toBe("my-collection");
      expect(sanitizePathSegment("post_123")).toBe("post_123");
      expect(sanitizePathSegment("Jane Doe")).toBe("Jane Doe");
    });
  });

  describe("validatePathWithinBase", () => {
    const baseDir = "/project/.docks/voice-samples";

    it("allows paths within base directory", () => {
      expect(() =>
        validatePathWithinBase(
          path.join(baseDir, "collection", "author.json"),
          baseDir
        )
      ).not.toThrow();
    });

    it("rejects paths that escape base directory", () => {
      expect(() =>
        validatePathWithinBase("/project/.docks/other/file.json", baseDir)
      ).toThrow(PathTraversalError);
    });

    it("rejects paths to parent directories", () => {
      expect(() =>
        validatePathWithinBase("/project/.docks", baseDir)
      ).toThrow(PathTraversalError);
    });

    it("handles normalized path attacks", () => {
      // Even if someone crafts a path that would normalize outside
      expect(() =>
        validatePathWithinBase(
          path.normalize("/project/.docks/voice-samples/../../../etc/passwd"),
          baseDir
        )
      ).toThrow(PathTraversalError);
    });

    it("prevents prefix matching attacks", () => {
      // /project/.docks/voice-samples-evil should not match /project/.docks/voice-samples
      expect(() =>
        validatePathWithinBase(
          "/project/.docks/voice-samples-evil/file.json",
          baseDir
        )
      ).toThrow(PathTraversalError);
    });
  });

  describe("getVoiceSamplesPath - security integration", () => {
    const cwd = "/project";

    it("returns safe paths for valid inputs", () => {
      const result = getVoiceSamplesPath(cwd, "posts", "john");
      expect(result).toContain(".docks/voice-samples");
      expect(result).toContain("posts");
      expect(result).toContain("john.json");
    });

    it("sanitizes path traversal in collection", () => {
      // Traversal characters are stripped, making path safe
      const result = getVoiceSamplesPath(cwd, "../../../etc/passwd");
      expect(result).toContain("etcpasswd");
      expect(result).not.toContain("..");
      // Result is safely within the base directory
      expect(result).toContain(".docks/voice-samples");
    });

    it("sanitizes path traversal in author", () => {
      const result = getVoiceSamplesPath(cwd, "posts", "../../../etc/passwd");
      expect(result).toContain("etcpasswd.json");
      expect(result).not.toContain("..");
      expect(result).toContain(".docks/voice-samples");
    });

    it("sanitizes Windows path traversal", () => {
      const result = getVoiceSamplesPath(cwd, "..\\..\\windows\\system32");
      expect(result).toContain("windowssystem32");
      expect(result).not.toContain("\\");
    });

    it("sanitizes null byte injection", () => {
      const result = getVoiceSamplesPath(cwd, "\0malicious");
      expect(result).toContain("malicious");
      expect(result).not.toContain("\0");
    });

    it("sanitizes absolute paths in collection", () => {
      const result = getVoiceSamplesPath(cwd, "/absolute/path");
      expect(result).not.toContain("//");
      expect(result).toContain(".docks/voice-samples");
    });

    it("returns collection file when no author specified", () => {
      const result = getVoiceSamplesPath(cwd, "posts");
      expect(result).toContain("_collection.json");
    });
  });

  describe("getVoiceCachePath - security integration", () => {
    const cwd = "/project";

    it("returns safe paths for valid inputs", () => {
      const result = getVoiceCachePath(cwd, "posts", "john");
      expect(result).toContain(".docks/voice-cache");
      expect(result).toContain("posts");
      expect(result).toContain("john.json");
    });

    it("sanitizes path traversal in collection", () => {
      const result = getVoiceCachePath(cwd, "../../../etc/passwd");
      expect(result).toContain("etcpasswd");
      expect(result).not.toContain("..");
      expect(result).toContain(".docks/voice-cache");
    });

    it("sanitizes path traversal in author", () => {
      const result = getVoiceCachePath(cwd, "posts", "../../../etc/passwd");
      expect(result).toContain("etcpasswd.json");
      expect(result).not.toContain("..");
    });
  });

  describe("Attack vector coverage", () => {
    // Comprehensive attack vectors from the bead requirements
    const attacks = [
      { input: "../../../etc/passwd", name: "Unix traversal", safe: "etcpasswd" },
      { input: "..\\..\\windows\\system32", name: "Windows traversal", safe: "windowssystem32" },
      { input: "valid/../../../etc/passwd", name: "Mixed traversal", safe: "validetcpasswd" },
      { input: "\0malicious", name: "Null byte", safe: "malicious" },
      { input: "/absolute/path", name: "Absolute path", safe: "absolutepath" },
      { input: "C:\\Windows", name: "Windows drive", safe: "CWindows" },
    ];

    for (const { input, name, safe } of attacks) {
      it(`sanitizes ${name}: "${input}" -> "${safe}"`, () => {
        const result = sanitizePathSegment(input);
        // Verify the result is the expected safe value
        expect(result).toBe(safe);
        // Verify no dangerous characters remain
        expect(result).not.toContain("..");
        expect(result).not.toContain("/");
        expect(result).not.toContain("\\");
        expect(result).not.toContain(":");
        expect(result).not.toContain("\0");
      });
    }
  });

  describe("Defense in depth - validatePathWithinBase", () => {
    it("catches any edge cases that escape sanitization", () => {
      const baseDir = "/project/.docks/voice-samples";

      // Even if sanitization somehow fails, validatePathWithinBase catches it
      expect(() =>
        validatePathWithinBase("/etc/passwd", baseDir)
      ).toThrow(PathTraversalError);

      expect(() =>
        validatePathWithinBase("/project/other/file", baseDir)
      ).toThrow(PathTraversalError);
    });
  });
});
