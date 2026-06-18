// @vitest-environment jsdom

/**
 * End-to-end proof of the pluggable {@link ServerRenderer} seam: an `ssr: true`
 * island rendered server-side in the PREACT dialect hydrates cleanly with Preact's
 * client, while the SAME island rendered in the React dialect emits markup the
 * Preact client cannot agree with — the mismatch the seam removes. This is ADR
 * 0007's named follow-up: the capability that unblocks `ssr: true` islands under
 * the opt-in `react`→`preact/compat` client alias. The test's whole job is to
 * demonstrate that dialect-matching is the fix.
 *
 * Why the island is built with each dialect's own `createElement` rather than
 * driven through `@volo/ui`'s engine: the engine becomes the Preact dialect by
 * build-time aliasing `react`→`preact/compat` for the WHOLE module graph (estate's
 * `build-client.ts`), not per-call. Aliasing the engine inside one vitest file
 * would force every other `@volo/ui` test onto Preact too. So this test
 * reconstructs the EXACT shell the engine emits — a `<div data-volo-island="…">`
 * wrapping the lazily-built component element (see `render.tsx`'s `buildIsland`) —
 * in each dialect, the precise shape the aliased engine produces, and feeds it
 * through the REAL {@link renderPageMarkup} and the REAL {@link preactServerRenderer}
 * adapter. The seam and its dialect selection are exercised verbatim; only the
 * element factory is the one the alias would have swapped in anyway.
 *
 * The canary is the adjacent-text shape (`'Hi, ', name, '! Welcome back.'` — two+
 * text segments under one parent). React delimits those segments with `<!-- -->`
 * comment markers so its own `hydrateRoot` can walk them; Preact emits no such
 * markers (it has its own scheme). Hydrate React-emitted markup with Preact and
 * those markers are foreign matter the Preact client never rendered — a server/
 * client disagreement. Render the server side in the Preact dialect and the
 * markers are gone: server and client agree, and Preact hydrates cleanly.
 */

import { createElement as preactCreateElement, hydrate } from "preact/compat";
import { createElement as reactCreateElement } from "react";
import { renderToString as preactRenderToString } from "preact-render-to-string";
import { renderToString as reactRenderToString } from "react-dom/server";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { ISLAND_ATTR } from "../src/index";
import { preactServerRenderer, renderPageMarkup } from "../src/server";
import type { Page, ServerRenderer } from "../src/server";

// The element factory under test: each dialect's `createElement`, narrowed to the
// `(type, props, ...children) => element` shape this test uses. The two libraries'
// own overload unions are not assignable to one another, so we type the seam by
// the call shape we exercise rather than by either library's full signature — the
// runtime value is the real dialect factory.
type CreateElement = (
  type: string,
  props: Record<string, unknown>,
  ...children: unknown[]
) => unknown;

const preactH = preactCreateElement as unknown as CreateElement;

const reactH = reactCreateElement as unknown as CreateElement;

// The `ssr: true` island's component, written in whichever dialect's element
// factory it is given. Its render interpolates text — the realistic, dangerous
// shape that exposes a marker mismatch (a single-text-child component would
// survive even a markerless render, masking the defect).
function greeting(h: CreateElement, name: string): ReactElement {
  return h("p", { className: "greet" }, "Hi, ", name, "! Welcome back.") as ReactElement;
}

// The shell the engine's `buildIsland` emits for an `ssr: true` island: a marked
// wrapper div holding the component's REAL output (built lazily so the renderer
// walks it). Built per-call so server and client get independent element trees,
// exactly as a real render does. The factory is the dialect under test.
function islandShell(h: CreateElement): ReactElement {
  return h("div", { [ISLAND_ATTR]: "$" }, greeting(h, "Ada")) as ReactElement;
}

// A built Page carrying one `ssr: true` island, so `renderPageMarkup` takes its
// `renderToString` (marker-keeping) branch — the same decision the engine makes
// from the manifest. The element is the island shell in the given dialect.
function ssrPage(h: CreateElement): Page {
  return {
    element: islandShell(h),
    errors: [],
    islands: [{ id: "$", component: "Greeting", props: { name: "Ada" }, ssr: true }],
  };
}

