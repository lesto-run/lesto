import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Link, RELOAD_ATTR } from "../src/index";

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
});
