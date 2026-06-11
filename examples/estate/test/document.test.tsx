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

// ---------------------------------------------------------------------------
// Head placement (ADR 0011 Seam 1): the primer and the module script live in
// <head> so the data fetch starts at parse time and the deferred module runs
// after the parse — while the manifest stays at end-of-body.
// ---------------------------------------------------------------------------

describe("renderDocument — head placement", () => {
  it("emits the primer in <head>, before the module tag, with the manifest still in body", () => {
    // estate's Account island binds the `session` source, so a primer is emitted.
    const html = renderDocument(registry, homeTree, "Jade Mills Estates");

    const headEnd = html.indexOf("</head>");
    const primerAt = html.indexOf("window.__keelData");
    const moduleAt = html.indexOf('<script type="module" src="/client.js">');
    const manifestAt = html.indexOf('id="keel-islands"');
    const bodyOpen = html.indexOf("<body>");

    // The primer is present and inside <head>…
    expect(primerAt).toBeGreaterThan(-1);
    expect(primerAt).toBeLessThan(headEnd);
    // …before the module tag, which is also in <head>…
    expect(moduleAt).toBeGreaterThan(primerAt);
    expect(moduleAt).toBeLessThan(headEnd);
    // …while the inert manifest stays at end-of-body.
    expect(manifestAt).toBeGreaterThan(bodyOpen);
    expect(manifestAt).toBeGreaterThan(headEnd);
  });

  it("emits no primer for a page whose islands bind no data", () => {
    // A bare Page tree with no data-bound island → empty primer, none emitted.
    const html = renderDocument(registry, { type: "Page" }, "No islands");

    expect(html).not.toContain("window.__keelData");
    // The module tag is still emitted (and still in <head>).
    const headEnd = html.indexOf("</head>");
    expect(html.indexOf('<script type="module" src="/client.js">')).toBeLessThan(headEnd);
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