// Count the React-style `<!-- -->` text-segment comment markers in the `<p>` of a
// painted shell — the foreign matter that only the React dialect emits.
function commentMarkers(): number {
  const paragraph = document.body.querySelector(".greet");

  if (paragraph === null) throw new Error("test setup: greeting not painted");

  return Array.from(paragraph.childNodes).filter((node) => node.nodeType === Node.COMMENT_NODE)
    .length;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("preactServerRenderer — dialect-matched ssr:true hydration", () => {
  it("renders ssr:true island markup via preact-render-to-string, free of React's comment markers", () => {
    // renderPageMarkup picks renderToString for the ssr island, but the DIALECT is
    // the injected adapter's: Preact emits the adjacent text with NONE of React's
    // `<!-- -->` segment markers. This is the markup the Preact client hydrates
    // against — and it agrees with what a Preact client would itself produce.
    const html = renderPageMarkup(ssrPage(preactH), preactServerRenderer);

    expect(html).toBe(`<div ${ISLAND_ATTR}="$"><p class="greet">Hi, Ada! Welcome back.</p></div>`);
    expect(html).not.toContain("<!-- -->");
    // It is exactly the adapter's own renderToString output — proof the seam routed
    // through Preact, not the React default.
    expect(html).toBe(preactRenderToString(islandShell(preactH) as never));
  });

  it("serializes a marker-free (no-ssr) page through the adapter's renderToStaticMarkup", () => {
    // The seam's OTHER half: a page with no `ssr: true` island takes
    // renderPageMarkup's renderToStaticMarkup branch (no hydration markers needed),
    // and the Preact adapter must serve that path in its own dialect too. We build
    // the same shell but mark the manifest entry `ssr: false`, so the static branch
    // is taken; preact-render-to-string's renderToStaticMarkup produces the body.
    const page: Page = {
      element: islandShell(preactH),
      errors: [],
      islands: [{ id: "$", component: "Greeting", props: { name: "Ada" }, ssr: false }],
    };

    const html = renderPageMarkup(page, preactServerRenderer);

    expect(html).toBe(`<div ${ISLAND_ATTR}="$"><p class="greet">Hi, Ada! Welcome back.</p></div>`);
  });

  it("hydrates the Preact-dialect markup with Preact cleanly — zero foreign markers, text intact", () => {
    // Server markup in Preact's dialect → Preact client hydrate. There were no
    // comment markers to begin with and none after: server and client agree on the
    // shape, so hydration reuses the region with the greeting intact. This is the
    // `ssr: true` win the seam unlocks for a Preact client.
    const html = renderPageMarkup(ssrPage(preactH), preactServerRenderer);

    document.body.innerHTML = html;

    expect(commentMarkers()).toBe(0);

    const container = document.body.querySelector(`[${ISLAND_ATTR}="$"]`);

    if (container === null) throw new Error("test setup: no island shell painted");

    hydrate(islandShell(preactH) as never, container);

    expect(commentMarkers()).toBe(0);
    expect(document.body.querySelector(".greet")?.textContent).toBe("Hi, Ada! Welcome back.");
  });

  it("the React-dialect render of the SAME island carries markers the Preact client never emits", () => {
    // The contrast that proves WHY dialect-matching is the fix. The SAME island,
    // server-rendered in the REACT dialect (the default `react-dom/server`
    // renderToString), delimits the adjacent text with `<!-- -->` markers and ships
    // them in the markup. A Preact client renders that text WITHOUT markers, so the
    // server markup it must hydrate disagrees with what it produces — the very
    // mismatch the Preact-dialect render above eliminates (zero markers, agreement).
    const reactRenderer: ServerRenderer = {
      dialect: "react",
      renderToString: (node) => reactRenderToString(node),
      renderToStaticMarkup: (node) => reactRenderToString(node),
    };

    const html = renderPageMarkup(ssrPage(reactH), reactRenderer);

    expect(html).toContain("Hi, <!-- -->Ada<!-- -->! Welcome back.");

    document.body.innerHTML = html;

    // The React server markup carries the two segment markers a Preact client never
    // renders — the foreign matter the matched-dialect render had zero of.
    expect(commentMarkers()).toBe(2);
  });
});
