/**
 * Streaming page render — flush the shell, reveal `<Suspense>` content as it
 * resolves.
 *
 * `renderPageMarkup` (see `render.tsx`) buffers the whole document into one
 * string before a byte goes out. That is exactly right for a crawler or an SSG
 * build, which want the finished HTML — but it makes a human wait for the
 * slowest part of the page before seeing any of it. React 19's
 * `renderToReadableStream` (now a unified Node path as of React 19.2) flushes the
 * shell immediately and streams each `<Suspense>` boundary's content as its data
 * settles, so first paint no longer waits on the tail.
 *
 * This module is the streaming twin of `renderPageMarkup`, and it preserves the
 * SAME island/hydration contract:
 *
 *   - `renderToReadableStream` is a real React *server* renderer, so it emits the
 *     `<!-- -->` text-segment markers that `hydrateRoot` walks — the very markers
 *     `renderToStaticMarkup` strips and that `renderPageMarkup` reaches for
 *     `renderToString` to keep. A streamed page therefore lets an `ssr: true`
 *     island hydrate with no special casing: the markers are always present.
 *   - The island manifest is unchanged. The caller serializes `page.islands`
 *     into the document exactly as the buffered path does (the estate example's
 *     `<script id="keel-islands">`), and `bootstrapScriptContent`/`bootstrapModules`
 *     options let the shell carry the manifest + client bundle so hydration runs.
 *
 * Two exits, one render:
 *   - {@link renderPageStream} returns the live `ReadableStream` for humans.
 *   - {@link renderPageStreamToString} awaits `allReady` and drains the same
 *     stream to a complete string — the buffered path crawlers/SEO and SSG keep
 *     using. Its content equals the buffered renderer's; it just arrives via the
 *     streaming machinery so a single render configuration serves both audiences.
 *
 * The headers-already-sent constraint is structural, not a footnote: once
 * {@link renderPageStream}'s shell flushes, status and headers are on the wire and
 * cannot change. An error after that point can only be logged or the stream
 * aborted — which is precisely what the {@link StreamErrorSink} is for. A caller
 * that needs to *branch* on an error (a 500 page) must use the buffered exit,
 * where the whole document resolves before anything is sent.
 */

import type { ReactElement } from "react";
import { renderToReadableStream } from "react-dom/server";

import { UiError } from "./errors";
import type { Page } from "./render";

/**
 * Where a render error that surfaces *during streaming* goes.
 *
 * React calls `onError` for any error thrown while rendering — including inside a
 * `<Suspense>` boundary that resolves after the shell has flushed. By then the
 * status and headers are already on the wire, so the only honest responses are to
 * log it and/or let React abort the affected subtree (it substitutes the
 * boundary's fallback and surfaces the error to the client for a `hydrateRoot`
 * recovery). The sink is injectable so an app wires it to its logger and a test
 * can assert it fired without a real failure escaping.
 *
 * It mirrors React's own `onError(error, errorInfo)` signature so nothing is lost
 * in translation; `errorInfo` carries a `componentStack` when React has one.
 */
export type StreamErrorSink = (error: unknown, errorInfo: ErrorInfo) => void;

/** The diagnostic context React passes alongside a streamed render error. */
export interface ErrorInfo {
  componentStack?: string;
}

/**
 * Options for a streamed render.
 *
 * `onError` is the streamed-error sink (defaults to a `console.error` that names
 * the package, so an unhandled streaming error is never silent). `bootstrapModules`
 * and `bootstrapScriptContent` are passed straight through to React: the former
 * injects `<script type="module" src=…>` tags (the island client bundle) into the
 * shell, the latter an inline script (the serialized island manifest), so a
 * streamed page bootstraps hydration the same way a buffered document's shell does.
 */
export interface StreamOptions {
  onError?: StreamErrorSink;

  bootstrapModules?: readonly string[];

  bootstrapScriptContent?: string;

  /**
   * A caller/transport abort signal — typically a request's, fired when the
   * client disconnects. React keeps a suspended render (and the socket) alive
   * until its data settles; a disconnected client should cancel it, not pay for
   * a render no one will read. Chained with {@link renderTimeoutMs}: whichever
   * fires first aborts the render.
   */
  signal?: AbortSignal;

  /**
   * A hard render deadline in milliseconds. React ships NO default timeout, so a
   * slow or never-resolving `<Suspense>` boundary would hold the render and the
   * socket open indefinitely — a streaming DoS. When set, the render is aborted
   * past the deadline with a coded {@link UiError} `UI_STREAM_TIMEOUT` as the
   * abort reason, so `onError` can tell a timeout from a genuine render error.
   */
  renderTimeoutMs?: number;
}

/**
 * The slice of `renderToReadableStream` this module needs — its result.
 *
 * React's stream is a `ReadableStream` carrying one extra promise, `allReady`,
 * that settles when *every* `<Suspense>` boundary has resolved (the whole
 * document is rendered). The buffered exit awaits it; the streaming exit ignores
 * it (the shell is already flowing).
 */
export interface ReactRenderStream extends ReadableStream<Uint8Array> {
  allReady: Promise<void>;
}

