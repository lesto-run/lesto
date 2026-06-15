import { createElement, Suspense } from "react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineDataSource, defineIsland } from "@keel/ui";
import { preactServerRenderer, reactServerRenderer } from "@keel/ui/server";

import { runWithContext } from "../src/context";
import { applyUiDialect, keel } from "../src/keel";
import { Context as RequestCtx } from "../src/handler-context";
import { renderPageResponse } from "../src/render-page";
import type { Context } from "../src/handler-context";
import type { KeelResponse } from "../src/types";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Drain a streamed response body to a single string for assertions. */
async function drain(response: KeelResponse): Promise<string> {
  const stream = response.body as unknown as ReadableStream<Uint8Array>;
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  let out = "";

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;

    out += decoder.decode(value, { stream: true });
  }

  return out + decoder.decode();
}

function Hello({ name }: { name: string }): ReactNode {
  return createElement("h1", null, `Hello ${name}`);
}

const Outer = ({ children }: { children: ReactNode }) =>
  createElement("div", { id: "outer" }, children);

const Inner = ({ children }: { children: ReactNode }) =>
  createElement("div", { id: "inner" }, children);

const Parent = ({ children }: { children: ReactNode }) =>
  createElement("div", { id: "parent" }, children);

describe("page rendering", () => {
  it("streams a full HTML document with a doctype", async () => {
    const app = keel().page("/", { component: () => createElement("main", null, "home") });

    const response = await app.handle("GET", "/");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");

    const html = await drain(response);

    expect(html.toLowerCase()).toContain("<!doctype html>");
    expect(html).toContain("<main>home</main>");
    expect(html).toContain('<meta charSet="utf-8"');
    expect(html).toContain("width=device-width");
  });

  it("feeds the component props from load", async () => {
    const app = keel().page("/hi", {
      load: () => ({ name: "Ada" }),
      component: Hello,
    });

    const html = await drain(await app.handle("GET", "/hi"));

    expect(html).toContain("<h1>Hello Ada</h1>");
  });

  it("renders a page with no load using empty props", async () => {
    const app = keel().page("/x", { component: () => createElement("p", null, "no-load") });

    expect(await drain(await app.handle("GET", "/x"))).toContain("<p>no-load</p>");
  });

  it("derives head metadata from the loaded props", async () => {
    const app = keel().page("/post", {
      load: () => ({ heading: "Keel ships" }),
      metadata: (loaded) => ({
        title: loaded["heading"] as string,
        description: "the framework",
      }),
      component: () => createElement("article", null, "body"),
    });

    const html = await drain(await app.handle("GET", "/post"));

    expect(html).toContain("<title>Keel ships</title>");
    expect(html).toContain('<meta name="description" content="the framework"');
  });

  it("renders extra meta and link tags from the metadata", async () => {
    const app = keel().page("/og", {
      metadata: () => ({
        meta: [{ property: "og:title", content: "Estates" }],
        links: [{ rel: "canonical", href: "https://example.com/og" }],
      }),
      component: () => createElement("div", null, "og"),
    });

    const html = await drain(await app.handle("GET", "/og"));

    expect(html).toContain('<meta property="og:title" content="Estates"');
    expect(html).toContain('<link rel="canonical" href="https://example.com/og"');
  });
});

describe("page layouts", () => {
  it("wraps the component in router layouts, outermost first", async () => {
    const app = keel()
      .layout(Outer)
      .layout(Inner)
      .page("/p", { component: () => createElement("span", null, "leaf") });

    const html = await drain(await app.handle("GET", "/p"));

    // Outer must enclose inner, which encloses the leaf.
    expect(html).toMatch(/<div id="outer"><div id="inner"><span>leaf<\/span><\/div><\/div>/);
  });

  it("composes a parent layout around a mounted sub-router's page", async () => {
    const sub = keel().page("/inner", { component: () => createElement("span", null, "x") });
    const app = keel().layout(Parent).route("/sub", sub);

    const html = await drain(await app.handle("GET", "/sub/inner"));

    expect(html).toMatch(/<div id="parent"><span>x<\/span><\/div>/);
  });
});

