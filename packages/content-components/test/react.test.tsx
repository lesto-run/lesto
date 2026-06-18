// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// Tell React this is an act() environment so its reconciler flushes effects
// synchronously inside our act() wrappers (silences the act-support warning).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { Content, type ContentEntry } from "../react/Content";
import { HtmlContent } from "../react/HtmlContent";
import { JsonLd } from "../react/JsonLd";
import { useMDXComponents, type ComponentRegistry } from "../react/useMDXComponents";

// ---------------------------------------------------------------------------
// MDX fixtures.
//
// MDXContent compiles its `code` prop with `new Function(...scope, code)` and
// expects the returned object to expose a `default` component (see
// @lesto/content-mdx). We hand-write the smallest such bundles rather than pull
// in the full MDX compiler — the unit under test is the *wiring*, not MDX.
// ---------------------------------------------------------------------------

/** A bundle whose default component renders a paragraph carrying `text`. */
function mdxParagraph(text: string): string {
  return `return { default: function MDXContent() {
    return React.createElement("p", { className: "mdx" }, ${JSON.stringify(text)});
  } };`;
}

/** A bundle whose default component throws while rendering. */
const MDX_THROWS = `return { default: function MDXContent() {
  throw new Error("mdx boom");
} };`;

// ---------------------------------------------------------------------------
// An injectable MDX component used to prove custom `components` reach
// MDXContent; defined at module scope so its identity is stable.
const Callout: ComponentRegistry[string] = (props) =>
  createElement("aside", { className: "callout" }, props.children as ReactNode);

// A live-DOM render helper. The MDX error boundary only catches during a real
// React commit, so static server rendering cannot exercise it — we mount into
// jsdom and let React's reconciler run inside act().
// ---------------------------------------------------------------------------

let containers: HTMLElement[] = [];

function renderLive(node: ReactNode): HTMLElement {
  const container = document.createElement("div");

  document.body.append(container);
  containers.push(container);

  const root = createRoot(container);

  act(() => {
    root.render(node);
  });

  return container;
}

