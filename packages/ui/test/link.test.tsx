import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Link, PREFETCH_ATTR, RELOAD_ATTR, StrictLink } from "../src/index";

/**
 * `<Link>` is the deliberately non-magic anchor: it must render the SAME `<a>` on
 * the server it would on the client, carry every native attribute through, and
 * turn `reload` into the one data attribute the runtime declines on — so these
 * assert the emitted markup, the contract the soft-nav runtime later reads.
 */

describe("Link", () => {
  it("renders a plain anchor at its href", () => {
    expect(renderToStaticMarkup(createElement(Link, { href: "/listings/7" }, "View"))).toBe(
      '<a href="/listings/7">View</a>',
    );
  });

  it("emits no reload attribute by default — the link soft-navigates", () => {
    const html = renderToStaticMarkup(createElement(Link, { href: "/about" }, "About"));

    expect(html).not.toContain(RELOAD_ATTR);
  });

  it("turns reload into the opt-out data attribute", () => {
    const html = renderToStaticMarkup(
      createElement(Link, { href: "/logout", reload: true }, "Log out"),
    );

    expect(html).toContain(`${RELOAD_ATTR}=""`);
  });

  it("does not emit the data attribute when reload is explicitly false", () => {
    const html = renderToStaticMarkup(createElement(Link, { href: "/x", reload: false }, "x"));

    expect(html).not.toContain(RELOAD_ATTR);
  });

  it("passes native anchor attributes straight through", () => {
    const html = renderToStaticMarkup(
      createElement(
        Link,
        { href: "https://example.com", className: "cta", rel: "noopener", target: "_blank" },
        "Out",
      ),
    );

    expect(html).toContain('class="cta"');
    expect(html).toContain('rel="noopener"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('href="https://example.com"');
  });

  it("renders its children", () => {
    const html = renderToStaticMarkup(
      createElement(Link, { href: "/" }, createElement("strong", null, "Home")),
    );

    expect(html).toBe('<a href="/"><strong>Home</strong></a>');
  });

  it("renders with no children", () => {
    expect(renderToStaticMarkup(createElement(Link, { href: "/empty" }))).toBe(
      '<a href="/empty"></a>',
    );
  });

  it("emits no prefetch attribute by default", () => {
    const html = renderToStaticMarkup(createElement(Link, { href: "/a" }, "a"));

    expect(html).not.toContain(PREFETCH_ATTR);
  });

  it("turns bare prefetch={true} into the viewport strategy attribute", () => {
    const html = renderToStaticMarkup(createElement(Link, { href: "/a", prefetch: true }, "a"));

    expect(html).toContain(`${PREFETCH_ATTR}="viewport"`);
  });

  it("renders an explicit hover prefetch strategy", () => {
    const html = renderToStaticMarkup(createElement(Link, { href: "/a", prefetch: "hover" }, "a"));

    expect(html).toContain(`${PREFETCH_ATTR}="hover"`);
  });

  it("renders an explicit viewport prefetch strategy", () => {
    const html = renderToStaticMarkup(
      createElement(Link, { href: "/a", prefetch: "viewport" }, "a"),
    );

    expect(html).toContain(`${PREFETCH_ATTR}="viewport"`);
  });

  it("emits no prefetch attribute when prefetch is explicitly false", () => {
    const html = renderToStaticMarkup(createElement(Link, { href: "/a", prefetch: false }, "a"));

    expect(html).not.toContain(PREFETCH_ATTR);
  });
});

describe("StrictLink", () => {
  it("is Link re-typed — renders the same anchor at its href", () => {
    expect(renderToStaticMarkup(createElement(StrictLink, { href: "/strict" }, "Go"))).toBe(
      '<a href="/strict">Go</a>',
    );
  });
});
