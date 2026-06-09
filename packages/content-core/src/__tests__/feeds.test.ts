import { describe, it, expect } from "vitest";
import { generateRss, generateSitemap, type FeedEntry } from "../feeds";
import type { RuntimeEntry } from "../types";

const createEntry = (
  slug: string,
  collection: string,
  data: Record<string, unknown> = {},
): RuntimeEntry & FeedEntry => ({
  ...data,
  slug,
  content: "",
  id: `${collection}/${slug}`,
  collection: collection,
  file: {
    path: `${slug}.md`,
    fileName: slug,
    extension: "md",
    directory: ".",
    pathSegments: [slug],
    isIndex: false,
  },
});

describe("feeds", () => {
  describe("generateRss", () => {
    it("generates valid RSS 2.0 XML", () => {
      const entries = [
        createEntry("post-1", "posts", {
          title: "First Post",
          publishedAt: new Date("2024-01-01"),
          description: "Description of first post",
        }),
        createEntry("post-2", "posts", {
          title: "Second Post",
          publishedAt: new Date("2024-01-02"),
          description: "Description of second post",
        }),
      ];

      const rss = generateRss(entries, {
        title: "My Blog",
        description: "A great blog",
        siteUrl: "https://example.com",
      });

      expect(rss).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(rss).toContain('<rss version="2.0">');
      expect(rss).toContain("<channel>");
      expect(rss).toContain("<title>My Blog</title>");
      expect(rss).toContain("<link>https://example.com</link>");
      expect(rss).toContain("<description>A great blog</description>");
      expect(rss).toContain("</channel>");
      expect(rss).toContain("</rss>");
    });

    it("includes items with correct structure", () => {
      const entries = [
        createEntry("hello", "posts", {
          title: "Hello World",
          publishedAt: new Date("2024-01-15"),
          description: "My first post",
        }),
      ];

      const rss = generateRss(entries, {
        title: "Blog",
        description: "Blog description",
        siteUrl: "https://example.com",
      });

      expect(rss).toContain("<item>");
      expect(rss).toContain("<title>Hello World</title>");
      expect(rss).toContain("<link>https://example.com/posts/hello</link>");
      expect(rss).toContain("<guid>https://example.com/posts/hello</guid>");
      expect(rss).toContain("<pubDate>");
      expect(rss).toContain("<description>My first post</description>");
      expect(rss).toContain("</item>");
    });

    it("sorts by date descending", () => {
      const entries = [
        createEntry("oldest", "posts", {
          title: "Oldest",
          publishedAt: new Date("2024-01-01"),
        }),
        createEntry("newest", "posts", {
          title: "Newest",
          publishedAt: new Date("2024-01-31"),
        }),
        createEntry("middle", "posts", {
          title: "Middle",
          publishedAt: new Date("2024-01-15"),
        }),
      ];

      const rss = generateRss(entries, {
        title: "Blog",
        description: "Blog description",
        siteUrl: "https://example.com",
      });

      const newestIndex = rss.indexOf("<title>Newest</title>");
      const middleIndex = rss.indexOf("<title>Middle</title>");
      const oldestIndex = rss.indexOf("<title>Oldest</title>");

      expect(newestIndex).toBeLessThan(middleIndex);
      expect(middleIndex).toBeLessThan(oldestIndex);
    });

    it("limits to 20 most recent entries", () => {
      const entries = Array.from({ length: 30 }, (_, i) =>
        createEntry(`post-${i}`, "posts", {
          title: `Post ${i}`,
          publishedAt: new Date(`2024-01-${String(i + 1).padStart(2, "0")}`),
        }),
      );

      const rss = generateRss(entries, {
        title: "Blog",
        description: "Blog description",
        siteUrl: "https://example.com",
      });

      const itemCount = (rss.match(/<item>/g) || []).length;
      expect(itemCount).toBe(20);
    });

    it("escapes XML special characters", () => {
      const entries = [
        createEntry("test", "posts", {
          title: "Test & <Special> Characters",
          publishedAt: new Date("2024-01-01"),
          description: "Description with & < > chars",
        }),
      ];

      const rss = generateRss(entries, {
        title: "Blog & More",
        description: "A blog with <special> & characters",
        siteUrl: "https://example.com",
      });

      expect(rss).toContain("Test &amp; &lt;Special&gt; Characters");
      expect(rss).toContain("Description with &amp; &lt; &gt; chars");
      expect(rss).toContain("Blog &amp; More");
      expect(rss).toContain("A blog with &lt;special&gt; &amp; characters");
    });

    it("uses custom field names", () => {
      const entries = [
        createEntry("test", "posts", {
          name: "Custom Title",
          createdAt: new Date("2024-01-01"),
          summary: "Custom description",
        }),
      ];

      const rss = generateRss(entries, {
        title: "Blog",
        description: "Blog description",
        siteUrl: "https://example.com",
        titleField: "name",
        dateField: "createdAt",
        descriptionField: "summary",
      });

      expect(rss).toContain("<title>Custom Title</title>");
      expect(rss).toContain("<description>Custom description</description>");
    });

    it("handles entries without description", () => {
      const entries = [
        createEntry("test", "posts", {
          title: "No Description",
          publishedAt: new Date("2024-01-01"),
        }),
      ];

      const rss = generateRss(entries, {
        title: "Blog",
        description: "Blog description",
        siteUrl: "https://example.com",
      });

      expect(rss).toContain("<title>No Description</title>");
      // Check that there's no description tag within the item (after the pubDate)
      const itemSection = rss.substring(rss.indexOf("<pubDate>"));
      expect(itemSection).not.toContain("<description>No");
    });

    it("uses slug as fallback title", () => {
      const entries = [
        createEntry("my-post", "posts", {
          publishedAt: new Date("2024-01-01"),
        }),
      ];

      const rss = generateRss(entries, {
        title: "Blog",
        description: "Blog description",
        siteUrl: "https://example.com",
      });

      expect(rss).toContain("<title>my-post</title>");
    });

    it("filters out entries without date field", () => {
      const entries = [
        createEntry("with-date", "posts", {
          title: "With Date",
          publishedAt: new Date("2024-01-01"),
        }),
        createEntry("without-date", "posts", {
          title: "Without Date",
        }),
      ];

      const rss = generateRss(entries, {
        title: "Blog",
        description: "Blog description",
        siteUrl: "https://example.com",
      });

      expect(rss).toContain("<title>With Date</title>");
      expect(rss).not.toContain("<title>Without Date</title>");
    });

    it("handles string dates", () => {
      const entries = [
        createEntry("test", "posts", {
          title: "Test",
          publishedAt: "2024-01-15T10:00:00Z",
        }),
      ];

      const rss = generateRss(entries, {
        title: "Blog",
        description: "Blog description",
        siteUrl: "https://example.com",
      });

      expect(rss).toContain("<pubDate>");
      expect(rss).toContain("2024");
    });

    it("removes trailing slash from siteUrl", () => {
      const entries = [
        createEntry("test", "posts", {
          title: "Test",
          publishedAt: new Date("2024-01-01"),
        }),
      ];

      const rss = generateRss(entries, {
        title: "Blog",
        description: "Blog description",
        siteUrl: "https://example.com/",
      });

      expect(rss).toContain("<link>https://example.com/posts/test</link>");
      expect(rss).not.toContain("example.com//posts");
    });

    it("includes lastBuildDate", () => {
      const entries = [
        createEntry("test", "posts", {
          title: "Test",
          publishedAt: new Date("2024-01-01"),
        }),
      ];

      const rss = generateRss(entries, {
        title: "Blog",
        description: "Blog description",
        siteUrl: "https://example.com",
      });

      expect(rss).toContain("<lastBuildDate>");
    });

    it("can access computed fields", () => {
      const entry = createEntry("test", "posts", {
        title: "Test",
        publishedAt: new Date("2024-01-01"),
      });
      entry.computedTitle = "Computed Title Value";

      const rss = generateRss([entry], {
        title: "Blog",
        description: "Blog description",
        siteUrl: "https://example.com",
        titleField: "computedTitle",
      });

      expect(rss).toContain("<title>Computed Title Value</title>");
    });
  });

  describe("generateSitemap", () => {
    it("generates valid sitemap XML", () => {
      const entries = [
        createEntry("post-1", "posts"),
        createEntry("post-2", "posts"),
      ];

      const sitemap = generateSitemap(entries, "https://example.com");

      expect(sitemap).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(sitemap).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
      expect(sitemap).toContain("</urlset>");
    });

    it("includes all entries", () => {
      const entries = [
        createEntry("post-1", "posts"),
        createEntry("post-2", "posts"),
        createEntry("page-1", "pages"),
      ];

      const sitemap = generateSitemap(entries, "https://example.com");

      expect(sitemap).toContain("<loc>https://example.com/posts/post-1</loc>");
      expect(sitemap).toContain("<loc>https://example.com/posts/post-2</loc>");
      expect(sitemap).toContain("<loc>https://example.com/pages/page-1</loc>");
    });

    it("generates correct URL structure", () => {
      const entries = [createEntry("hello-world", "posts")];

      const sitemap = generateSitemap(entries, "https://example.com");

      expect(sitemap).toContain("<url>");
      expect(sitemap).toContain("<loc>https://example.com/posts/hello-world</loc>");
      expect(sitemap).toContain("</url>");
    });

    it("removes trailing slash from siteUrl", () => {
      const entries = [createEntry("test", "posts")];

      const sitemap = generateSitemap(entries, "https://example.com/");

      expect(sitemap).toContain("<loc>https://example.com/posts/test</loc>");
      expect(sitemap).not.toContain("example.com//posts");
    });

    it("escapes XML special characters in URLs", () => {
      const entries = [createEntry("post&test", "posts")];

      const sitemap = generateSitemap(entries, "https://example.com");

      expect(sitemap).toContain("<loc>https://example.com/posts/post&amp;test</loc>");
    });

    it("handles many entries", () => {
      const entries = Array.from({ length: 100 }, (_, i) =>
        createEntry(`post-${i}`, "posts"),
      );

      const sitemap = generateSitemap(entries, "https://example.com");

      const urlCount = (sitemap.match(/<url>/g) || []).length;
      expect(urlCount).toBe(100);
    });

    it("handles empty entries array", () => {
      const sitemap = generateSitemap([], "https://example.com");

      expect(sitemap).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(sitemap).toContain("<urlset");
      expect(sitemap).toContain("</urlset>");
      expect(sitemap).not.toContain("<url>");
    });
  });
});
