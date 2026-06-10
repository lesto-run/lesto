import { createElement } from "react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { runWithContext } from "../src/context";
import { keel } from "../src/keel";
import type { KeelResponse } from "../src/types";

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
