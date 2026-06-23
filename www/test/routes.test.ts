/**
 * Every marketing route renders; an unknown path does not.
 *
 * Boots the real app and drives `app.handle` — the exact code path a request
 * (and the static prerender) takes — to prove the landing page, the use-cases
 * showcase, the blog, and the changelog each answer 200 with their chrome and
 * key content, and that an unregistered path is a 404.
 */

import { createApp } from "@lesto/kernel";
import type { App } from "@lesto/kernel";
import { beforeAll, describe, expect, it } from "vitest";

import appConfig from "../lesto.app";
import { loadBlog } from "../src/content";
import { text } from "./support";

let app: App;

beforeAll(async () => {
  app = await createApp(appConfig);
});

describe("marketing routes", () => {
  it("renders the landing page with the hero tagline and the shared chrome", async () => {
    const html = await text(await app.handle("GET", "/"));

    expect(html).toContain("Batteries-included.");
    expect(html).toContain("Agent-native.");
    expect(html).toContain('class="hero'); // the gradient hero section (custom backdrop)
    // The shared layout footer's base line (the `site-footer` class became utilities).
    expect(html).toContain("Built with Lesto — a static, prerendered Lesto app.");
  });

  it("links the Tailwind stylesheet @lesto/styles compiles (the site dogfoods the pipeline)", async () => {
    const html = await text(await app.handle("GET", "/"));

    // `.styles("/styles.css")` injects the framework stylesheet link (ADR 0037); the
    // old hand-authored inline `<style>` design system is gone.
    expect(html).toContain('<link rel="stylesheet" href="/styles.css"');
    expect(html).not.toContain("--accent-soft:"); // no inline SITE_CSS palette anymore
  });

  it("sets the landing page <title> from its metadata", async () => {
    const html = await text(await app.handle("GET", "/"));

    expect(html).toContain("<title>Lesto — Batteries-included. Agent-native.</title>");
  });

  it("advertises the social-preview card on every page", async () => {
    const html = await text(await app.handle("GET", "/"));

    expect(html).toContain('property="og:image"');
    expect(html).toContain("https://lesto.run/og.svg");
  });

  it("renders the use-cases showcase grounded in the examples gallery", async () => {
    const html = await text(await app.handle("GET", "/use-cases"));

    expect(html).toContain("What you can build with Lesto");
    expect(html).toContain("examples/queue-dashboard"); // a real gallery link
  });

  it("renders the blog index and every post", async () => {
    const indexHtml = await text(await app.handle("GET", "/blog"));
    expect(indexHtml).toContain("Notes from the people building Lesto.");

    for (const post of await loadBlog()) {
      const response = await app.handle("GET", post.route);
      const html = await text(response);
      expect(response.status, post.route).toBe(200);
      expect(html).toContain("prose"); // the rendered-Markdown frame
    }
  });

  it("renders the changelog", async () => {
    const response = await app.handle("GET", "/changelog");
    const html = await text(response);

    expect(response.status).toBe(200);
    expect(html).toContain("Changelog");
  });

  it("returns 404 for a path that is not a page", async () => {
    const response = await app.handle("GET", "/does/not/exist");

    expect(response.status).toBe(404);
  });
});