describe("page params (query validation)", () => {
  const Schema = z.object({ q: z.string() });

  it("validates the query and stashes the parsed value for load", async () => {
    const app = keel().page("/search", {
      params: Schema,
      load: (c) => ({ term: c.get<{ q: string }>("params")?.q }),
      component: (props) => createElement("p", null, String(props["term"])),
    });

    const html = await drain(await app.handle("GET", "/search", { query: { q: "homes" } }));

    expect(html).toContain("<p>homes</p>");
  });

  it("answers 400 when the query fails validation", async () => {
    const app = keel().page("/search", {
      params: Schema,
      component: () => createElement("p", null, "never"),
    });

    expect(await app.handle("GET", "/search")).toEqual({
      status: 400,
      headers: { "content-type": "text/plain" },
      body: "Bad Request",
    });
  });

  it("returns a fresh 400 each time, not a shared singleton (blocker #2)", async () => {
    const app = keel().page("/search", {
      params: Schema,
      component: () => createElement("p", null, "never"),
    });

    const first = (await app.handle("GET", "/search")) as { headers: Record<string, string> };
    first.headers["x-tainted"] = "leaked";

    const second = await app.handle("GET", "/search");
    expect(second).toEqual({
      status: 400,
      headers: { "content-type": "text/plain" },
      body: "Bad Request",
    });
  });
});

describe("page abort signal", () => {
  it("renders while forwarding the request's abort signal", async () => {
    const controller = new AbortController();
    const app = keel().page("/s", { component: () => createElement("p", null, "signal") });

    const html = await runWithContext({ requestId: "r", signal: controller.signal }, () =>
      app.handle("GET", "/s").then(drain),
    );

    expect(html).toContain("<p>signal</p>");
  });
});

// ---------------------------------------------------------------------------
// ADR 0011/0012: the head module tag (.client) + the render-time data resolver.
// ---------------------------------------------------------------------------

describe("keel().client() — head module tag", () => {
  it("emits the client module tag in the head of every page when set", async () => {
    const app = keel()
      .client("/client.js")
      .page("/", { component: () => createElement("main", null, "home") });

    const html = await drain(await app.handle("GET", "/"));

    expect(html).toContain('<script type="module" src="/client.js"></script>');
    // It is in the head, before the body content.
    expect(html.indexOf("/client.js")).toBeLessThan(html.indexOf("<body>"));
  });

  it("emits no module tag when .client() was never called", async () => {
    const app = keel().page("/", { component: () => createElement("main", null, "home") });

    expect(await drain(await app.handle("GET", "/"))).not.toContain('type="module"');
  });
});

// A shared source + a canonical ssr:true island that renders its count inline.
const reactions = defineDataSource<{ likes: number }>("reactions", { scope: "shared" });

const Reactions = defineIsland({
  name: "Reactions",
  ssr: true,
  component: (props) =>
    createElement("b", { className: "count" }, String((props.likes as { likes: number }).likes)),
  data: { likes: reactions },
});

