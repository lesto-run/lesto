import { createElement, Suspense, use } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { island, Registry, UiError } from "../src/index";
import type { ClientComponentDef, ComponentDef } from "../src/index";
import { renderPage, renderPageMarkup } from "../src/server";
import { renderPageStream, renderPageStreamToString } from "../src/stream";
import type { Page, ReactRenderStream, RenderToReadableStream } from "../src/server";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const Box: ComponentDef = {
  name: "Box",
  props: {},
  children: true,
  render: (_props, children) => createElement("div", { className: "box" }, children),
};

// An `ssr: true` island whose render interpolates text — TWO adjacent text
// segments under one parent (`'Hi, ', name`). React delimits them with `<!-- -->`
// markers that hydrateRoot walks; a streamed render (a real server renderer) must
// emit those markers or an ssr island would mismatch on the common text shape.
const Greet: ClientComponentDef = {
  name: "Greet",
  ssr: true,
  props: { name: { type: "string", required: true } },
  component: (props) => createElement("p", null, "Hi, ", props.name as string, "!"),
};

function registry(): Registry {
  return new Registry().define(Box).defineClient(Greet);
}

/** Drain a UTF-8 byte stream to a single string (the test's own reader). */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();

  const decoder = new TextDecoder();

  let out = "";

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;

    out += decoder.decode(value, { stream: true });
  }

  out += decoder.decode();

  reader.releaseLock();

  return out;
}

/**
 * A page built directly from a React element, bypassing the tree walk.
 *
 * Streaming `<Suspense>` is a React-level feature with no node-tree equivalent in
 * the registry vocabulary, so the cleanest fixture is a hand-built {@link Page}
 * carrying the element under test plus an empty manifest. The manifest-driven
 * island path is exercised through the real `renderPage` fixtures below.
 */
function pageOf(element: ReactElement | null): Page {
  return { element, errors: [], islands: [] };
}

/**
 * A promise that rejects, with the global unhandled-rejection slot disarmed.
 *
 * The error fixtures suspend a child on this promise so React surfaces the
 * failure *during streaming* (the post-shell case onError exists for). React
 * does read and handle the rejection, but it adopts a fresh `.then` on it — the
 * ORIGINAL promise's rejection can still trip Node's unhandled-rejection tracker
 * in the test's timing. Attaching a noop `.catch` to a separate reference marks
 * the rejection handled at the source while the live reference React reads still
 * rejects, so the behavior under test is unchanged and the test stays quiet.
 */
function rejectingPromise(message: string): Promise<never> {
  const promise = Promise.reject<never>(new Error(message));

  promise.catch(() => undefined);

  return promise;
}

/** A child that suspends, then fails — the post-shell streaming error case. */
function boomElement(): ReactElement {
  const Boom = (): ReactElement => {
    use(rejectingPromise("kaboom"));

    return createElement("p", null, "never");
  };

  return createElement(
    "div",
    null,
    createElement("h1", null, "shell"),
    createElement(Suspense, { fallback: createElement("p", null, "loading") }, createElement(Boom)),
  );
}

/**
 * A stand-in renderer that reports TWO errors, then closes empty.
 *
 * Drives the buffered exit's error-capture wrapper through the case React itself
 * is awkward to force deterministically: more than one boundary erroring in a
 * single render. The wrapper must latch the FIRST error as the thrown cause and
 * still forward both to the caller's sink.
 */
const renderTwoErrors: RenderToReadableStream = async (_element, options) => {
  options.onError?.(new Error("first"), {});
  options.onError?.(new Error("second"), {});

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  }) as ReactRenderStream;

  stream.allReady = Promise.resolve();

  return stream;
};

// ---------------------------------------------------------------------------
// Shell-first streaming: the shell flushes before a suspended child resolves.
// ---------------------------------------------------------------------------

