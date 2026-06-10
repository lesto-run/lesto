/**
 * The `react-dom/server` shim for the OPT-IN `--preact` client bundle.
 *
 * `@keel/ui`'s barrel pulls its render/stream modules (`renderToStaticMarkup`,
 * `renderToString`, `renderToReadableStream`) into the client graph, and React's
 * real `react-dom/server` runs top-level bootstrap (`ReactDOMSharedInternals.d`)
 * that throws once `react` is aliased away to Preact. Server rendering is never
 * invoked on the client — the browser only ever HYDRATES — so we alias the
 * server entry to these inert stubs. They exist so the import resolves and the
 * module's top-level code is harmless; calling them on the client would be a bug
 * the client path never commits. The default React build keeps the real module.
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
