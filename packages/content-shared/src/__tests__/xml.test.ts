import { describe, it, expect } from "vitest";
import {
  escapeXml,
  decodeXml,
  escapeXmlAttr,
  wrapCdata,
  formatXmlDate,
  formatRssDate,
} from "../xml.js";

describe("escapeXml", () => {
  it("escapes ampersands", () => {
    expect(escapeXml("foo & bar")).toBe("foo &amp; bar");
  });

  it("escapes less than", () => {
    expect(escapeXml("a < b")).toBe("a &lt; b");
  });

  it("escapes greater than", () => {
    expect(escapeXml("a > b")).toBe("a &gt; b");
  });

  it("escapes quotes", () => {
    expect(escapeXml('"quoted"')).toBe("&quot;quoted&quot;");
  });

  it("escapes apostrophes", () => {
    expect(escapeXml("it's")).toBe("it&#x27;s");
  });

  it("handles multiple special characters", () => {
    expect(escapeXml('<script>"alert(1)"</script>')).toBe(
      "&lt;script&gt;&quot;alert(1)&quot;&lt;/script&gt;"
    );
  });

  it("preserves safe text", () => {
    expect(escapeXml("Hello World")).toBe("Hello World");
    expect(escapeXml("abc123")).toBe("abc123");
  });

  it("handles empty string", () => {
    expect(escapeXml("")).toBe("");
  });

  it("handles unicode", () => {
    expect(escapeXml("日本語")).toBe("日本語");
    expect(escapeXml("é à ü")).toBe("é à ü");
  });
});

describe("decodeXml", () => {
  it("decodes named entities", () => {
    expect(decodeXml("&amp;")).toBe("&");
    expect(decodeXml("&lt;")).toBe("<");
    expect(decodeXml("&gt;")).toBe(">");
    expect(decodeXml("&quot;")).toBe('"');
  });

  it("decodes numeric entities", () => {
    expect(decodeXml("&#x27;")).toBe("'");
    expect(decodeXml("&#39;")).toBe("'");
    expect(decodeXml("&#x3C;")).toBe("<");
  });

  it("roundtrips with escapeXml", () => {
    const original = '<test attr="value">&\'content\'</test>';
    expect(decodeXml(escapeXml(original))).toBe(original);
  });

  it("handles plain text", () => {
    expect(decodeXml("Hello World")).toBe("Hello World");
  });

  it("handles empty string", () => {
    expect(decodeXml("")).toBe("");
  });
});

describe("escapeXmlAttr", () => {
  it("escapes attribute values", () => {
    expect(escapeXmlAttr('value with "quotes"')).toContain("&quot;");
  });

  it("escapes special characters", () => {
    const escaped = escapeXmlAttr("<>&");
    expect(escaped).toContain("&lt;");
    expect(escaped).toContain("&gt;");
    expect(escaped).toContain("&amp;");
  });

  it("uses named references", () => {
    const escaped = escapeXmlAttr("<");
    expect(escaped).toBe("&lt;");
  });

  it("handles empty string", () => {
    expect(escapeXmlAttr("")).toBe("");
  });
});

describe("wrapCdata", () => {
  it("wraps content in CDATA section", () => {
    expect(wrapCdata("content")).toBe("<![CDATA[content]]>");
  });

  it("handles empty content", () => {
    expect(wrapCdata("")).toBe("<![CDATA[]]>");
  });

  it("handles content with special characters", () => {
    expect(wrapCdata('<script>alert("xss")</script>')).toBe(
      '<![CDATA[<script>alert("xss")</script>]]>'
    );
  });

  it("handles content with ]]>", () => {
    const result = wrapCdata("foo]]>bar");
    // Should split into multiple CDATA sections, joined by ]]>
    // Result: <![CDATA[foo]]>]]><![CDATA[bar]]>
    expect(result).toBe("<![CDATA[foo]]>]]><![CDATA[bar]]>");
  });

  it("handles multiple ]]> occurrences", () => {
    const result = wrapCdata("a]]>b]]>c");
    // Should produce: <![CDATA[a]]>]]><![CDATA[b]]>]]><![CDATA[c]]>
    expect(result.split("<![CDATA[").length).toBe(4); // 3 sections + empty prefix
  });

  it("preserves content integrity", () => {
    const content = "Some text with <html> and & characters";
    const wrapped = wrapCdata(content);
    // CDATA should preserve content exactly
    expect(wrapped).toContain(content);
  });
});

describe("formatXmlDate", () => {
  it("formats Date object", () => {
    const date = new Date("2024-01-15T10:30:00Z");
    expect(formatXmlDate(date)).toBe("2024-01-15T10:30:00.000Z");
  });

  it("formats date string", () => {
    expect(formatXmlDate("2024-01-15T10:30:00Z")).toBe("2024-01-15T10:30:00.000Z");
  });

  it("formats timestamp number", () => {
    const timestamp = new Date("2024-01-15T10:30:00Z").getTime();
    expect(formatXmlDate(timestamp)).toBe("2024-01-15T10:30:00.000Z");
  });

  it("returns ISO 8601 format", () => {
    const result = formatXmlDate(new Date());
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("throws on invalid date", () => {
    expect(() => formatXmlDate("not a date")).toThrow(/Invalid date/);
    expect(() => formatXmlDate(NaN)).toThrow(/Invalid date/);
  });

  it("handles epoch", () => {
    expect(formatXmlDate(0)).toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("formatRssDate", () => {
  it("formats Date object to RFC 822", () => {
    const date = new Date("2024-01-15T10:30:00Z");
    const result = formatRssDate(date);
    expect(result).toBe("Mon, 15 Jan 2024 10:30:00 GMT");
  });

  it("formats date string", () => {
    const result = formatRssDate("2024-01-15T10:30:00Z");
    expect(result).toBe("Mon, 15 Jan 2024 10:30:00 GMT");
  });

  it("formats timestamp number", () => {
    const timestamp = new Date("2024-01-15T10:30:00Z").getTime();
    const result = formatRssDate(timestamp);
    expect(result).toBe("Mon, 15 Jan 2024 10:30:00 GMT");
  });

  it("returns UTC format", () => {
    const result = formatRssDate(new Date());
    expect(result).toContain("GMT");
  });

  it("throws on invalid date", () => {
    expect(() => formatRssDate("invalid")).toThrow(/Invalid date/);
    expect(() => formatRssDate(NaN)).toThrow(/Invalid date/);
  });

  it("handles epoch", () => {
    expect(formatRssDate(0)).toBe("Thu, 01 Jan 1970 00:00:00 GMT");
  });

  it("handles different days of week", () => {
    // Test various days
    expect(formatRssDate("2024-01-14T00:00:00Z")).toContain("Sun");
    expect(formatRssDate("2024-01-15T00:00:00Z")).toContain("Mon");
    expect(formatRssDate("2024-01-16T00:00:00Z")).toContain("Tue");
    expect(formatRssDate("2024-01-17T00:00:00Z")).toContain("Wed");
    expect(formatRssDate("2024-01-18T00:00:00Z")).toContain("Thu");
    expect(formatRssDate("2024-01-19T00:00:00Z")).toContain("Fri");
    expect(formatRssDate("2024-01-20T00:00:00Z")).toContain("Sat");
  });
});