describe("renderPageStream — shell flushes before a suspended child", () => {
  it("emits the shell first, then the suspended boundary's content when it settles", async () => {
    // A child that suspends on a promise we control: the shell must reach the
    // stream before this resolves, proving progressive (not buffered) delivery.
    let release!: () => void;

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const Slow = (): ReactElement => {
      use(gate);

      return createElement("p", { id: "slow" }, "resolved");
    };

    const shell = createElement(
      "div",
      null,
      createElement("h1", { id: "shell" }, "shell"),
      createElement(
        Suspense,
        { fallback: createElement("p", { id: "fb" }, "loading") },
        createElement(Slow),
      ),
    );

    const stream = await renderPageStream(pageOf(shell));

    const reader = stream.getReader();
    const decoder = new TextDecoder();

    // The first read carries the shell + the boundary's FALLBACK — the slow child
    // has not resolved yet, so its real content cannot be in this flush.
    const first = await reader.read();
    const firstChunk = decoder.decode(first.value, { stream: true });

    expect(firstChunk).toContain('id="shell"');
    expect(firstChunk).toContain('id="fb"');
    expect(firstChunk).not.toContain('id="slow"');

    // Now let the child resolve and drain the rest: the real content arrives in a
    // later flush, with the script React uses to swap the fallback for it.
    release();

    let rest = "";

    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;

      rest += decoder.decode(value, { stream: true });
    }

    rest += decoder.decode();

    reader.releaseLock();

    expect(rest).toContain("resolved");
  });
});

// ---------------------------------------------------------------------------
// Buffered (allReady) exit: complete HTML, equal-in-content to the buffered path.
// ---------------------------------------------------------------------------

// A child that suspends on an already-resolved promise: allReady still gates the
// drain until React has woven its content in — the buffered-exit canary.
const ResolvedSlow = (): ReactElement => {
  use(Promise.resolve());

  return createElement("p", { id: "slow" }, "resolved");
};

describe("renderPageStreamToString — buffered allReady exit", () => {
  it("waits for a suspended child so the buffered string holds resolved content", async () => {
    const shell = createElement(
      "div",
      null,
      createElement("h1", null, "shell"),
      createElement(
        Suspense,
        { fallback: createElement("p", null, "loading") },
        createElement(ResolvedSlow),
      ),
    );

    const html = await renderPageStreamToString(pageOf(shell));

    // The resolved content is present, not the fallback — proof allReady was awaited.
    expect(html).toContain("resolved");
    expect(html).toContain("shell");
  });

  it("yields HTML equal in content to the buffered renderer for a static page", async () => {
    const page = renderPage(registry(), { type: "Box", children: ["hello"] });

    const buffered = renderPageMarkup(page);
    const streamed = await renderPageStreamToString(page);

    // Same content. The streamed serializer (a real server renderer) and
    // renderToStaticMarkup differ only in markup React adds for hydration, which
    // a no-island static page has none of — so the bodies match byte-for-byte.
    expect(streamed).toBe(buffered);
    expect(streamed).toContain("hello");
  });

  it("returns the same body as renderToString for an ssr-island page", async () => {
    const page = renderPage(registry(), {
      type: "Box",
      children: [island("Greet", { name: "Ada" })],
    });

    const streamed = await renderPageStreamToString(page);

    // The streamed buffered exit carries the hydration markers, exactly like the
    // renderToString path renderPageMarkup uses for an ssr page.
    expect(streamed).toContain("Hi, <!-- -->Ada<!-- -->!");
    expect(streamed).toBe(renderToString(page.element as ReactElement));
  });
});

// ---------------------------------------------------------------------------
// Buffered exit refuses a degraded (errored-boundary) render.
//
// React's renderToReadableStream RESOLVES allReady even when a <Suspense> child
// errored (it switches that subtree to client rendering). The drained string then
// holds the error marker + a client-recovery <template> + the FALLBACK — never the
// real content. For the buffered audience (a no-JS crawler, an SSG file on disk)
// that is degraded markup with no client to recover on, so the buffered exit must
// fail loudly rather than return it.
// ---------------------------------------------------------------------------