afterEach(() => {
  for (const c of containers) c.remove();
  containers = [];
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// HtmlContent
// ---------------------------------------------------------------------------

describe("HtmlContent", () => {
  it("strips dangerous markup before injecting it into the DOM", () => {
    // A <script> tag and an inline onerror handler are classic XSS vectors;
    // sanitizeHtml (DOMPurify) must remove both, leaving only safe content.
    const html = `<p>safe</p><script>alert(1)</script><img src=x onerror="steal()">`;

    const markup = renderToStaticMarkup(createElement(HtmlContent, { html, className: "prose" }));

    expect(markup).toContain("<p>safe</p>");
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("onerror");
    // The class is forwarded onto the wrapper div.
    expect(markup).toContain('class="prose"');
  });

  it("renders raw html verbatim when unsanitized is set", () => {
    // The escape hatch must skip DOMPurify entirely — the <script> survives.
    const html = `<script>danger</script><b>bold</b>`;

    const markup = renderToStaticMarkup(createElement(HtmlContent, { html, unsanitized: true }));

    expect(markup).toContain("<script>danger</script>");
    expect(markup).toContain("<b>bold</b>");
  });

  it("returns null and logs when html is not a string", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // The bad prop is deliberately the wrong type; cast through unknown so the
    // guard branch is exercised without loosening the public signature.
    const markup = renderToStaticMarkup(
      createElement(HtmlContent, { html: 123 as unknown as string }),
    );

    expect(markup).toBe("");
    expect(spy).toHaveBeenCalledWith(
      "HtmlContent: `html` prop must be a string, received:",
      "number",
    );
  });

  it("returns null silently in production when html is not a string", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const previous = process.env.NODE_ENV;

    process.env.NODE_ENV = "production";

    try {
      const markup = renderToStaticMarkup(
        createElement(HtmlContent, { html: 123 as unknown as string }),
      );

      expect(markup).toBe("");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});

// ---------------------------------------------------------------------------
// JsonLd
// ---------------------------------------------------------------------------

describe("JsonLd", () => {
  it("renders an ld+json script and escapes characters that could break out", () => {
    // The `</script>` payload would close the tag early if emitted literally;
    // sanitizeJsonLd escapes `<`, `>`, and `&` to their \\u00xx forms.
    const json = JSON.stringify({ "@type": "Article", name: "</script><x>&" });

    const markup = renderToStaticMarkup(createElement(JsonLd, { json }));

    expect(markup).toContain('type="application/ld+json"');
    expect(markup).not.toContain("</script><x>");
    expect(markup).toContain("\\u003c");
    expect(markup).toContain("\\u003e");
    expect(markup).toContain("\\u0026");
  });

  it("returns null and logs when json is not a string", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const markup = renderToStaticMarkup(
      createElement(JsonLd, { json: { not: "a string" } as unknown as string }),
    );

    expect(markup).toBe("");
    expect(spy).toHaveBeenCalledWith("JsonLd: `json` prop must be a string, received:", "object");
  });

  it("returns null and logs when the json string cannot be parsed", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // Not valid JSON -> sanitizeJsonLd throws -> the component swallows it.
    const markup = renderToStaticMarkup(createElement(JsonLd, { json: "{ not valid json" }));

    expect(markup).toBe("");
    expect(spy).toHaveBeenCalledWith("JsonLd: Invalid JSON provided:", expect.anything());
  });

  it("returns null silently in production for a non-string json", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const previous = process.env.NODE_ENV;

    process.env.NODE_ENV = "production";

    try {
      const markup = renderToStaticMarkup(createElement(JsonLd, { json: 5 as unknown as string }));

      expect(markup).toBe("");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it("returns null silently in production for unparseable json", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const previous = process.env.NODE_ENV;

    process.env.NODE_ENV = "production";

    try {
      const markup = renderToStaticMarkup(createElement(JsonLd, { json: "{bad" }));

      expect(markup).toBe("");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});

// ---------------------------------------------------------------------------
// useMDXComponents
// ---------------------------------------------------------------------------

// Distinct component identities for the registry-merge assertions. Identity
// (not output) is what the hook's shallow comparison turns on.
const A: ComponentRegistry[string] = () => createElement("span", null, "A");
const B: ComponentRegistry[string] = () => createElement("span", null, "B");
const A2: ComponentRegistry[string] = () => createElement("span", null, "A2");

describe("useMDXComponents", () => {
  /** Drives the hook through a tiny probe component and captures each result. */
  function runHook(): {
    set: (base: ComponentRegistry, overrides?: ComponentRegistry) => void;
    results: ComponentRegistry[];
  } {
    const results: ComponentRegistry[] = [];

    let nextBase: ComponentRegistry = {};
    let nextOverrides: ComponentRegistry | undefined;

    function Probe() {
      results.push(useMDXComponents(nextBase, nextOverrides));
      return null;
    }

    const container = document.createElement("div");

    document.body.append(container);
    containers.push(container);

    const root = createRoot(container);

    function set(base: ComponentRegistry, overrides?: ComponentRegistry): void {
      nextBase = base;
      nextOverrides = overrides;
      act(() => {
        root.render(createElement(Probe));
      });
    }

    return { set, results };
  }

  it("merges base and overrides, with overrides winning", () => {
    const { set, results } = runHook();

    set({ A, B }, { A: A2 });

    expect(results[0]).toEqual({ A: A2, B });
  });

  it("defaults overrides to an empty object when omitted", () => {
    const { set, results } = runHook();

    set({ A, B });

    expect(results[0]).toEqual({ A, B });
  });

  it("returns the same reference when neither registry changes (shallow-equal)", () => {
    const { set, results } = runHook();

    // Two renders with fresh-but-shallow-equal object literals must NOT
    // produce a new merged registry — that is the whole point of the hook.
    set({ A, B }, { A: A2 });
    set({ A, B }, { A: A2 });

    expect(results[1]).toBe(results[0]);
  });

  it("recomputes when the base registry changes", () => {
    const { set, results } = runHook();

    set({ A }, {});
    set({ A, B }, {});

    expect(results[1]).not.toBe(results[0]);
    expect(results[1]).toEqual({ A, B });
  });

  it("recomputes when only the overrides registry changes", () => {
    const { set, results } = runHook();

    set({ A, B }, { A: A2 });
    set({ A, B }, { A });

    expect(results[1]).not.toBe(results[0]);
    expect(results[1]).toEqual({ A, B });
  });
});

// ---------------------------------------------------------------------------
// Content — the unified renderer (MDX vs HTML branching + boundary + anchors)
// ---------------------------------------------------------------------------

describe("Content", () => {
  it("renders an MDX entry through MDXContent", () => {
    const entry: ContentEntry = { mdx: { code: mdxParagraph("hello mdx") } };

    const markup = renderToStaticMarkup(createElement(Content, { entry, className: "prose" }));

    expect(markup).toContain('class="prose"');
    expect(markup).toContain('<p class="mdx">hello mdx</p>');
  });

  it("renders a markdown entry as sanitized HTML (no className)", () => {
    const entry: ContentEntry = {
      rendered: { html: `<p>body</p><script>evil()</script>` },
    };

    const markup = renderToStaticMarkup(createElement(Content, { entry }));

    expect(markup).toContain("<p>body</p>");
    expect(markup).not.toContain("<script>");
    // No className was passed, so the wrapper carries no class attribute.
    expect(markup).toBe("<div><p>body</p></div>");
  });

  it("forwards className onto the markdown wrapper when provided", () => {
    const entry: ContentEntry = { rendered: { html: "<p>body</p>" } };

    const markup = renderToStaticMarkup(createElement(Content, { entry, className: "prose" }));

    expect(markup).toBe('<div class="prose"><p>body</p></div>');
  });

  it("passes custom components and globals through to MDXContent", () => {
    // A bundle that delegates to an injected <Callout> component and reads a
    // global, so both conditional spreads on the MDX branch are exercised.
    const code = `return { default: function MDXContent(props) {
      var Callout = props.components.Callout;
      return React.createElement(Callout, null, "from-global:" + GREETING);
    } };`;

    const entry: ContentEntry = { mdx: { code } };

    const markup = renderToStaticMarkup(
      createElement(Content, { entry, components: { Callout }, globals: { GREETING: "hi" } }),
    );

    expect(markup).toContain('<aside class="callout">from-global:hi</aside>');
  });

  it("injects decorative anchor links into headings when anchorLinks is on", () => {
    const entry: ContentEntry = {
      rendered: { html: `<h2 id="intro">Intro</h2><h3 class="x" id='deep'>Deep</h3>` },
    };

    const markup = renderToStaticMarkup(createElement(Content, { entry, anchorLinks: true }));

    // Each heading gains an aria-hidden, tab-excluded anchor pointing at its id.
    expect(markup).toContain(
      '<a href="#intro" class="anchor" tabindex="-1" aria-hidden="true">#</a>',
    );
    expect(markup).toContain(
      '<a href="#deep" class="anchor" tabindex="-1" aria-hidden="true">#</a>',
    );
    // The original id attribute (single- or double-quoted) is preserved.
    expect(markup).toContain('id="intro"');
    expect(markup).toContain('id="deep"');
  });

  it("does not inject anchors when anchorLinks is off (default)", () => {
    const entry: ContentEntry = { rendered: { html: `<h2 id="intro">Intro</h2>` } };

    const markup = renderToStaticMarkup(createElement(Content, { entry }));

    expect(markup).not.toContain('class="anchor"');
  });

  it("shows the missing-content fallback when there is no rendered html", () => {
    const entry: ContentEntry = { rendered: {} };

    const markup = renderToStaticMarkup(createElement(Content, { entry, className: "prose" }));

    expect(markup).toContain('<div class="prose">');
    expect(markup).toContain("No rendered content available.");
  });

  it("treats an entry with neither mdx nor rendered as missing content", () => {
    const markup = renderToStaticMarkup(createElement(Content, { entry: {} }));

    expect(markup).toContain("No rendered content available.");
  });

  it("returns null and logs when entry is not an object", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const markup = renderToStaticMarkup(
      createElement(Content, { entry: null as unknown as ContentEntry }),
    );

    expect(markup).toBe("");
    expect(spy).toHaveBeenCalledWith(
      "Content: `entry` prop must be an object, received:",
      "object",
    );
  });

  it("ignores a non-string mdx.code and falls through to HTML handling", () => {
    // mdx is present but mdx.code is not a string, so isMDXEntry is false and
    // the renderer falls back to the rendered-html path.
    const entry = {
      mdx: { code: 42 },
      rendered: { html: "<p>fallback body</p>" },
    } as unknown as ContentEntry;

    const markup = renderToStaticMarkup(createElement(Content, { entry }));

    expect(markup).toContain("<p>fallback body</p>");
  });

  it("catches a throwing MDX child and shows the default error alert", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const entry: ContentEntry = { mdx: { code: MDX_THROWS } };

    const container = renderLive(createElement(Content, { entry }));

    const alert = container.querySelector('[role="alert"]');

    expect(alert?.textContent).toBe("Failed to render content");
    // componentDidCatch logs OUR diagnostic in non-production — proves the
    // boundary's catch path (not just React's own logging) engaged.
    expect(spy).toHaveBeenCalledWith("MDX render error:", expect.anything(), expect.anything());
  });

  it("stays silent in production while still rendering the error fallback", () => {
    // The boundary's componentDidCatch guards its console.error behind a
    // non-production check. In production it must NOT log, but the fallback
    // must still appear — this drives the production branch of that guard.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const previous = process.env.NODE_ENV;

    process.env.NODE_ENV = "production";

    try {
      const entry: ContentEntry = { mdx: { code: MDX_THROWS } };

      const container = renderLive(createElement(Content, { entry }));

      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      // React's own dev build logs the caught error, but OUR boundary's
      // "MDX render error:" diagnostic must be suppressed in production.
      expect(spy).not.toHaveBeenCalledWith(
        "MDX render error:",
        expect.anything(),
        expect.anything(),
      );
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it("logs nothing in production when entry is invalid but still returns null", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const previous = process.env.NODE_ENV;

    process.env.NODE_ENV = "production";

    try {
      const markup = renderToStaticMarkup(
        createElement(Content, { entry: null as unknown as ContentEntry }),
      );

      expect(markup).toBe("");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