/**
 * The `renderToReadableStream` seam.
 *
 * Named and injectable for one reason: `renderToReadableStream` is async and its
 * error/abort behavior is awkward to drive through the real renderer in a unit
 * test (a post-shell error needs a genuinely suspended, then-rejecting child).
 * A test substitutes a stand-in to exercise the `onError` plumbing and the
 * drain/`allReady` logic deterministically, while the default is the real React
 * renderer used in production.
 */
export type RenderToReadableStream = (
  element: ReactElement,
  options: {
    onError?: (error: unknown, errorInfo: ErrorInfo) => void;
    bootstrapModules?: string[];
    bootstrapScriptContent?: string;
    signal?: AbortSignal;
  },
) => Promise<ReactRenderStream>;

const reactRenderToReadableStream = renderToReadableStream as unknown as RenderToReadableStream;

/** Default sink: surface a streamed render error on the console, never swallow it. */
const consoleStreamError: StreamErrorSink = (error) => {
  console.error("[keel/ui] streamed render error", error);
};

/** A render's effective abort signal, plus `clear` to disarm its deadline timer. */
interface RenderAbort {
  signal: AbortSignal | undefined;

  clear: () => void;
}

/**
 * Fold the caller's abort signal and a render deadline into the single signal
 * handed to React.
 *
 * With no `timeoutMs` we pass the caller's signal straight through (or none) and
 * `clear` is a no-op. With a deadline we arm a timer that aborts the render with
 * a coded {@link UiError} `UI_STREAM_TIMEOUT` — a *typed* reason, so an `onError`
 * sink can tell "timed out" from a genuine render error — and chain the caller's
 * signal in: an already-aborted caller signal aborts at once, otherwise whichever
 * of timer/caller fires first wins. `clear` cancels the timer so a render that
 * finished in time leaves no pending deadline behind.
 */
function renderAbort(signal: AbortSignal | undefined, timeoutMs: number | undefined): RenderAbort {
  if (timeoutMs === undefined) {
    return { signal, clear: () => {} };
  }

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort(
      new UiError("UI_STREAM_TIMEOUT", `streamed render exceeded its ${timeoutMs}ms deadline`, {
        ms: timeoutMs,
      }),
    );
  }, timeoutMs);

  if (signal !== undefined) {
    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    }
  }

  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/**
 * Render a built {@link Page} to a live HTML stream that flushes the shell first.
 *
 * Returns a `ReadableStream<Uint8Array>` the transport pipes straight to the
 * socket: React writes the shell (everything outside an unresolved `<Suspense>`)
 * immediately, then streams each boundary's real content as its data settles.
 * The island manifest is unchanged — pass the client bundle via
 * `bootstrapModules` and the serialized manifest via `bootstrapScriptContent`
 * (or emit them yourself around the body) so an `ssr: true` island hydrates from
 * the streamed markup, whose text markers React's server renderer always emits.
 *
 * A page whose element degraded to `null` has nothing to render: we return an
 * already-closed empty stream rather than invoke React on nothing, mirroring
 * `renderPageMarkup`'s empty-string for the same case.
 *
 * Errors that surface *after* the shell flushes can only be logged/aborted (the
 * headers are gone) — they go to {@link StreamOptions.onError}. The returned
 * promise still rejects if the *shell itself* fails to render, because nothing
 * has been sent yet and the caller can choose a buffered error response.
 */
export async function renderPageStream(
  page: Page,
  options: StreamOptions = {},
  render: RenderToReadableStream = reactRenderToReadableStream,
): Promise<ReadableStream<Uint8Array>> {
  if (page.element === null) return emptyStream();

  const onError = options.onError ?? consoleStreamError;

  const aborter = renderAbort(options.signal, options.renderTimeoutMs);

  // Only forward optional fields React understands; `exactOptionalPropertyTypes`
  // forbids handing it `undefined`, so each is included only when present.
  const stream = await render(page.element, {
    onError,
    ...(aborter.signal !== undefined ? { signal: aborter.signal } : {}),
    ...(options.bootstrapModules !== undefined
      ? { bootstrapModules: [...options.bootstrapModules] }
      : {}),
    ...(options.bootstrapScriptContent !== undefined
      ? { bootstrapScriptContent: options.bootstrapScriptContent }
      : {}),
  });

  // Disarm the deadline once the whole document has settled (resolved, errored,
  // or aborted): the live stream may still be draining to a slow client, but the
  // render itself is done, so the timer has no more work. Both settle paths clear
  // it; we swallow any rejection here so an aborted/errored render never surfaces
  // as an unhandled rejection — the live stream's errors travel via `onError`.
  void Promise.resolve(stream.allReady).then(aborter.clear, aborter.clear);

  return stream;
}

