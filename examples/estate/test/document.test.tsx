/**
 * Pins the document-render seam (ADR 0008's wiring, estate's half).
 *
 * `renderDocument` must render its body through `@keel/ui`'s `renderPageMarkup`,
 * never a direct `react-dom/server` call — the seam owns two behaviors this
 * suite locks down:
 *
 *   1. The marker rule: a page whose islands are all deferred renders marker-free
 *      static markup, but the moment any island is `ssr: true` the body must be
 *      produced by `renderToString` so the hydration markers survive. The old
 *      hard-coded `renderToStaticMarkup` silently violated this — the bug fixed
 *      by routing through the seam.
 *
 *   2. The dialect seam: an injected {@link ServerRenderer} is honored end to
 *      end — through `renderDocument` itself and through `buildEdgeApp`'s
 *      `serverRenderer` option, which is how the Worker renders Preact-matched
 *      markup inside its aliased bundle (see worker.ts + wrangler.jsonc).
 */

import { describe, expect, it } from "vitest";

import { island, Registry } from "@keel/ui";
import type { ServerRenderer, UiNode } from "@keel/ui";

import { renderDocument } from "../src/document";
import { buildEdgeApp } from "../src/edge";
import { registry } from "../src/registry";

/** A recording renderer with sentinel outputs, to observe which dialect call ran. */
function fakeRenderer(): { renderer: ServerRenderer; calls: string[] } {
  const calls: string[] = [];

  return {
    calls,
    renderer: {
      renderToString: () => {
        calls.push("renderToString");

        return "<div>via-render-to-string</div>";
      },
      renderToStaticMarkup: () => {
        calls.push("renderToStaticMarkup");

        return "<div>via-static-markup</div>";
      },
    },
  };
}

/** A registry whose one client component is `ssr: true` — the marker-demanding case. */
function ssrRegistry(): Registry {
  return new Registry().defineClient({
    name: "Greeting",
    description: "An ssr-able island: the server renders its real output.",
    component: () => <span>hi</span>,
    ssr: true,
  });
}

/** estate's real home tree, abridged: the header slot carrying the Account island. */
const homeTree: UiNode = {
  type: "Page",
  children: [{ type: "SiteHeader", children: [island("Account")] }],
};

describe("renderDocument", () => {
  it("renders a deferred-island page as marker-free static markup (default React)", () => {
    const html = renderDocument(registry, homeTree, "Jade Mills Estates");

    // The island slot and its manifest are present; no React hydration markers —
    // a deferred island mounts fresh, so static (smaller) markup is correct.
    expect(html).toContain("data-keel-island");
    expect(html).toContain('id="keel-islands"');
    expect(html).not.toContain("<!--");
  });

  it("routes a deferred-island page through renderToStaticMarkup", () => {
    const { renderer, calls } = fakeRenderer();

    const html = renderDocument(registry, homeTree, "Jade Mills Estates", undefined, renderer);

    expect(calls).toEqual(["renderToStaticMarkup"]);
    expect(html).toContain("via-static-markup");
  });

  it("routes an ssr:true island through renderToString, keeping hydration markers", () => {
    const { renderer, calls } = fakeRenderer();

    renderDocument(ssrRegistry(), island("Greeting"), "SSR", undefined, renderer);

    // The seam's whole point: any ssr island demands the marker-preserving call.
    // The old direct renderToStaticMarkup would have stripped them silently.
    expect(calls).toEqual(["renderToString"]);
  });
});

describe("buildEdgeApp serverRenderer threading", () => {
  it("renders pages through the injected dialect (how the Worker speaks Preact)", async () => {
    const { renderer, calls } = fakeRenderer();

    const app = buildEdgeApp("test-secret", { serverRenderer: renderer });

    const response = await app.handle("GET", "/");

    expect(response.status).toBe(200);
    expect(response.body).toContain("via-static-markup");
    expect(calls).toEqual(["renderToStaticMarkup"]);
  });

  it("defaults to the React dialect when no renderer is given (the in-process path)", async () => {
    const response = await buildEdgeApp("test-secret").handle("GET", "/");

    expect(response.status).toBe(200);
    expect(response.body).toContain("Jade Mills Estates");
    expect(response.body).not.toContain("via-static-markup");
  });
});