describe("keel().data() + a defineIsland on a page (the canonical island)", () => {
  it("streams the island's real markup with inline data, a mount script, and no primer", async () => {
    const app = keel()
      .client("/client.js")
      .data(reactions, () => ({ likes: 7 }))
      .page("/posts", {
        component: () => createElement("main", null, createElement(Reactions, {})),
      });

    const html = await drain(await app.handle("GET", "/posts"));

    // The island's REAL server markup carries the resolved count…
    expect(html).toContain('class="count"');
    expect(html).toContain(">7<");
    // …the co-located mount script inlines the value, no bind…
    expect(html).toContain('"likes":{"likes":7}');
    expect(html).not.toContain('"bind"');
    // …no primer (data crossed the wire inline)…
    expect(html).not.toContain("__keelData");
    // …and the head module tag is present.
    expect(html).toContain('<script type="module" src="/client.js"></script>');
  });

  it("runs a source's loader once per request, with the request's context, across two islands", async () => {
    let runs = 0;
    let sawHeader: string | undefined;

    const Two = defineIsland({
      name: "Two",
      ssr: true,
      component: (props) =>
        createElement("i", null, String((props.likes as { likes: number }).likes)),
      data: { likes: reactions },
    });

    const app = keel()
      .data(reactions, (c: Context) => {
        runs += 1;
        sawHeader = c.header("x-probe");

        return { likes: 5 };
      })
      .page("/posts", {
        component: () =>
          createElement("main", null, createElement(Reactions, {}), createElement(Two, {})),
      });

    await drain(await app.handle("GET", "/posts", { headers: { "x-probe": "yes" } }));

    // Two islands bind one source → the memoized resolver runs the loader once.
    expect(runs).toBe(1);
    expect(sawHeader).toBe("yes");
  });

  it("contains an island bound to an unregistered source (WEB_UNKNOWN_DATA_SOURCE) — page still streams", async () => {
    const Orphan = defineIsland({
      name: "Orphan",
      ssr: true,
      component: (props) => createElement("span", { className: "orphan" }, String(props.likes)),
      fallback: () => createElement("span", { className: "orphan-fallback" }, "…"),
      data: { likes: defineDataSource<number>("never-registered") },
    });

    // The resolver throws WEB_UNKNOWN_DATA_SOURCE during the render inside the
    // island's Suspense boundary; React contains it to that boundary (its
    // fallback) and routes the error to the stream's onError sink (console).
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const app = keel().page("/posts", {
      component: () =>
        createElement(
          "main",
          null,
          "before",
          createElement(
            Suspense,
            { fallback: createElement("span", { className: "boundary-fallback" }, "loading") },
            createElement(Orphan, {}),
          ),
        ),
    });

    const response = await app.handle("GET", "/posts");

    // The page still streams (the shell flushed); the rest of the document is there.
    expect(response.status).toBe(200);
    const html = await drain(response);
    expect(html).toContain("before");

    // The coded error reached the stream's sink — observable, not silent undefined.
    const sawCoded = spy.mock.calls.some((args) =>
      args.some(
        (arg) =>
          arg instanceof Error && (arg as { code?: string }).code === "WEB_UNKNOWN_DATA_SOURCE",
      ),
    );
    expect(sawCoded).toBe(true);
  });
});

describe("private data → no-store page (review 2d)", () => {
  // `defineDataSource` defaults to scope: "private".
  const session = defineDataSource<{ name: string }>("session");

  const Greeting = defineIsland({
    name: "Greeting",
    ssr: true,
    component: (props) =>
      createElement("span", null, `Hi ${(props.user as { name: string }).name}`),
    data: { user: session },
  });

  it("stamps Cache-Control: private, no-store on a page that could inline a private source", async () => {
    const app = keel()
      .data(session, () => ({ name: "Ada" }))
      .page("/me", {
        component: () => createElement("main", null, createElement(Greeting, {})),
      });

    expect((await app.handle("GET", "/me")).headers["cache-control"]).toBe("private, no-store");
  });

  it("leaves a shared-only app's page cacheable (no cache-control header)", async () => {
    // `reactions` is scope: "shared" — no private source registered.
    const app = keel()
      .data(reactions, () => ({ likes: 1 }))
      .page("/posts", {
        component: () => createElement("main", null, createElement(Reactions, {})),
      });

    expect((await app.handle("GET", "/posts")).headers["cache-control"]).toBeUndefined();
  });

  it("a sub-app's private source makes the parent's pages no-store too (.route merge)", async () => {
    const sub = keel().data(session, () => ({ name: "Bo" }));

    const app = keel()
      .route(sub)
      .page("/p", { component: () => createElement("main", null, "x") });

    expect((await app.handle("GET", "/p")).headers["cache-control"]).toBe("private, no-store");
  });
});

