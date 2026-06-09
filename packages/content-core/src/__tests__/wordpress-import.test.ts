import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { nn } from "./test-utils";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  parseWxrItems,
  htmlToMarkdown,
  importWordPress,
} from "../import/wordpress";

// =============================================================================
// Test Data
// =============================================================================

const SAMPLE_WXR = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
  <title>Test Blog</title>
  <link>https://example.com</link>

  <item>
    <title>First Post</title>
    <link>https://example.com/first-post/</link>
    <wp:post_date>2024-01-15 10:30:00</wp:post_date>
    <wp:post_name>first-post</wp:post_name>
    <wp:status>publish</wp:status>
    <wp:post_type>post</wp:post_type>
    <content:encoded><![CDATA[<p>This is the first post content.</p>]]></content:encoded>
    <excerpt:encoded><![CDATA[First post excerpt]]></excerpt:encoded>
    <category domain="category" nicename="tech"><![CDATA[Technology]]></category>
    <category domain="post_tag" nicename="javascript"><![CDATA[JavaScript]]></category>
  </item>

  <item>
    <title>Draft Post</title>
    <link>https://example.com/draft-post/</link>
    <wp:post_date>2024-02-20 14:00:00</wp:post_date>
    <wp:post_name>draft-post</wp:post_name>
    <wp:status>draft</wp:status>
    <wp:post_type>post</wp:post_type>
    <content:encoded><![CDATA[<p>Draft content here.</p>]]></content:encoded>
    <excerpt:encoded><![CDATA[]]></excerpt:encoded>
  </item>

  <item>
    <title>Page Content</title>
    <link>https://example.com/about/</link>
    <wp:post_date>2024-03-01 09:00:00</wp:post_date>
    <wp:post_name>about</wp:post_name>
    <wp:status>publish</wp:status>
    <wp:post_type>page</wp:post_type>
    <content:encoded><![CDATA[<h1>About Us</h1><p>This is a page.</p>]]></content:encoded>
    <excerpt:encoded><![CDATA[About page]]></excerpt:encoded>
  </item>

  <item>
    <title>Attachment</title>
    <link>https://example.com/attachment/</link>
    <wp:post_type>attachment</wp:post_type>
  </item>

</channel>
</rss>`;

const SAMPLE_WXR_MINIMAL = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <item>
    <title>Simple Post</title>
    <link>https://example.com/simple-post/</link>
    <content:encoded><![CDATA[<p>Simple content.</p>]]></content:encoded>
  </item>
</channel>
</rss>`;

const SAMPLE_WXR_MULTIPLE_CATEGORIES = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <item>
    <title>Multi Category Post</title>
    <link>https://example.com/multi-cat/</link>
    <wp:post_name>multi-cat</wp:post_name>
    <wp:status>publish</wp:status>
    <content:encoded><![CDATA[<p>Content</p>]]></content:encoded>
    <category domain="category" nicename="tech">Technology</category>
    <category domain="category" nicename="news">News</category>
    <category domain="post_tag" nicename="react">React</category>
    <category domain="post_tag" nicename="typescript">TypeScript</category>
    <category domain="post_tag" nicename="frontend">Frontend</category>
  </item>
