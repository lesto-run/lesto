/**
 * The `notFound()` render signal — the file-route convention's "this URL matched a
 * route, but the thing it addresses does not exist".
 *
 * It lives in its OWN module rather than in `file-routes.ts` so that BOTH the
 * file-route boundary machinery (`file-routes.ts`) and the page renderer
 * (`render-page.tsx`) can recognize the signal WITHOUT importing each other:
 * `file-routes.ts` already imports `render-page.ts` (for `wrap`), so the renderer
 * importing back would be a module cycle. One symbol, one class, one detector,
 * shared — no cycle, no duplicated brand to drift.
 */

/**
 * The brand key — a GLOBAL-registry symbol (`Symbol.for`) so the signal is
 * recognizable even across two copies of this module (the monorepo-dual-install
 * hazard the coded-error brand guards against too).
 */
const NOT_FOUND_SIGNAL = Symbol.for("lesto.file-route.notFound");

/** A thrown `notFound()` signal — branded so a boundary (and the renderer) catches ONLY it. */
export class NotFoundSignal extends Error {
  readonly [NOT_FOUND_SIGNAL] = true;

  constructor() {
    super("notFound() was called");

    this.name = "NotFoundSignal";
  }
}

/**
 * Signal "this matched route addresses nothing" from a page (or layout) component's
 * RENDER, or from its `load` loader — either way the response carries a real HTTP
 * 404, and under React streaming SSR the nearest `not-found.tsx` boundary still
 * recovers the view on the client.
 *
 * Throws the {@link NotFoundSignal} sentinel. Use it where the resource a resolved
 * route names is absent — read the loaded value and call it if missing:
 * `if (props.row === undefined) notFound();`. Returns `never`, so TypeScript
 * narrows the value as present after the call.
 *
 * Two paths, one honest 404 (F18 — see `render-page.tsx`):
 *   - From **render**: under React's streaming SSR the shell still flushes and the
 *     nearest `not-found.tsx` boundary recovers on the CLIENT after hydration, so a
 *     JS client sees the 404 view — AND the renderer now sets the response STATUS
 *     to 404 (via the stream's error sink), so a crawler / no-JS client sees a real
 *     404 rather than an empty 200.
 *   - From **`load`**: the loader runs before the component (and its boundary)
 *     exist, so it cannot render that boundary — but the renderer catches the
 *     signal and answers a plain 404, not the 500 an uncaught throw would become.
 *     Prefer calling `notFound()` from render (return the absence to the component)
 *     when you want the styled `not-found.tsx` view.
 */
export function notFound(): never {
  throw new NotFoundSignal();
}

/** True iff `value` is the branded `notFound()` sentinel (never an ordinary error). */
export function isNotFoundSignal(value: unknown): value is NotFoundSignal {
  return value instanceof Error && NOT_FOUND_SIGNAL in value;
}
