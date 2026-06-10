// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MDXContent } from "../src/components/MDXContent";

// ---------------------------------------------------------------------------
// MDXContent evaluates its `code` prop with `new Function(...scope, code)` and
// expects the returned object to expose a `default` component. We hand-write
// the smallest such bundles here — the unit under test is the WIRING (eval,
// scope injection, component merging, memoization), not MDX compilation. The
// real compiler is proven separately in compiler.test.ts (node env), because
// esbuild cannot run under jsdom.
//
// This mirrors packages/content-components/test/react.test.tsx.
// ---------------------------------------------------------------------------

/** A bundle whose default renders an <h1> + <p>. */
const PROSE_BUNDLE = `return { default: function MDXContent() {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement("h1", null, "Hello"),
    React.createElement("p", null, "A paragraph of prose."),
  );
} };`;

/** A bundle whose default delegates its `pre` to the injected components map. */
const PRE_BUNDLE = `return { default: function MDXContent(props) {
  var Pre = (props.components && props.components.pre) || "pre";
  return React.createElement(Pre, null, React.createElement("code", null, "const x = 1;"));
} };`;

/** A bundle that reads a value from the injected scope (globals). */
const GLOBAL_BUNDLE = `return { default: function MDXContent() {
  return React.createElement("p", null, "The year is " + String(theYear) + ".");
} };`;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: ReactElement) {
  act(() => root.render(node));
}

describe("MDXContent", () => {
  it("evaluates and renders the bundle inside the wrapper div", () => {
    render(createElement(MDXContent, { code: PROSE_BUNDLE }));

    expect(container.querySelector("h1")?.textContent).toBe("Hello");
    expect(container.querySelector("p")?.textContent).toBe("A paragraph of prose.");
  });

  it("applies the className to the wrapper div", () => {
    render(createElement(MDXContent, { code: PROSE_BUNDLE, className: "docs-body" }));

    expect((container.firstElementChild as HTMLElement).className).toBe("docs-body");
  });

  it("maps `pre` to CodeBlock by default, yielding a copy button", () => {
    render(createElement(MDXContent, { code: PRE_BUNDLE }));

    // CodeBlock wraps the <pre> and renders its copy <button>.
    expect(container.querySelector("pre")?.textContent).toBe("const x = 1;");
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Copy code");
  });

  it("lets a caller override the default components", () => {
    const components = {
      pre: (props: Record<string, unknown>) =>
        createElement("pre", { "data-custom": "yes" }, props.children as ReactElement),
    };

    render(createElement(MDXContent, { code: PRE_BUNDLE, components }));

    // The custom `pre` is used: no CodeBlock copy button is rendered.
    expect(container.querySelector("pre")?.getAttribute("data-custom")).toBe("yes");
    expect(container.querySelector("button")).toBeNull();
  });

  it("exposes globals to the evaluated MDX scope", () => {
    render(createElement(MDXContent, { code: GLOBAL_BUNDLE, globals: { theYear: 2026 } }));

    expect(container.textContent).toContain("The year is 2026.");
  });

  it("reuses the memoized component across a re-render with identical inputs", () => {
    const globals = { theYear: 1999 };

    render(createElement(MDXContent, { code: GLOBAL_BUNDLE, globals }));
    expect(container.textContent).toContain("1999");

    // Same code + same globals reference -> memo keeps the prior component, and
    // the new className still applies to the wrapper.
    render(createElement(MDXContent, { code: GLOBAL_BUNDLE, globals, className: "again" }));

    expect((container.firstElementChild as HTMLElement).className).toBe("again");
    expect(container.textContent).toContain("1999");
  });
});