</channel>
</rss>`;

// =============================================================================
// parseWxrItems Tests
// =============================================================================

describe("parseWxrItems", () => {
  it("parses posts from WXR XML", () => {
    const posts = parseWxrItems(SAMPLE_WXR);

    expect(posts).toHaveLength(3); // post, draft post, page (not attachment)
  });

  it("extracts title correctly", () => {
    const posts = parseWxrItems(SAMPLE_WXR);

    expect(nn(posts[0]).title).toBe("First Post");
    expect(nn(posts[1]).title).toBe("Draft Post");
  });

  it("extracts slug from wp:post_name", () => {
    const posts = parseWxrItems(SAMPLE_WXR);

    expect(nn(posts[0]).slug).toBe("first-post");
    expect(nn(posts[1]).slug).toBe("draft-post");
  });

  it("extracts slug from link when post_name is missing", () => {
    const posts = parseWxrItems(SAMPLE_WXR_MINIMAL);

    expect(nn(posts[0]).slug).toBe("simple-post");
  });

  it("extracts publish date", () => {
    const posts = parseWxrItems(SAMPLE_WXR);

    expect(nn(posts[0]).publishedAt).toBe("2024-01-15 10:30:00");
    expect(nn(posts[1]).publishedAt).toBe("2024-02-20 14:00:00");
  });

  it("extracts status correctly", () => {
    const posts = parseWxrItems(SAMPLE_WXR);

    expect(nn(posts[0]).status).toBe("publish");
    expect(nn(posts[1]).status).toBe("draft");
  });

  it("extracts content from CDATA", () => {
    const posts = parseWxrItems(SAMPLE_WXR);

    expect(nn(posts[0]).content).toBe("<p>This is the first post content.</p>");
  });

  it("extracts excerpt from CDATA", () => {
    const posts = parseWxrItems(SAMPLE_WXR);

    expect(nn(posts[0]).excerpt).toBe("First post excerpt");
  });

  it("extracts categories", () => {
    const posts = parseWxrItems(SAMPLE_WXR);

    expect(nn(posts[0]).categories).toEqual(["Technology"]);
  });

  it("extracts tags", () => {
    const posts = parseWxrItems(SAMPLE_WXR);

    expect(nn(posts[0]).tags).toEqual(["JavaScript"]);
  });

  it("handles multiple categories and tags", () => {
    const posts = parseWxrItems(SAMPLE_WXR_MULTIPLE_CATEGORIES);

    expect(nn(posts[0]).categories).toEqual(["Technology", "News"]);
    expect(nn(posts[0]).tags).toEqual(["React", "TypeScript", "Frontend"]);
  });

  it("skips non-post content types (attachments, nav_menu_item, etc)", () => {
    const posts = parseWxrItems(SAMPLE_WXR);

    // Should have 3 items: post, draft, page - but not attachment
    expect(posts).toHaveLength(3);
    expect(posts.find((p) => p.title === "Attachment")).toBeUndefined();
  });

  it("includes pages", () => {
    const posts = parseWxrItems(SAMPLE_WXR);

    const page = posts.find((p) => p.title === "Page Content");
    expect(page).toBeDefined();
    expect(page?.slug).toBe("about");
  });

  it("handles empty WXR", () => {
    const posts = parseWxrItems(`<?xml version="1.0"?><rss><channel></channel></rss>`);

    expect(posts).toHaveLength(0);
  });

  it("handles WXR with no items", () => {
    const wxr = `<?xml version="1.0"?>
    <rss version="2.0">
      <channel>
        <title>Empty Blog</title>
      </channel>
    </rss>`;

    const posts = parseWxrItems(wxr);
    expect(posts).toHaveLength(0);
  });

  it("defaults to draft status when status is missing", () => {
    const posts = parseWxrItems(SAMPLE_WXR_MINIMAL);

    expect(nn(posts[0]).status).toBe("draft");
  });

  it("uses current date when post_date is missing", () => {
    const posts = parseWxrItems(SAMPLE_WXR_MINIMAL);

    // Should have a date string
    expect(nn(posts[0]).publishedAt).toBeTruthy();
  });
});

// =============================================================================
// htmlToMarkdown Tests
// =============================================================================

describe("htmlToMarkdown", () => {
  describe("headers", () => {
    it("converts h1 to markdown", () => {
      expect(htmlToMarkdown("<h1>Title</h1>")).toBe("# Title");
    });

    it("converts h2 to markdown", () => {
      expect(htmlToMarkdown("<h2>Subtitle</h2>")).toBe("## Subtitle");
    });

    it("converts h3 to markdown", () => {
      expect(htmlToMarkdown("<h3>Section</h3>")).toBe("### Section");
    });

    it("converts h4-h6 to markdown", () => {
      expect(htmlToMarkdown("<h4>H4</h4>")).toBe("#### H4");
      expect(htmlToMarkdown("<h5>H5</h5>")).toBe("##### H5");
      expect(htmlToMarkdown("<h6>H6</h6>")).toBe("###### H6");
    });
  });

  describe("paragraphs and breaks", () => {
    it("converts paragraphs", () => {
      expect(htmlToMarkdown("<p>Paragraph text</p>")).toBe("Paragraph text");
    });

    it("converts line breaks", () => {
      expect(htmlToMarkdown("Line one<br>Line two")).toBe("Line one\nLine two");
      expect(htmlToMarkdown("Line one<br/>Line two")).toBe("Line one\nLine two");
      expect(htmlToMarkdown("Line one<br />Line two")).toBe("Line one\nLine two");
    });
  });

  describe("links and images", () => {
    it("converts links", () => {
      expect(htmlToMarkdown('<a href="https://example.com">Click here</a>')).toBe(
        "[Click here](https://example.com)"
      );
    });

    it("converts images with alt text", () => {
      expect(htmlToMarkdown('<img src="image.jpg" alt="My Image">')).toBe(
        "![My Image](image.jpg)"
      );
    });

    it("converts images without alt text", () => {
      expect(htmlToMarkdown('<img src="image.jpg">')).toBe("![](image.jpg)");
    });

    it("handles images with alt before src", () => {
      expect(htmlToMarkdown('<img alt="Alt" src="img.png">')).toBe("![Alt](img.png)");
    });
  });

  describe("text formatting", () => {
    it("converts strong to bold", () => {
      expect(htmlToMarkdown("<strong>bold text</strong>")).toBe("**bold text**");
    });

    it("converts b to bold", () => {
      expect(htmlToMarkdown("<b>bold text</b>")).toBe("**bold text**");
    });

    it("converts em to italic", () => {
      expect(htmlToMarkdown("<em>italic text</em>")).toBe("*italic text*");
    });

    it("converts i to italic", () => {
      expect(htmlToMarkdown("<i>italic text</i>")).toBe("*italic text*");
    });

    it("converts inline code", () => {
      expect(htmlToMarkdown("<code>const x = 1;</code>")).toBe("`const x = 1;`");
    });
  });

  describe("code blocks", () => {
    it("converts pre/code blocks", () => {
      const html = "<pre><code>function hello() {\n  return 'world';\n}</code></pre>";
      const md = htmlToMarkdown(html);
      expect(md).toContain("```");
      expect(md).toContain("function hello()");
    });

    it("converts pre without code", () => {
      const html = "<pre>plain preformatted text</pre>";
      const md = htmlToMarkdown(html);
      expect(md).toContain("```");
      expect(md).toContain("plain preformatted text");
    });
  });

  describe("blockquotes", () => {
    it("converts blockquotes", () => {
      const html = "<blockquote>A wise quote</blockquote>";
      const md = htmlToMarkdown(html);
      expect(md).toContain("> A wise quote");
    });

    it("handles multi-line blockquotes", () => {
      const html = "<blockquote>Line one\nLine two</blockquote>";
      const md = htmlToMarkdown(html);
      expect(md).toContain("> Line one");
      expect(md).toContain("> Line two");
    });
  });

  describe("lists", () => {
    it("converts unordered lists", () => {
      const html = "<ul><li>Item 1</li><li>Item 2</li></ul>";
      const md = htmlToMarkdown(html);
      expect(md).toContain("- Item 1");
      expect(md).toContain("- Item 2");
    });

    it("converts ordered lists", () => {
      const html = "<ol><li>First</li><li>Second</li><li>Third</li></ol>";
      const md = htmlToMarkdown(html);
      expect(md).toContain("1. First");
      expect(md).toContain("2. Second");
      expect(md).toContain("3. Third");
    });
  });

  describe("HTML entities", () => {
    it("decodes common HTML entities", () => {
      expect(htmlToMarkdown("a&amp;b")).toBe("a&b");
      expect(htmlToMarkdown("a&lt;b")).toBe("a<b");
      expect(htmlToMarkdown("a&gt;b")).toBe("a>b");
      expect(htmlToMarkdown('a&quot;b')).toBe('a"b');
      expect(htmlToMarkdown("a&nbsp;b")).toBe("a b"); // nbsp becomes regular space
    });

    it("decodes typographic entities", () => {
      expect(htmlToMarkdown("&mdash;")).toBe("\u2014"); // em dash
      expect(htmlToMarkdown("&ndash;")).toBe("\u2013"); // en dash
      expect(htmlToMarkdown("&hellip;")).toBe("\u2026"); // ellipsis
      expect(htmlToMarkdown("&ldquo;")).toBe("\u201C"); // left double quote
      expect(htmlToMarkdown("&rdquo;")).toBe("\u201D"); // right double quote
    });

    it("decodes numeric entities", () => {
      expect(htmlToMarkdown("&#60;")).toBe("<");
      expect(htmlToMarkdown("&#x3C;")).toBe("<");
    });
  });

  describe("WordPress shortcodes", () => {
    it("removes caption shortcodes but keeps content", () => {
      const html = '[caption id="test"]<img src="img.jpg">Caption text[/caption]';
      const md = htmlToMarkdown(html);
      expect(md).toContain("![](img.jpg)");
      expect(md).not.toContain("[caption");
    });

    it("removes gallery shortcodes", () => {
      const html = '<p>Before</p>[gallery ids="1,2,3"]<p>After</p>';
      const md = htmlToMarkdown(html);
      expect(md).not.toContain("[gallery");
      expect(md).toContain("Before");
      expect(md).toContain("After");
    });
  });

  describe("edge cases", () => {
    it("handles empty string", () => {
      expect(htmlToMarkdown("")).toBe("");
    });

    it("handles plain text", () => {
      expect(htmlToMarkdown("Just plain text")).toBe("Just plain text");
    });

    it("removes unknown HTML tags", () => {
      expect(htmlToMarkdown("<span>text</span>")).toBe("text");
      expect(htmlToMarkdown("<div>content</div>")).toBe("content");
    });

    it("handles nested elements", () => {
      const html = "<p><strong>Bold</strong> and <em>italic</em></p>";
      const md = htmlToMarkdown(html);
      expect(md).toContain("**Bold**");
      expect(md).toContain("*italic*");
    });

    it("cleans up excessive newlines", () => {
      const html = "<p>One</p>\n\n\n\n<p>Two</p>";
      const md = htmlToMarkdown(html);
      expect(md).not.toMatch(/\n{3,}/);
    });
  });
});

