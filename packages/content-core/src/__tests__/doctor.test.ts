import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { doctor } from "../doctor";
import type { RuntimeEntry } from "../types";

describe("doctor", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "docks-doctor-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function createEntry(
    collection: string,
    slug: string,
    content: string,
    directory?: string,
  ): RuntimeEntry {
    const dir = directory ?? path.join(tempDir, "content", collection);
    return {
      slug,
      content,
      id: `${collection}/${slug}`,
      collection: collection,
      file: {
        path: `${slug}.md`,
        fileName: `${slug}.md`,
        extension: ".md",
        directory: dir,
        pathSegments: [],
        isIndex: false,
      },
    };
  }

  describe("link checking", () => {
    it("detects broken internal links", async () => {
      const entries = [
        createEntry("posts", "hello", "Check out [this post](/posts/nonexistent)"),
        createEntry("posts", "world", "Another post"),
      ];

      const result = await doctor(entries, { cwd: tempDir });

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        type: "link",
        severity: "error",
        message: "Broken link: /posts/nonexistent",
      });
    });

    it("ignores external links (http, https)", async () => {
      const entries = [
        createEntry(
          "posts",
          "hello",
          "Check out [Google](https://google.com) and [HTTP](http://example.com)",
        ),
      ];

      const result = await doctor(entries, { cwd: tempDir });

      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("ignores anchor links (#section)", async () => {
      const entries = [createEntry("posts", "hello", "Jump to [section](#my-section)")];

      const result = await doctor(entries, { cwd: tempDir });

      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("ignores mailto links", async () => {
      const entries = [createEntry("posts", "hello", "Email [me](mailto:test@example.com)")];

      const result = await doctor(entries, { cwd: tempDir });

      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("validates valid internal links", async () => {
      const entries = [
        createEntry("posts", "hello", "Check out [this post](/posts/world)"),
        createEntry("posts", "world", "Another post"),
      ];

      const result = await doctor(entries, { cwd: tempDir });

      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("validates cross-collection links", async () => {
      const entries = [
        createEntry("posts", "hello", "See [docs](/docs/guide)"),
        createEntry("docs", "guide", "Guide content"),
      ];

      const result = await doctor(entries, { cwd: tempDir });

      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("handles links with .md extension", async () => {
      const entries = [
        createEntry("posts", "hello", "Check out [this post](/posts/world.md)"),
        createEntry("posts", "world", "Another post"),
      ];

      const result = await doctor(entries, { cwd: tempDir });

      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("detects multiple broken links in one file", async () => {
      const entries = [
        createEntry("posts", "hello", "Links: [one](/posts/missing1) and [two](/posts/missing2)"),
      ];

      const result = await doctor(entries, { cwd: tempDir });

      expect(result.errors).toHaveLength(2);
      expect(result.errors[0]?.message).toContain("/posts/missing1");
      expect(result.errors[1]?.message).toContain("/posts/missing2");
    });
  });

  describe("image checking", () => {
    it("detects missing images", async () => {
      const entries = [createEntry("posts", "hello", "![alt text](/missing.png)")];

      const result = await doctor(entries, { cwd: tempDir });

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        type: "image",
        severity: "error",
        message: "Missing image: /missing.png",
      });
    });

    it("ignores external images", async () => {
      const entries = [
        createEntry(
          "posts",
          "hello",
          "![alt](https://example.com/image.png) ![data](data:image/png;base64,abc)",
        ),
      ];

      const result = await doctor(entries, { cwd: tempDir });

      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("validates existing absolute path images", async () => {
      // Create a public directory with an image
      const publicDir = path.join(tempDir, "public");
      await mkdir(publicDir, { recursive: true });
      await writeFile(path.join(publicDir, "logo.png"), "fake image");

      const entries = [createEntry("posts", "hello", "![Logo](/logo.png)")];

      const result = await doctor(entries, { cwd: tempDir });

      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("validates existing relative path images", async () => {
      // Create content directory with image
      const contentDir = path.join(tempDir, "content", "posts");
      await mkdir(contentDir, { recursive: true });
      await writeFile(path.join(contentDir, "diagram.png"), "fake image");

      const entries = [createEntry("posts", "hello", "![Diagram](./diagram.png)", contentDir)];

      const result = await doctor(entries, { cwd: tempDir });

      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("detects multiple missing images", async () => {
      const entries = [
        createEntry("posts", "hello", "Images: ![one](/missing1.png) and ![two](/missing2.png)"),
      ];

      const result = await doctor(entries, { cwd: tempDir });

      expect(result.errors).toHaveLength(2);
      expect(result.errors[0]?.message).toContain("/missing1.png");
      expect(result.errors[1]?.message).toContain("/missing2.png");
    });
  });

  describe("empty and edge cases", () => {
    it("returns empty results for empty content", async () => {
      const entries = [createEntry("posts", "hello", "")];

      const result = await doctor(entries, { cwd: tempDir });

      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("returns empty results for no entries", async () => {
      const result = await doctor([], { cwd: tempDir });

      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("handles content with no links or images", async () => {
      const entries = [
        createEntry("posts", "hello", "Just some plain text without any links or images."),
      ];

      const result = await doctor(entries, { cwd: tempDir });

      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe("multiple entries", () => {
    it("works with multiple entries across collections", async () => {
      const entries = [
        createEntry("posts", "post1", "Link to [post2](/posts/post2) and ![img](/missing.png)"),
        createEntry("posts", "post2", "Valid post"),
        createEntry("docs", "guide", "Link to [missing](/docs/missing)"),
      ];

      const result = await doctor(entries, { cwd: tempDir });

      expect(result.errors).toHaveLength(2);
      expect(result.errors.some((e) => e.message.includes("/missing.png"))).toBe(true);
      expect(result.errors.some((e) => e.message.includes("/docs/missing"))).toBe(true);
    });
  });

  describe("check options", () => {
    it("respects check options - only links", async () => {
      const entries = [
        createEntry("posts", "hello", "![img](/missing.png) [link](/posts/missing)"),
      ];

      const result = await doctor(entries, { cwd: tempDir }, { checks: ["links"] });

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.type).toBe("link");
    });

    it("respects check options - only images", async () => {
      const entries = [
        createEntry("posts", "hello", "![img](/missing.png) [link](/posts/missing)"),
      ];

      const result = await doctor(entries, { cwd: tempDir }, { checks: ["images"] });

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.type).toBe("image");
    });

    it("respects check options - multiple checks", async () => {
      const entries = [
        createEntry("posts", "hello", "![img](/missing.png) [link](/posts/missing)"),
      ];

      const result = await doctor(entries, { cwd: tempDir }, { checks: ["links", "images"] });

      expect(result.errors).toHaveLength(2);
      expect(result.errors.filter((e) => e.type === "link")).toHaveLength(1);
      expect(result.errors.filter((e) => e.type === "image")).toHaveLength(1);
    });

    it("defaults to all checks when not specified", async () => {
      const entries = [
        createEntry("posts", "hello", "![img](/missing.png) [link](/posts/missing)"),
      ];

      const result = await doctor(entries, { cwd: tempDir });

      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("result structure", () => {
    it("separates errors and warnings", async () => {
      const entries = [createEntry("posts", "hello", "[broken](/posts/missing)")];

      const result = await doctor(entries, { cwd: tempDir });

      expect(result).toHaveProperty("errors");
      expect(result).toHaveProperty("warnings");
      expect(Array.isArray(result.errors)).toBe(true);
      expect(Array.isArray(result.warnings)).toBe(true);
    });

    it("includes file path in issues", async () => {
      const entries = [createEntry("posts", "hello", "[broken](/posts/missing)")];

      const result = await doctor(entries, { cwd: tempDir });

      expect(result.errors[0]?.file).toBeTruthy();
      expect(result.errors[0]?.file).toContain("posts");
      expect(result.errors[0]?.file).toContain("hello.md");
    });
  });
});