/**
 * Render a built {@link Page} to a COMPLETE HTML string — the buffered exit.
 *
 * This is the crawler/SEO and SSG/prerender path: it awaits the stream's
 * `allReady` (every `<Suspense>` boundary resolved) and then drains the whole
 * stream to one string, so the bytes are identical in content to what a buffered
 * renderer would produce — the slow children are present, not their fallbacks.
 * Use it wherever a finished document is required and progressive reveal is not
 * (a bot that does not run JS, a static file written to disk).
 *
 * It deliberately shares the streaming render path rather than reaching for
 * `renderToString`, so a page renders byte-identically whether a human streams it
 * or a crawler buffers it — one render configuration, two audiences, no drift.
 * (`renderPageMarkup` remains the untouched, dependency-light buffered API for
 * callers that never opt into streaming at all; this is the buffered *exit of the
 * streaming path*.)
 *
 * COMPLETENESS IS NOT SILENT-BEST-EFFORT. `renderToReadableStream` resolves
 * `allReady` even when a `<Suspense>` boundary ERRORED — it does not reject. A
 * boundary that threw (or whose data rejected) is "switched to client rendering":
 * the drained string then holds React's error marker (`<!--$!-->`), a recovery
 * `<template data-msg="Switched to client rendering because the server rendering
 * errored: …">`, and the boundary's FALLBACK — never its real content. For the
 * cited audience (a no-JS crawler, a static file written to disk) that is degraded,
 * un-indexable markup with no second chance to recover on the client. So this exit
 * does NOT quietly return that string: it watches whether React reported an error
 * during the render and, once `allReady` settles, throws a coded
 * {@link UiError} `UI_STREAM_INCOMPLETE`. The SSG/crawler caller catches it and
 * falls back (a buffered error page, a retry, surfacing a real failure) instead of
 * persisting a half-rendered document. A caller that legitimately wants the live,
 * progressively-recovering stream uses {@link renderPageStream}, where an errored
 * boundary's client-recovery is the intended behavior. `options.onError` still
 * fires for every error (it is the caller's log sink); the throw is the additional,
 * load-bearing signal the string return cannot carry.
 *
 * A null-element page yields `""`, exactly like `renderPageMarkup`.
 *
 * @throws {UiError} `UI_STREAM_INCOMPLETE` if any boundary errored during the
 * render, so the drained string would be incomplete (recovery template + fallback,
 * not real content).
 */
export async function renderPageStreamToString(
  page: Page,
  options: StreamOptions = {},
  render: RenderToReadableStream = reactRenderToReadableStream,
): Promise<string> {
  if (page.element === null) return "";

  const sink = options.onError ?? consoleStreamError;

  // Wrap the caller's sink so we learn — without disturbing it — whether React
  // reported ANY error during this render. `renderToReadableStream` resolves
  // `allReady` even when a boundary errored (it switches that subtree to client
  // rendering rather than rejecting), so the flag, not the promise, is how the
  // buffered exit detects an incomplete document. The first error is captured for
  // the thrown error's `cause`; the caller's sink still sees every one.
  let renderError: unknown;

  let errored = false;

  const onError: StreamErrorSink = (error, errorInfo) => {
    if (!errored) {
      errored = true;
      renderError = error;
    }

    sink(error, errorInfo);
  };

  const aborter = renderAbort(options.signal, options.renderTimeoutMs);

  try {
    const stream = await render(page.element, {
      onError,
      ...(aborter.signal !== undefined ? { signal: aborter.signal } : {}),
      ...(options.bootstrapModules !== undefined
        ? { bootstrapModules: [...options.bootstrapModules] }
        : {}),
      ...(options.bootstrapScriptContent !== undefined
        ? { bootstrapScriptContent: options.bootstrapScriptContent }
        : {}),
    });

    // Wait for the entire document — including every suspended child — before
    // draining, so the buffered string holds the resolved content, not fallbacks.
    await stream.allReady;

    // A boundary errored: `allReady` still resolved, but the drained string would
    // be degraded (error marker + client-recovery template + fallback, not real
    // content). The buffered audience (crawler/SSG) cannot recover on the client,
    // so we refuse to hand back half-rendered HTML — throw a coded error the
    // caller can catch and fall back on, instead of silently writing it to disk.
    if (errored) {
      throw new UiError(
        "UI_STREAM_INCOMPLETE",
        "buffered streamed render is incomplete: a <Suspense> boundary errored, so the HTML " +
          "holds the fallback and a client-recovery marker, not the real content",
        { cause: renderError },
      );
    }

    return drainToString(stream);
  } finally {
    // Always disarm the deadline — on success, on UI_STREAM_INCOMPLETE, or on a
    // timeout/caller abort that rejected `allReady` — so no pending timer is left.
    aborter.clear();
  }
}

/** Drain a UTF-8 byte stream to a single string, releasing the reader at the end. */
async function drainToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();

  const decoder = new TextDecoder();

  let out = "";

  // A read loop, not `for await`: the Web stream reader is the lowest common
  // denominator across the runtimes this code targets, and `releaseLock` in a
  // `finally` guarantees the stream is not left locked even if decoding throws.
  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;

      out += decoder.decode(value, { stream: true });
    }

    // Flush any multibyte character left straddling the final chunk boundary.
    out += decoder.decode();

    return out;
  } finally {
    reader.releaseLock();
  }
}

/** An already-closed, empty byte stream — the null-element body. */
function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}
