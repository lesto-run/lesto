/**
 * The @lesto/feeds journey, driven over the app's real HTTP routes (`app.handle`
 * on an in-memory SQLite database seeded with the blog's posts).
 *
 * What only an end-to-end wiring can prove:
 *
 *   - GET /feed.xml and /atom.xml each answer 200 with the correct feed content
 *     type, and their bodies are well-formed XML documents (they parse as such);
 *   - every required RSS channel / Atom feed element is present;
 *   - the feed carries exactly one node per seeded post;
 *   - a post whose title & summary carry `&`, `<`, `>` is XML-escaped — the raw
 *     text never leaks, and no bare ampersand survives anywhere in the document.
 *
 * WELL-FORMEDNESS WITHOUT A PARSER: neither Node nor Bun ships a global
 * `DOMParser`, and this example takes no XML-parser dependency (the whole point of
 * `@lesto/feeds` is that it needs none). So well-formedness is asserted
 * structurally (the XML prolog + the required elements) plus {@link BARE_AMPERSAND}:
 * a well-formed document contains no bare `&` — every one must open a predefined
 * entity (`&amp;`/`&lt;`/…) or a numeric character reference. This is a PROXY, not
 * a full parse: a bare ampersand is the classic malforming leak, but the regex does
 * not by itself catch a raw `<`/`>` in element text or a `"` in an attribute. That
 * escaping coverage is {@link assertEscaped}'s job — its `&lt;`/`&gt;` positives and
 * raw-title negative go RED on any `<`/`>` escaping regression, so the two together
 * catch a total escaping regression at the HTTP boundary. A full spec-validity
 * guarantee is `@lesto/feeds`' own, unit-tested there.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openSqlite } from "@lesto/runtime";
import type { Lesto } from "@lesto/web";

import { buildApp, SEED_POSTS, SPECIAL_POST } from "../src/app";

/**
 * A `&` that does NOT open a valid XML entity or numeric character reference.
 * A well-formed document has none; a raw, unescaped ampersand is the classic
 * malforming leak this feed must never produce.
 */
const BARE_AMPERSAND = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;

/** Assert the shared shape of any feed this app emits: an XML doc, well-formed. */
function assertWellFormedXml(xml: string): void {
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  expect(xml).not.toMatch(BARE_AMPERSAND);
}

/**
 * Assert `SPECIAL_POST`'s XML-special characters were escaped, not leaked.
 *
 * Non-vacuous by construction: the positive assertions prove there IS escaped
 * special-char content to protect (so the negatives can never pass for want of a
 * subject), and the negatives prove the RAW text never appears. Drop escaping and
 * `SPECIAL_POST.title` ("Tips & Tricks: <marquee> …") appears verbatim AND the
 * bare-ampersand check fires — both go RED.
 */
function assertEscaped(xml: string): void {
  // There is real special-char content here — the escaped forms are present…
  expect(xml).toContain("&amp;");
  expect(xml).toContain("&lt;");
  expect(xml).toContain("&gt;");

  // …and the raw, unescaped post text never appears (the load-bearing check).
  expect(xml).not.toContain(SPECIAL_POST.title);
  expect(xml).not.toContain(SPECIAL_POST.summary);
}

let app: Lesto;
let close: () => void;

beforeAll(async () => {
  const opened = await openSqlite();
  close = opened.close;

  const booted = await buildApp({ handle: opened.db });
  app = booted.app;
});

afterAll(() => {
  close();
});

describe("@lesto/feeds example — GET /feed.xml (RSS 2.0)", () => {
  it("answers 200 with the RSS content type and a well-formed document", async () => {
    const res = await app.handle("GET", "/feed.xml");

    expect(res.status).toBe(200);
    expect(String(res.headers["content-type"])).toContain("application/rss+xml");
    assertWellFormedXml(res.body);
  });

  it("carries the required RSS channel elements", async () => {
    const { body } = await app.handle("GET", "/feed.xml");

    expect(body).toContain('<rss version="2.0">');
    expect(body).toContain("<channel>");
    expect(body).toContain("<title>The Lesto Blog</title>");
    expect(body).toContain("<link>https://blog.lesto.dev/blog</link>");
    expect(body).toContain("<description>");
    expect(body).toContain("</channel>");
    expect(body).toContain("</rss>");
  });

  it("renders exactly one <item> per seeded post", async () => {
    const { body } = await app.handle("GET", "/feed.xml");

    const items = body.match(/<item>/g) ?? [];

    expect(items).toHaveLength(SEED_POSTS.length);
  });

  it("XML-escapes a post's &, <, > (no raw special characters leak)", async () => {
    const { body } = await app.handle("GET", "/feed.xml");

    assertEscaped(body);
  });
});

describe("@lesto/feeds example — GET /atom.xml (Atom 1.0)", () => {
  it("answers 200 with the Atom content type and a well-formed document", async () => {
    const res = await app.handle("GET", "/atom.xml");

    expect(res.status).toBe(200);
    expect(String(res.headers["content-type"])).toContain("application/atom+xml");
    assertWellFormedXml(res.body);
  });

  it("carries the required Atom feed elements", async () => {
    const { body } = await app.handle("GET", "/atom.xml");

    expect(body).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(body).toContain("<title>The Lesto Blog</title>");
    expect(body).toContain("<id>https://blog.lesto.dev/blog</id>");
    expect(body).toMatch(/<updated>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z<\/updated>/);
    expect(body).toContain("</feed>");
  });

  it("renders exactly one <entry> per seeded post", async () => {
    const { body } = await app.handle("GET", "/atom.xml");

    const entries = body.match(/<entry>/g) ?? [];

    expect(entries).toHaveLength(SEED_POSTS.length);
  });

  it("XML-escapes a post's &, <, > (no raw special characters leak)", async () => {
    const { body } = await app.handle("GET", "/atom.xml");

    assertEscaped(body);
  });
});