describe("renderPageStreamToString — incomplete render on an errored boundary", () => {
  it("throws UI_STREAM_INCOMPLETE instead of returning fallback+recovery markup", async () => {
    // The injected sink still fires (it is the caller's log), AND the call throws.
    const onError = vi.fn();

    const error = await renderPageStreamToString(pageOf(boomElement()), { onError }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(UiError);
    expect((error as UiError).code).toBe("UI_STREAM_INCOMPLETE");
    // The original render error is preserved as the cause for the caller's fallback.
    expect((error as UiError).details.cause).toBeInstanceOf(Error);
    expect(((error as UiError).details.cause as Error).message).toBe("kaboom");

    // The caller's sink saw the error too — the throw is an ADDITIONAL signal the
    // string return cannot carry, not a replacement for the log sink.
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("keeps the FIRST error as the cause when several boundaries error", async () => {
    // Two boundaries error in one render. The thrown error's cause must be the
    // first one (the flag latches), and the caller's sink still sees both — this
    // also drives the `errored`-already-true arm of the capture wrapper.
    const onError = vi.fn();

    const page = renderPage(registry(), { type: "Box", children: ["x"] });

    const error = await renderPageStreamToString(page, { onError }, renderTwoErrors).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(UiError);
    expect((error as UiError).code).toBe("UI_STREAM_INCOMPLETE");
    expect(((error as UiError).details.cause as Error).message).toBe("first");

    // Both errors reached the caller's sink — the wrapper observes, never swallows.
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("documents the degraded markup it refuses: fallback + client-recovery template", async () => {
    // Pin the exact behavior the throw guards against: drive the SAME render
    // through the live stream (renderPageStream), whose contract IS to recover on
    // the client, and confirm it produces fallback + the recovery <template> and
    // NOT the real content — the markup the buffered exit must never return.
    const stream = await renderPageStream(pageOf(boomElement()), { onError: vi.fn() });

    const html = await readAll(stream);

    expect(html).toContain("loading"); // the fallback, not the real child
    expect(html).not.toContain("never"); // the real content is absent
    expect(html).toContain("<!--$!-->"); // React's errored-boundary marker
    expect(html).toContain("Switched to client rendering"); // the recovery template
  });
});

// ---------------------------------------------------------------------------
// Island hydration markers survive streaming.
// ---------------------------------------------------------------------------

describe("renderPageStream — ssr island hydration markers", () => {
  it("carries the <!-- --> text-segment markers an ssr island needs to hydrate", async () => {
    const page = renderPage(registry(), {
      type: "Box",
      children: [island("Greet", { name: "Ada" })],
    });

    const stream = await renderPageStream(page);

    const html = await readAll(stream);

    // The markers a fresh renderToStaticMarkup would strip are present in the
    // streamed output — so an ssr:true island hydrates against streamed markup.
    expect(html).toContain("Hi, <!-- -->Ada<!-- -->!");
    expect(html).toContain('data-lesto-island="$.children[0]"');
    expect(html).not.toBe(renderToStaticMarkup(page.element as ReactElement));
  });
});

// ---------------------------------------------------------------------------
// Bootstrap options: the manifest + client bundle ride into the shell.
// ---------------------------------------------------------------------------

describe("renderPageStream — bootstrap options", () => {
  it("injects bootstrapModules and bootstrapScriptContent into the streamed shell", async () => {
    const page = renderPage(registry(), { type: "Box", children: ["x"] });

    const stream = await renderPageStream(page, {
      bootstrapModules: ["/client.js"],
      bootstrapScriptContent: 'window.__lesto = "ok"',
    });

    const html = await readAll(stream);

    expect(html).toContain("/client.js");
    expect(html).toContain('window.__lesto = "ok"');
  });

  it("forwards the same bootstrap options through the buffered exit", async () => {
    const page = renderPage(registry(), { type: "Box", children: ["x"] });

    const html = await renderPageStreamToString(page, {
      bootstrapModules: ["/client.js"],
      bootstrapScriptContent: 'window.__lesto = "ok"',
    });

    expect(html).toContain("/client.js");
    expect(html).toContain('window.__lesto = "ok"');
  });
});

// ---------------------------------------------------------------------------
// onError: fires on a throwing child; defaults to a console sink.
// ---------------------------------------------------------------------------

describe("renderPageStream — onError sink", () => {
  it("routes a throwing suspended child to the injected onError sink", async () => {
    const onError = vi.fn();

    // A child that suspends, then rejects: the error surfaces during streaming,
    // after the shell — React can only report it to onError and abort the subtree.
    const stream = await renderPageStream(pageOf(boomElement()), { onError });

    // Drain so React runs the boundary to completion and calls onError.
    await readAll(stream);

    expect(onError).toHaveBeenCalledTimes(1);

    const [error] = onError.mock.calls[0] ?? [];

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("kaboom");
  });

  it("defaults onError to a console sink that names the package", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const stream = await renderPageStream(pageOf(boomElement()));

    await readAll(stream);

    expect(spy).toHaveBeenCalledWith("[lesto/ui] streamed render error", expect.any(Error));

    spy.mockRestore();
  });

  it("defaults onError on the buffered exit too (and still throws on the errored boundary)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // The buffered exit throws UI_STREAM_INCOMPLETE on an errored boundary; the
    // default console sink still fires on the way through.
    await expect(renderPageStreamToString(pageOf(boomElement()))).rejects.toBeInstanceOf(UiError);

    expect(spy).toHaveBeenCalledWith("[lesto/ui] streamed render error", expect.any(Error));

    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Null-element pages: empty stream / empty string, no React invoked.
// ---------------------------------------------------------------------------

describe("renderPageStream — degraded (null element) page", () => {
  it("returns an already-closed empty stream for a null-element page", async () => {
    // An unknown root component degrades to a null element — nothing to stream.
    const page = renderPage(registry(), { type: "DoesNotExist" });

    expect(page.element).toBeNull();

    // The injected render must NEVER be called: there is no element to render.
    const render = vi.fn();

    const stream = await renderPageStream(page, {}, render as unknown as RenderToReadableStream);

    expect(render).not.toHaveBeenCalled();
    expect(await readAll(stream)).toBe("");
  });

  it("returns an empty string for a null-element page on the buffered exit", async () => {
    const page = renderPage(registry(), { type: "DoesNotExist" });

    const render = vi.fn();

    expect(
      await renderPageStreamToString(page, {}, render as unknown as RenderToReadableStream),
    ).toBe("");
    expect(render).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Injected render seam: drive the bootstrap-absent branch and a multibyte
// boundary deterministically through a stand-in renderer.
// ---------------------------------------------------------------------------

describe("renderPageStream — injected render seam", () => {
  it("omits bootstrap fields when the caller sets none", async () => {
    let seen: Parameters<RenderToReadableStream>[1] | undefined;

    const fakeRender: RenderToReadableStream = async (_element, options) => {
      seen = options;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("<shell>"));
          controller.close();
        },
      }) as ReactRenderStream;

      stream.allReady = Promise.resolve();

      return stream;
    };

    const page = renderPage(registry(), { type: "Box", children: ["x"] });

    const stream = await renderPageStream(page, {}, fakeRender);

    expect(await readAll(stream)).toBe("<shell>");

    // No bootstrap keys present (not merely undefined) — exactOptionalPropertyTypes
    // means the spread added nothing, only onError.
    if (seen === undefined) expect.unreachable("render seam was not called");

    expect("bootstrapModules" in seen).toBe(false);
    expect("bootstrapScriptContent" in seen).toBe(false);
    expect(typeof seen.onError).toBe("function");
  });

  it("drains a multibyte chunk boundary correctly in the buffered exit", async () => {
    // Split a 4-byte emoji across two chunks: the decoder's streaming mode plus the
    // final flush must reassemble it — proving drainToString handles partial
    // multibyte runes at a chunk edge.
    const bytes = new TextEncoder().encode("✓ ok");

    const fakeRender: RenderToReadableStream = async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, 1));
          controller.enqueue(bytes.slice(1));
          controller.close();
        },
      }) as ReactRenderStream;

      stream.allReady = Promise.resolve();

      return stream;
    };

    const page = renderPage(registry(), { type: "Box", children: ["x"] });

    expect(await renderPageStreamToString(page, {}, fakeRender)).toBe("✓ ok");
  });
});

// ---------------------------------------------------------------------------
// Render deadline + abort signal: a framework-owned timeout and a caller/
// transport signal (a client disconnect) chained into React's render.
// ---------------------------------------------------------------------------

/** A closed stream whose `allReady` is settled on demand, to drive cleanup timing. */
function gatedStream(): { stream: ReactRenderStream; settle: () => void } {
  let settle!: () => void;

  const allReady = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  }) as ReactRenderStream;

  stream.allReady = allReady;

  return { stream, settle };
}

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("renderPageStream — render deadline + abort signal", () => {
  it("passes a caller signal straight through when no deadline is set", async () => {
    const ac = new AbortController();

    let seen: Parameters<RenderToReadableStream>[1] | undefined;

    const render: RenderToReadableStream = async (_element, options) => {
      seen = options;

      const { stream, settle } = gatedStream();
      settle();

      return stream;
    };

    await renderPageStream(pageOf(createElement("p", null, "x")), { signal: ac.signal }, render);

    // No timeout: the caller's exact signal is forwarded, not a wrapper around it.
    expect(seen?.signal).toBe(ac.signal);
  });

  it("arms a deadline that aborts the render with UI_STREAM_TIMEOUT", async () => {
    let seen: Parameters<RenderToReadableStream>[1] | undefined;

    // `allReady` never settles, so the deadline — not completion — ends the render.
    const render: RenderToReadableStream = async (_element, options) => {
      seen = options;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }) as ReactRenderStream;

      stream.allReady = new Promise<void>(() => undefined);

      return stream;
    };

    await renderPageStream(pageOf(createElement("p", null, "x")), { renderTimeoutMs: 5 }, render);

    await tick(20);

    const signal = seen?.signal;
    if (signal === undefined) expect.unreachable("render seam received no signal");

    expect(signal.aborted).toBe(true);
    expect((signal.reason as UiError).code).toBe("UI_STREAM_TIMEOUT");
  });

  it("aborts immediately when the caller signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort(new Error("already gone"));

    let seen: Parameters<RenderToReadableStream>[1] | undefined;

    const render: RenderToReadableStream = async (_element, options) => {
      seen = options;

      const { stream, settle } = gatedStream();
      settle(); // resolves allReady so the cleanup clears the (long) deadline timer

      return stream;
    };

    await renderPageStream(
      pageOf(createElement("p", null, "x")),
      { signal: ac.signal, renderTimeoutMs: 60_000 },
      render,
    );

    await tick(0);

    expect(seen?.signal?.aborted).toBe(true);
  });

  it("chains a later caller abort (a client disconnect) into the render", async () => {
    const ac = new AbortController();

    const { stream, settle } = gatedStream();

    let seen: Parameters<RenderToReadableStream>[1] | undefined;

    const render: RenderToReadableStream = async (_element, options) => {
      seen = options;

      return stream;
    };

    await renderPageStream(
      pageOf(createElement("p", null, "x")),
      { signal: ac.signal, renderTimeoutMs: 60_000 },
      render,
    );

    const signal = seen?.signal;
    if (signal === undefined) expect.unreachable("render seam received no signal");

    // Not yet aborted: neither the deadline nor the caller has fired.
    expect(signal.aborted).toBe(false);

    ac.abort(new Error("client disconnected"));

    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).message).toBe("client disconnected");

    settle(); // settle allReady so the deadline timer is cleared, leaving none pending
    await tick(0);
  });

  it("clears the deadline when the live render settles, even if allReady rejects", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }) as ReactRenderStream;

    // A rejecting allReady must clear the deadline (the reject arm of the cleanup)
    // and never surface as an unhandled rejection.
    stream.allReady = Promise.reject(new Error("aborted"));

    const render: RenderToReadableStream = async () => stream;

    const out = await renderPageStream(
      pageOf(createElement("p", null, "x")),
      { renderTimeoutMs: 60_000 },
      render,
    );

    expect(await readAll(out)).toBe("");

    await tick(0); // let the cleanup microtask run: no dangling timer, no unhandled rejection
  });

  it("forwards a deadline through the buffered exit and clears it on completion", async () => {
    let seen: Parameters<RenderToReadableStream>[1] | undefined;

    const render: RenderToReadableStream = async (_element, options) => {
      seen = options;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("<ok>"));
          controller.close();
        },
      }) as ReactRenderStream;

      stream.allReady = Promise.resolve();

      return stream;
    };

    const html = await renderPageStreamToString(
      pageOf(createElement("p", null, "x")),
      { renderTimeoutMs: 60_000 },
      render,
    );

    expect(html).toBe("<ok>");
    // A deadline wrapper signal was handed to the render, and the `finally` cleared
    // its timer (no dangling 60s timer hangs the test).
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });
});
