/**
 * Every doc renders as a page; an unknown path does not.
 *
 * Boots the real app and drives `app.handle` — the exact code path a request
 * (and the static prerender) takes — to prove each content route answers 200
 * with its title, the sidebar nav, and the rendered body, and that an
 * unregistered path is a 404.
 */

import { createApp } from "@lesto/kernel";
import type { App } from "@lesto/kernel";
import { beforeAll, describe, expect, it } from "vitest";

import appConfig from "../lesto.app";
import { loadDocs } from "../src/content";
import { text } from "./support";

let app: App;

beforeAll(async () => {
  app = await createApp(appConfig);
});

describe("doc routes", () => {
  it("answers every content route with 200 and its rendered chrome", async () => {
    for (const doc of await loadDocs()) {
      const response = await app.handle("GET", doc.route);
      const html = await text(response);

      expect(response.status, doc.route).toBe(200);
      expect(html).toContain('<link rel="stylesheet" href="/styles.css"'); // dogfoods @lesto/styles
      expect(html).toContain("docs-article"); // the rendered-Markdown frame
    }
  });

  it("sets each page's <title> from its metadata", async () => {
    const html = await text(await app.handle("GET", "/"));

    expect(html).toContain("<title>Introduction · Lesto</title>");
  });

  it("highlights code blocks on a page that has them", async () => {
    const html = await text(await app.handle("GET", "/batteries/data"));

    expect(html).toContain("data-rehype-pretty-code-figure");
  });

  it("marks the current page active in the sidebar", async () => {
    const html = await text(await app.handle("GET", "/quickstart"));

    // The active sidebar link is the only element styled `text-accent-fg` (utilities).
    expect(html).toContain("text-accent-fg");
  });

  it("renders the search island fallback and the client module on every page", async () => {
    const html = await text(await app.handle("GET", "/"));

    expect(html).toContain("lesto-cmdk-trigger"); // the ⌘K palette's SSR fallback
    expect(html).toContain('src="/client.js"'); // the hydration module
  });

  it("returns 404 for a path that is not a doc", async () => {
    const response = await app.handle("GET", "/does/not/exist");

    expect(response.status).toBe(404);
  });
});
