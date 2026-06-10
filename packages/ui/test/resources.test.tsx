import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  lcpImage,
  modulePreload,
  preconnect,
  prefetchDNS,
  preinit,
  preinitModule,
  preload,
} from "../src/index";
import type { ResourceRegistrar } from "../src/index";

// ---------------------------------------------------------------------------
// A recording registrar: prove each helper forwards href + options to the right
// react-dom function, without needing a real render. (Two helpers below also go
// end-to-end through `renderToStaticMarkup` to prove React really hoists them.)
// ---------------------------------------------------------------------------

type Call = { fn: string; args: unknown[] };

function recorder(): { registrar: ResourceRegistrar; calls: Call[] } {
  const calls: Call[] = [];

  const record =
    (fn: string) =>
    (...args: unknown[]): void => {
      calls.push({ fn, args });
    };

  const registrar: ResourceRegistrar = {
    preload: record("preload"),
    preinit: record("preinit"),
    preinitModule: record("preinitModule"),
    preconnect: record("preconnect"),
    prefetchDNS: record("prefetchDNS"),
  };

  return { registrar, calls };
}

describe("resource hints — forwarding to react-dom", () => {
  it("preload forwards href and options", () => {
    const { registrar, calls } = recorder();

    preload("/hero.jpg", { as: "image", fetchPriority: "high" }, registrar);

    expect(calls).toEqual([
      { fn: "preload", args: ["/hero.jpg", { as: "image", fetchPriority: "high" }] },
    ]);
  });

  it("preinit forwards href and options", () => {
    const { registrar, calls } = recorder();

    preinit("/critical.css", { as: "style", precedence: "high" }, registrar);

    expect(calls).toEqual([
      { fn: "preinit", args: ["/critical.css", { as: "style", precedence: "high" }] },
    ]);
  });

  it("preinitModule forwards options when given", () => {
    const { registrar, calls } = recorder();

    preinitModule("/island.js", { crossOrigin: "anonymous" }, registrar);

    expect(calls).toEqual([
      { fn: "preinitModule", args: ["/island.js", { crossOrigin: "anonymous" }] },
    ]);
  });

  it("preinitModule omits the options argument when none is given", () => {
    const { registrar, calls } = recorder();

    preinitModule("/island.js", undefined, registrar);

    // The single-arg call is the point: no explicit `undefined` reaches react-dom.
    expect(calls).toEqual([{ fn: "preinitModule", args: ["/island.js"] }]);
  });

  it("preconnect forwards options when given", () => {
    const { registrar, calls } = recorder();

    preconnect("https://cdn.example.com", { crossOrigin: "use-credentials" }, registrar);

    expect(calls).toEqual([
      { fn: "preconnect", args: ["https://cdn.example.com", { crossOrigin: "use-credentials" }] },
    ]);
  });

  it("preconnect omits the options argument when none is given", () => {
    const { registrar, calls } = recorder();

    preconnect("https://cdn.example.com", undefined, registrar);

    expect(calls).toEqual([{ fn: "preconnect", args: ["https://cdn.example.com"] }]);
  });

  it("prefetchDNS forwards the href", () => {
    const { registrar, calls } = recorder();

    prefetchDNS("https://dns.example.com", registrar);

    expect(calls).toEqual([{ fn: "prefetchDNS", args: ["https://dns.example.com"] }]);
  });
});

// Components that register hints inside their render, via the DEFAULT registrar
// (the real react-dom functions) — so the test proves React really hoists them.
function PreloadHero(): null {
  preload("/hero.jpg", { as: "image", fetchPriority: "high" });

  return null;
}

function ManyHints(): null {
  preinit("/app.js", { as: "script" });
  preconnect("https://cdn.example.com");
  prefetchDNS("https://dns.example.com");
  preinitModule("/m.js");

  return null;
}

describe("resource hints — real React hoisting", () => {
  it("hoists a preload <link> emitted from inside a render into the markup", () => {
    const html = renderToStaticMarkup(<PreloadHero />);

    // React turned the imperative hint into a real <link rel="preload">.
    expect(html).toContain('rel="preload"');
    expect(html).toContain('href="/hero.jpg"');
    expect(html).toContain('as="image"');
  });

  it("hoists preinit/preconnect/prefetchDNS hints into the markup", () => {
    const html = renderToStaticMarkup(<ManyHints />);

    expect(html).toContain('src="/app.js"');
    expect(html).toContain('rel="preconnect"');
    expect(html).toContain('rel="dns-prefetch"');
    expect(html).toContain('src="/m.js"');
  });
});

describe("lcpImage", () => {
  it("marks the hero image fetchPriority=high, eager, and async-decoded", () => {
    const html = renderToStaticMarkup(lcpImage({ src: "/hero.jpg", alt: "A house" }));

    // React 19 emits the attribute in its DOM-property casing (`fetchPriority`);
    // the browser reads it case-insensitively. React ALSO auto-emits a
    // `<link rel="preload" as="image">` from an `<img fetchPriority>` — so the
    // hint reaches the browser ahead of the body, the LCP win.
    expect(html).toContain('fetchPriority="high"');
    expect(html).toContain('loading="eager"');
    expect(html).toContain('decoding="async"');
    expect(html).toContain('src="/hero.jpg"');
    expect(html).toContain('alt="A house"');
    expect(html).toContain('rel="preload"');
    expect(html).toContain('as="image"');
  });

  it("passes through optional sizing and styling attributes", () => {
    const html = renderToStaticMarkup(
      lcpImage({
        src: "/hero.jpg",
        alt: "A house",
        width: 1200,
        height: 600,
        className: "hero",
        sizes: "100vw",
        srcSet: "/hero-2x.jpg 2x",
      }),
    );

    expect(html).toContain('width="1200"');
    expect(html).toContain('height="600"');
    expect(html).toContain('class="hero"');
    expect(html).toContain('sizes="100vw"');
    // React emits the DOM-property casing `srcSet` in static markup.
    expect(html).toContain('srcSet="/hero-2x.jpg 2x"');
  });
});

describe("modulePreload", () => {
  it("emits a <link rel=modulepreload> for an island bundle", () => {
    const html = renderToStaticMarkup(modulePreload("/client.js"));

    expect(html).toBe('<link rel="modulepreload" href="/client.js"/>');
  });

  it("carries crossOrigin when given", () => {
    const html = renderToStaticMarkup(modulePreload("/client.js", "anonymous"));

    expect(html).toContain('crossorigin="anonymous"');
  });
});
