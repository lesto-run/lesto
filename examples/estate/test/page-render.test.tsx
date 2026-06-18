/**
 * Pins estate's page-render seam — ADR 0008's wiring, estate's half.
 *
 * `buildEdgeApp` must honor an injected {@link ServerRenderer} end to end: that
 * is how the Worker renders Preact-matched markup inside its aliased bundle (see
 * worker.ts + wrangler.jsonc). A `.page` renders BUFFERED through the renderer's
 * `renderToString` when the dialect is Preact, and STREAMS React when no renderer
 * is given — both observed here.
 */

import { describe, expect, it } from "vitest";

import type { ServerRenderer } from "@volo/ui/server";

import { buildEdgeApp } from "../src/edge";

// >= 32 bytes: the secret-strength guard rejects shorter signing secrets.
const SECRET = "page-render-secret-0123456789abcdef";

/** Drain a `.page` body — a string under a buffered renderer, a stream under React. */
async function drain(body: unknown): Promise<string> {
  if (typeof body === "string") return body;

  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();

  let out = "";
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    out += decoder.decode(read.value, { stream: true });
  }

  return out + decoder.decode();
}

/**
 * A recording PREACT-dialect renderer with a sentinel output. `.page` takes the
 * buffered `renderToString` path only for the Preact dialect (React streams), so
 * a Preact-tagged fake is how we observe the injected renderer being used.
 */
function fakeRenderer(): { renderer: ServerRenderer; calls: string[] } {
  const calls: string[] = [];

  return {
    calls,
    renderer: {
      dialect: "preact" as const,
      renderToString: () => {
        calls.push("renderToString");

        return "<div>via-preact</div>";
      },
      renderToStaticMarkup: () => {
        calls.push("renderToStaticMarkup");

        return "<div>via-static-markup</div>";
      },
    },
  };
}

describe("buildEdgeApp page rendering — the injected dialect (the matched pair)", () => {
  it("renders BUFFERED through the injected Preact renderer (how the Worker speaks Preact)", async () => {
    const { renderer, calls } = fakeRenderer();

    const app = buildEdgeApp(SECRET, { serverRenderer: renderer });

    const response = await app.handle("GET", "/");

    expect(response.status).toBe(200);
    expect(await drain(response.body)).toContain("via-preact");
    // A `.page` uses renderToString for the buffered dialect — never renderToStaticMarkup.
    expect(calls).toEqual(["renderToString"]);
  });

  it("defaults to React STREAMING when no renderer is given (the in-process path)", async () => {
    const response = await buildEdgeApp(SECRET).handle("GET", "/");

    expect(response.status).toBe(200);

    const html = await drain(response.body);
    expect(html).toContain("Jade Mills Estates");
    expect(html).toContain("data-volo-island");
    expect(html).not.toContain("via-preact");
  });
});
