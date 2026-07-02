/**
 * The `react-dom/server` shim for the OPT-IN `--preact` build of estate's SSR WORKER.
 *
 * `@lesto/ui/server`'s barrel pulls its render/stream modules (`renderToStaticMarkup`,
 * `renderToString`, `renderToReadableStream`) into the worker graph — `worker.ts`
 * imports `@lesto/ui/server` for `preactServerRenderer` — and React's real
 * `react-dom/server` runs top-level bootstrap (`ReactDOMSharedInternals.d`) that
 * throws once `react` is aliased away to Preact. On the Preact path the worker renders
 * through `preact-render-to-string` (`preactServerRenderer`), not this module, so we
 * alias the `react-dom/server` entry to these inert stubs: they exist so the import
 * resolves and the module's top-level code is harmless. Only the worker aliases
 * `react-dom/server` here (`wrangler.jsonc`); the CLIENT bundle never imports the
 * `@lesto/ui/server` surface that drags the renderers in, so `build-client.ts` carries
 * no `react-dom/server` entry. The default React build keeps the real module.
 */

/** No-op `react-dom/server` exports — present to satisfy the import, never invoked on the Preact path. */
export function renderToStaticMarkup(): string {
  return "";
}

export function renderToString(): string {
  return "";
}

export function renderToReadableStream(): ReadableStream {
  return new ReadableStream();
}