// =============================================================================
// importWordPress Integration Tests
// =============================================================================

describe("importWordPress", () => {
  let tempDir: string;
  let postsDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "docks-wp-import-"));
    postsDir = path.join(tempDir, "content", "posts");

    // Create content directory
    await mkdir(postsDir, { recursive: true });

    // Create WXR file
    await writeFile(path.join(tempDir, "export.xml"), SAMPLE_WXR);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("imports posts from WXR file", async () => {
    const result = await importWordPress({
      file: "export.xml",
      collection: "posts",
      cwd: tempDir,
      directory: postsDir,
    });

    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(result.files).toHaveLength(3);
  });

  it("creates markdown files with correct frontmatter", async () => {
    await importWordPress({
      file: "export.xml",
      collection: "posts",
      cwd: tempDir,
      directory: postsDir,
    });

    const postPath = path.join(postsDir, "first-post.md");
    const content = await readFile(postPath, "utf-8");

    expect(content).toContain("---");
    expect(content).toContain('title: "First Post"');
    expect(content).toContain("publishedAt:");
    expect(content).toContain('description: "First post excerpt"');
    expect(content).toContain("draft: false");
    expect(content).toContain('categories: ["Technology"]');
    expect(content).toContain('tags: ["JavaScript"]');
  });

  it("converts HTML content to markdown", async () => {
    await importWordPress({
      file: "export.xml",
      collection: "posts",
      cwd: tempDir,
      directory: postsDir,
    });

    const postPath = path.join(postsDir, "first-post.md");
    const content = await readFile(postPath, "utf-8");

    expect(content).toContain("This is the first post content.");
    expect(content).not.toContain("<p>");
  });

  it("marks draft posts correctly", async () => {
    await importWordPress({
      file: "export.xml",
      collection: "posts",
      cwd: tempDir,
      directory: postsDir,
    });

    const draftPath = path.join(postsDir, "draft-post.md");
    const content = await readFile(draftPath, "utf-8");

    expect(content).toContain("draft: true");
  });

  it("skips existing files", async () => {
    // Create an existing file
    const existingPath = path.join(postsDir, "first-post.md");
    await writeFile(existingPath, "existing content");

    const result = await importWordPress({
      file: "export.xml",
      collection: "posts",
      cwd: tempDir,
      directory: postsDir,
    });

    expect(result.imported).toBe(2); // Only 2 imported, 1 skipped
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(nn(result.errors[0]).reason).toContain("already exists");

    // Verify existing file wasn't overwritten
    const content = await readFile(existingPath, "utf-8");
    expect(content).toBe("existing content");
  });

  it("throws error for non-existent WXR file", async () => {
    await expect(
      importWordPress({
        file: "nonexistent.xml",
        collection: "posts",
        cwd: tempDir,
        directory: postsDir,
      })
    ).rejects.toThrow();
  });

  it("handles absolute file path", async () => {
    const absolutePath = path.join(tempDir, "export.xml");

    const result = await importWordPress({
      file: absolutePath,
      collection: "posts",
      cwd: tempDir,
      directory: postsDir,
    });

    expect(result.imported).toBe(3);
  });

  it("creates collection directory if it does not exist", async () => {
    // Remove the posts directory
    await rm(postsDir, { recursive: true });

    const result = await importWordPress({
      file: "export.xml",
      collection: "posts",
      cwd: tempDir,
      directory: postsDir,
    });

    expect(result.imported).toBe(3);
  });

  it("handles WXR with no posts", async () => {
    const emptyWxr = `<?xml version="1.0"?><rss><channel></channel></rss>`;
    await writeFile(path.join(tempDir, "empty.xml"), emptyWxr);

    const result = await importWordPress({
      file: "empty.xml",
      collection: "posts",
      cwd: tempDir,
      directory: postsDir,
    });

    expect(result.imported).toBe(0);
    expect(result.files).toHaveLength(0);
  });

  it("handles relative directory path", async () => {
    const result = await importWordPress({
      file: "export.xml",
      collection: "posts",
      cwd: tempDir,
      directory: "content/posts",
    });

    expect(result.imported).toBe(3);
  });
});
