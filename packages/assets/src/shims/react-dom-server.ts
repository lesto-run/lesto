/**
 * The `react-dom/server` shim for the Preact client dialect (ADR 0007/0011).
 *
 * `@keel/ui`'s barrel pulls its render/stream modules (`renderToStaticMarkup`,
 * `renderToString`, `renderToReadableStream`) into the client graph, and React's
 * real `react-dom/server` runs top-level bootstrap that throws once `react` is
 * aliased to Preact. Server rendering is never invoked on the client — the
 * browser only HYDRATES — so the server entry resolves to these inert stubs:
 * present so the import resolves and the module's top-level code is harmless.
 * The React build keeps the real module.
 */

/** No-op `react-dom/server` exports — present to satisfy the import, never called on the client. */
export function renderToStaticMarkup(): string {
  return "";
}

export function renderToString(): string {
  return "";
}

export function renderToReadableStream(): ReadableStream {
  return new ReadableStream();
}