describe("renderPageResponse — default (no resolver, no client module)", () => {
  it("renders the plain document when called with no island options", async () => {
    const c = new RequestCtx({
      method: "GET",
      path: "/",
      params: {},
      query: {},
      headers: {},
      body: undefined,
    });

    const response = await renderPageResponse(
      { component: () => createElement("main", null, "plain") },
      c,
      [],
    );

    const html = await drain(response as KeelResponse);

    expect(html).toContain("<main>plain</main>");
    // No IslandDataProvider wrap and no head module tag.
    expect(html).not.toContain('type="module"');
  });
});

describe("keel().route() — data loader merge", () => {
  it("resolves a sub-app's loader on a parent-mounted page", async () => {
    const sub = keel()
      .data(reactions, () => ({ likes: 11 }))
      .page("/posts", {
        component: () => createElement("main", null, createElement(Reactions, {})),
      });

    const app = keel().route(sub);

    const html = await drain(await app.handle("GET", "/posts"));

    expect(html).toContain('"likes":{"likes":11}');
    expect(html).toContain(">11<");
  });
});

describe("the server-render dialect (the matched pair)", () => {
  // A stand-in Preact `ServerRenderer`: real `preactServerRenderer` cannot consume
  // React's `createElement` output inside this React test process (that is the
  // whole reason CLI server-render stays React; full Preact SSR is estate's
  // whole-process-aliased bespoke path). This stub exercises the buffered BRANCH —
  // a `"preact"`-tagged renderer makes `renderPageResponse` return a string body.
  const bufferingPreactRenderer = {
    dialect: "preact" as const,
    renderToString: () => "<!doctype html><html><body><main>preact</main></body></html>",
    renderToStaticMarkup: () => "",
  };

  it("renders BUFFERED to a string under a preact-dialect renderer, not a stream", async () => {
    const app = keel()
      .renderer(bufferingPreactRenderer)
      .page("/p", { component: () => createElement("main", null, "preact") });

    const response = await app.handle("GET", "/p");

    // The Preact path returns a complete string body, not a ReadableStream — the
    // buffered fallback v1 takes under Preact (it has no streaming twin).
    expect(typeof response.body).toBe("string");
    expect(response.body as string).toContain("<main>preact</main>");
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
  });

  it("still STREAMS under the react dialect (a react renderer is the default path)", async () => {
    const app = keel()
      .renderer(reactServerRenderer)
      .page("/p", { component: () => createElement("main", null, "react") });

    const response = await app.handle("GET", "/p");

    // A react renderer does NOT switch to the buffered path — the body is a stream.
    expect(typeof response.body).not.toBe("string");
    expect(await drain(response)).toContain("<main>react</main>");
  });

  it("applyUiDialect returns the wired dialect for the client build", () => {
    const app = keel();

    expect(applyUiDialect(app, "preact")).toBe("preact");
    expect(app.serverDialect).toBe("preact");
  });

  it("a react app reports a react server dialect", () => {
    const app = keel();

    expect(applyUiDialect(app, "react")).toBe("react");
    expect(app.serverDialect).toBe("react");
  });

  it("an unconfigured app has no server dialect", () => {
    expect(keel().serverDialect).toBeUndefined();
  });

  it("re-selecting the SAME dialect is idempotent", () => {
    const app = keel().renderer(preactServerRenderer);

    expect(() => app.renderer(preactServerRenderer)).not.toThrow();
    expect(app.serverDialect).toBe("preact");
  });

  it("refuses a mismatched pair (client preact + server react) with a coded error", () => {
    const app = keel().renderer(reactServerRenderer);

    try {
      applyUiDialect(app, "preact");
      expect.unreachable();
    } catch (error) {
      expect((error as { code?: string }).code).toBe("WEB_DIALECT_MISMATCH");
    }
  });
});
