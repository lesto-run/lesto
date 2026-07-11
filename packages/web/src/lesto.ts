/**
 * `lesto()` — the code-first router that registers API routes AND pages on one
 * composable surface.
 *
 *   const app = lesto()
 *     .use(requestId())
 *     .get("/api/listings/:id", (c) => c.json(getListing(+c.param("id"))))
 *     .post("/api/listings", (c) => c.json(create(c.valid(NewListing)), 201))
 *     .layout(SiteChrome)
 *     .page("/listings/:id", { load, component: ListingScene })
 *     .route("/admin", adminRoutes);
 *
 *   await app.handle("GET", "/api/listings/3");   // { status: 200, body: "…" }
 *
 * One pattern for everything. An API route is a chain of handlers
 * `(c, next) => response | void`, the same shape whether a handler answers the
 * request or wraps the rest of the chain. A page is the same kind of route whose
 * terminal handler renders a React component (see `render-page.tsx`); `.use`
 * middleware wraps it, `.layout` components nest around it. `.route` mounts a
 * sub-router, composing the parent's middleware AND layouts (and an optional path
 * prefix) around the child's routes — so a feature slice in its own module slots
 * in without losing the enclosing app's chrome or guards. The builder owns no
 * transport: `handle(method, path, options)` is the pure dispatch the runtime and
 * the edge adapter both feed.
 */

import { formatTraceparent } from "@lesto/observability";
import { RouteTable } from "@lesto/router";
import type { Match } from "@lesto/router";
import { createSourceResolver, dataSourceHref } from "@lesto/ui";
import type { DataSource } from "@lesto/ui";
import { reactServerRenderer } from "@lesto/ui/server";
import type { ServerRenderer } from "@lesto/ui/server";

import { BROWSER_SPANS_ROUTE, browserSpansHandler, defaultBrowserSpanSink } from "./browser-spans";
import type { BrowserSpanSink } from "./browser-spans";
import { CLIENT_ERRORS_ROUTE, clientErrorsHandler, defaultClientErrorSink } from "./client-errors";
import type { ClientErrorSink } from "./client-errors";
import { currentRequestSpan } from "./context";
import { WebError } from "./errors";
import { Context } from "./handler-context";
import type { TypedResponse } from "./handler-context";
import type { Middleware, Next } from "./middleware";
import { renderPageResponse } from "./render-page";
import type { Layout, PageDef, RenderPageOptions } from "./render-page";
import type { AnyLestoResponse, HandleOptions, LestoRequest, LestoResponse } from "./types";

type MaybePromise<T> = T | Promise<T>;

/**
 * A unit of request handling: it receives the context and a `next` that runs the
 * inner chain. Return a response to answer; return nothing to fall through to
 * `next` (whether or not you called it). Generic in the route's path so
 * `c.param(...)` is typed to the pattern's `:param` names.
 */
export type Handler<Path extends string = string> = (
  c: Context<Path>,
  next: Next,
) => MaybePromise<AnyLestoResponse | void>;

/**
 * Adapt a request-shaped {@link Middleware} into a {@link Handler}.
 *
 * The security batteries (`@lesto/cors`, `@lesto/ratelimit`, `@lesto/csrf`, and the
 * `secureStack` that bundles them) are written against the request-and-next
 * contract — they read the request's headers/method and either answer or delegate.
 * That is exactly a handler minus the context wrapper, so the bridge is to hand
 * the middleware the context's request: `app.use(fromRequestMiddleware(cors()))`.
 * One adapter keeps those packages unchanged while they run in the new chain.
 */
export function fromRequestMiddleware(middleware: Middleware): Handler {
  return (c, next) => middleware(c.req, next);
}

/**
 * A page's own payload: its definition, the layouts wrapping it (outermost first),
 * and the file-route middleware guarding it (outermost first).
 *
 * `guards` are run BEFORE the page's loader, in order: a guard may answer outright
 * (a redirect / 403 — short-circuiting the load) or fall through (return nothing),
 * having optionally augmented the shared {@link Context} with `c.set(...)` for the
 * loader to read. Empty for a hand-written `.page()` and for a file-routed page with
 * no `middleware.ts` above it — identical behavior to a guard-free page.
 */
interface PagePayload {
  def: PageDef;

  layouts: readonly Layout[];

  guards: readonly Handler[];
}

/**
 * A registered route: its verb, full pattern, the middleware wrapping it
 * (outermost first), and what it runs — either inline handlers (an API route) or
 * a page payload (rendered by a terminal page handler). Keeping middleware and
 * the route's own work separate lets `.route` recompose both when mounting.
 */
interface CollectedRoute {
  method: string;

  pattern: string;

  middleware: readonly Handler[];

  own: readonly Handler[] | PagePayload;
}

const isPage = (own: readonly Handler[] | PagePayload): own is PagePayload => !Array.isArray(own);

/**
 * A fresh 404 response.
 *
 * A FACTORY, not a shared constant. A single shared `NOT_FOUND` object is a
 * cross-request leak: app middleware that mutates the response it sees (sets a
 * cookie, adds a header) would mutate the one 404 every subsequent unmatched
 * request returns — bleeding one client's headers into the next. Each unmatched
 * request gets its own object, with its own `headers` record, so a mutation
 * cannot outlive the request that made it.
 */
const notFound = (): LestoResponse => ({
  status: 404,
  headers: { "content-type": "text/plain" },
  body: "Not Found",
});

/** The terminal for an unmatched request — a fresh plain 404, run after any app-level middleware. */
const notFoundHandler: Handler = () => notFound();

/**
 * A terminal that re-raises `error` — used when a path is unroutable because a
 * param failed to decode (a malformed percent-encoding). It runs LAST, after the
 * app's global middleware, so a CORS preflight and a rate-limit still see the
 * request (the {@link Lesto.handle} invariant); the coded error then propagates to
 * the transport, which maps it to a 400 — exactly as it does for an error thrown
 * deeper in the chain.
 */
const raisingHandler =
  (error: unknown): Handler =>
  () => {
    throw error;
  };

/**
 * The `Allow` header value for a known path: its registered methods, plus `HEAD`
 * whenever `GET` is present.
 *
 * A route registered for `GET` also answers `HEAD` (RFC 9110 §9.1 makes the pair a
 * MUST — see {@link headResponseHandler}), so `HEAD` belongs in the advertised set
 * even though no explicit `HEAD` route exists. Everything else is listed verbatim,
 * in resolution order, comma-joined.
 */
const allowHeaderValue = (methods: readonly string[]): string => {
  const list =
    methods.includes("GET") && !methods.includes("HEAD") ? [...methods, "HEAD"] : [...methods];

  return list.join(", ");
};

/**
 * The terminal for a known path hit with an unsupported verb — a 405 carrying the
 * `Allow` header (RFC 9110 §15.5.6), run after the app's global middleware like the
 * 404 terminal. A FACTORY (not a shared constant) for the same cross-request-leak
 * reason {@link notFound} is: middleware that mutates the response it sees must not
 * poison the object every later 405 returns.
 */
const methodNotAllowedHandler =
  (allow: string): Handler =>
  () => ({
    status: 405,
    headers: { "content-type": "text/plain", allow },
    body: "Method Not Allowed",
  });

/**
 * A terminal that answers a `HEAD` by running the path's `GET` chain and dropping
 * the body — the RFC 9110 §9.1 MUST that a resource answering `GET` also answers
 * `HEAD`, with identical headers and no body (§9.3.2).
 *
 * `getChain` is the GET route's already-composed chain (its app middleware baked
 * in), so it runs EXACTLY as the GET would — same guards, same headers, same
 * status — and we return that response with an empty body. It is only reached when
 * no explicit `HEAD` route matched the path, so a hand-registered HEAD still wins.
 */
const headResponseHandler =
  (getChain: readonly Handler[]): Handler =>
  async (c) => {
    const response = await runChain(getChain, c);

    return { ...response, body: "" };
  };

/**
 * Run a handler chain over a context, returning the response it produces.
 *
 * Each layer gets a memoized `next`: a handler may answer (return a response),
 * delegate explicitly (`return next()`), or simply fall through (return nothing),
 * in which case the runner advances for it. `next` is memoized per layer, so a
 * handler that both `await next()`s and falls through never runs the inner chain
 * twice. An exhausted chain — every layer fell through without answering — yields
 * a 404, the honest "matched a route but nothing handled it" outcome.
 */
function runChain(chain: readonly Handler[], c: Context): Promise<AnyLestoResponse> {
  const run = async (index: number): Promise<AnyLestoResponse> => {
    const handler = chain[index];

    if (handler === undefined) return notFound();

    let advanced: Promise<AnyLestoResponse> | undefined;
    const next: Next = () => (advanced ??= run(index + 1));

    const response = await handler(c, next);

    return response === undefined ? next() : response;
  };

  return run(0);
}

export class Lesto {
  // Insertion order is resolution order; the matcher is built lazily from this.
  private readonly collected: CollectedRoute[] = [];

  // Middleware added with `.use`, applied to every route registered afterward.
  private readonly useChain: Handler[] = [];

  // Layout components added with `.layout`, wrapping every page registered afterward.
  private readonly layoutChain: Layout[] = [];

  // Each registered data source's loader, keyed by source name (ADR 0012). The
  // per-request render-time resolver runs these; last registration wins, the same
  // rule the auto-route registration follows. `.route()` merges a sub-app's map.
  private readonly dataLoaders = new Map<string, (c: Context) => MaybePromise<unknown>>();

  // Whether any registered source is `private`-scoped (review 2d). A page render
  // that could inline private data is stamped no-store; tracked here so the
  // renderer (which sees only the resolver, not the sources' scopes) can decide.
  private hasPrivateData = false;

  // The app's client module src (`.client("/client.js")`), emitted as the head
  // module tag on every page when set (ADR 0011, amended 2026-06-11). Undefined =
  // no client runtime, no tag.
  private clientModuleSrc: string | undefined;

  // The app's framework stylesheet src (`.styles("/styles.css")`), emitted as the
  // head `<link rel="stylesheet">` on every page when set (ADR 0037) — the matched
  // sibling of `clientModuleSrc`. A STABLE constant (the CSS build's `/styles.css`,
  // written beside `/client.js`), baked into the worker JS so it resolves the same
  // on node and the edge. Undefined = no framework stylesheet, no tag.
  private clientStylesSrc: string | undefined;

  // The server-render dialect (ADR 0008's matched pair). Undefined = React
  // streaming (the default). Set to a Preact `ServerRenderer` (via `.renderer()`)
  // when the client bundle is built under the `preact/compat` alias, so an
  // `ssr: true` island's server markup is the dialect its client hydrates
  // against. The CLI sets this from the single `ui.dialect` key that ALSO drives
  // the client alias — the two are never wired independently.
  private serverRenderer: ServerRenderer | undefined;

  // The app-level streamed-render deadline (ms), set via `.renderDeadline()`.
  // Undefined = the renderer's DEFAULT_RENDER_DEADLINE_MS. Threaded into every
  // page render so a slow-data app can lengthen the bound, or a latency-sensitive
  // one tighten it, without forking the renderer.
  private renderDeadlineMs: number | undefined;

  // Where the client-error beacon (`POST /__lesto/client-errors`, registered as a
  // built-in below) forwards its normalized events. Defaults to the structured-log
  // sink; `.clientErrors(sink)` swaps it (the observability wave wires OTLP here).
  // The route reads this field at request time, so an override set after
  // construction still takes effect.
  private clientErrorSink: ClientErrorSink = defaultClientErrorSink;

  // Where the browser-RUM receiver (`POST /__lesto/browser-spans`, registered as a
  // built-in below) forwards each normalized browser span. Defaults to the
  // structured-log sink; `.browserSpans(sink)` swaps it to `traces.seams.onBrowserSpan`
  // so a navigation/resource/vital span lands in the SAME collector as the server
  // spans, joined by trace id (ARCHITECTURE.md §7's UI→API→DB trace). Read per
  // request, so an override set after construction still takes effect.
  private browserSpanSink: BrowserSpanSink = defaultBrowserSpanSink;

  // The compiled matcher, rebuilt on demand and invalidated whenever a route is added.
  private table: RouteTable<readonly Handler[]> | undefined;

  private add(method: string, pattern: string, own: readonly Handler[] | PagePayload): this {
    this.collected.push({ method, pattern, middleware: [...this.useChain], own });

    this.table = undefined;

    return this;
  }

  /** Register middleware that wraps every route declared after this call. */
  use(...handlers: Handler[]): this {
    this.useChain.push(...handlers);

    return this;
  }

  /** Register a layout that wraps every page declared after this call, outermost first. */
  layout(layout: Layout): this {
    this.layoutChain.push(layout);

    return this;
  }

  get<P extends string>(path: P, ...handlers: Handler<P>[]): this {
    return this.add("GET", path, handlers as readonly Handler[]);
  }

  post<P extends string>(path: P, ...handlers: Handler<P>[]): this {
    return this.add("POST", path, handlers as readonly Handler[]);
  }

  put<P extends string>(path: P, ...handlers: Handler<P>[]): this {
    return this.add("PUT", path, handlers as readonly Handler[]);
  }

  patch<P extends string>(path: P, ...handlers: Handler<P>[]): this {
    return this.add("PATCH", path, handlers as readonly Handler[]);
  }

  delete<P extends string>(path: P, ...handlers: Handler<P>[]): this {
    return this.add("DELETE", path, handlers as readonly Handler[]);
  }

  /**
   * Register a page at `path`, wrapped in the layouts declared so far.
   *
   * `guards` are file-route middleware that run BEFORE the page's loader, in the
   * order given (outermost first): each may answer outright (a redirect / 403 —
   * short-circuiting the load) or fall through, having optionally augmented the
   * request {@link Context} via `c.set(...)` for the loader to read. They are an
   * internal seam the file-route applier uses to compose a page's `middleware.ts`
   * chain; a hand-written `.page()` passes none and behaves exactly as before. The
   * guards run inside the page route, AFTER any app-level `.use()` middleware.
   */
  page<P extends string, Loaded, Search = unknown>(
    path: P,
    def: PageDef<P, Loaded, Search>,
    guards: readonly Handler<P>[] = [],
  ): this {
    // The public def is typed over its loaded shape (so the component's props are
    // inferred) AND its validated-search shape (so `load`'s second argument is
    // typed); storage is over the erased `PageDef`. A React component is
    // contravariant in its props, so a specific def is not directly assignable to
    // the open one — the erasure is deliberate and lives only at this boundary.
    return this.add("GET", path, {
      def: def as unknown as PageDef,
      layouts: [...this.layoutChain],
      guards: guards as readonly Handler[],
    });
  }

  /**
   * Register a data source's loader and auto-expose it at `GET /__lesto/data/<name>`
   * (ADR 0010 — island data sources).
   *
   * The loader runs with the request context; its return is the DTO an island
   * bound to this source (`defineClient({ data: { … } })`) receives as a prop.
   * The framework delivers it without a waterfall: inline in the document when
   * the page is dynamically rendered, or fetched from this route — parallel with
   * `client.js` via the parse-time primer — when the page is static. Registered
   * like any route, so the `.use` middleware declared so far wraps it too. Return
   * an allowlisted DTO only: never the session token or raw cookie (ADR 0010 §5).
   *
   * The response carries a cache header keyed by the source's `scope` (ADR 0010
   * §3a): a `private` source is `no-store`, a `shared` one is
   * `public, max-age=0, must-revalidate`. A per-user JSON GET with NO cache
   * header is heuristically shared-cacheable — a session leak waiting for a CDN —
   * and `Vary: Cookie` is not honored by Cloudflare's cache, so "do not store" is
   * the only defense for per-user JSON; the framework never emits the bare GET.
   *
   * `guards` are file-route middleware (`@lesto/web`'s {@link RouteMiddleware}, the
   * same `Handler` chain {@link page} takes) that run BEFORE the loader, outermost
   * first — so a source bound by an island on a GUARDED page is reached over a route
   * that enforces the SAME guard chain protecting the page document. This closes the
   * data-route bypass: without it, the per-user data an island fetches (the data most
   * worth protecting) would ride the LEAST-protected route — a page's auth
   * `middleware.ts` covers only its document GET, never the separate
   * `/__lesto/data/<name>` route. Pass the SAME guard chain that protects the page
   * binding the source (the file-route applier composes that chain from the page's
   * `middlewareDepth` — {@link RouteMiddleware}); an app declaring `.data()` by hand
   * passes the guards the source needs.
   *
   * SECURE BY DEFAULT (ADR 0010 §5a): a `scope: "private"` source serves per-user
   * data, so registering it with NO guards is refused with a coded {@link WebError}
   * (`WEB_PRIVATE_DATA_UNGUARDED`) at registration time — before any request — UNLESS
   * the source is declared `access: "request-scoped"` ({@link DataSource}), the
   * explicit opt-out stating its loader reads only the caller's own request (a
   * "who am I" session) and so leaks nothing unguarded. The decision lives at the
   * `.data()` call (a guard chain) or on the token (`request-scoped`), never in an
   * easy-to-forget omission. App-level `.use()` middleware does NOT exempt the source
   * — it is global and ordering-dependent and may not be a guard, so it cannot stand
   * in for the explicit per-source decision. A `scope: "shared"` source is publicly
   * cacheable by construction and needs no guards.
   */
  data<T>(
    source: DataSource<T>,
    loader: (c: Context) => MaybePromise<T>,
    guards: readonly Handler[] = [],
  ): this {
    // Fail closed: a per-user source on the unguarded auto-route is the red-team
    // bypass (L-f82d573b). Refuse it at registration unless guarded here or the
    // token opts out as request-scoped. `access` may be absent on a hand-built
    // token (the type requires it, but a cast can omit it), so anything that is
    // not the explicit opt-out requires guards — the secure reading.
    if (source.scope !== "shared" && source.access !== "request-scoped" && guards.length === 0) {
      const name = source.name;

      throw new WebError(
        "WEB_PRIVATE_DATA_UNGUARDED",
        // Teach the fix, don't just refuse: name the source + route + risk, point at
        // the ADR, and give BOTH remedies as copy-pasteable code with this source's
        // own name filled in. The dev should be able to act without leaving the error.
        `data source "${name}" is scope:"private" but .data() received no guards — its ${dataSourceHref(name)} route would serve per-user data over a route a page's middleware.ts never reaches (ADR 0010 §5a). Close it one of two ways:\n` +
          `  1. pass the page's guard chain as the 3rd argument — .data(source, loader, [yourGuard]); or\n` +
          `  2. if the loader reads ONLY the caller's own request (e.g. a "who am I" session), declare the source safe — defineDataSource("${name}", { access: "request-scoped" }).`,
        { source: name },
      );
    }

    const cacheControl =
      source.scope === "shared" ? "public, max-age=0, must-revalidate" : "private, no-store";

    // Record the loader for the render-time resolver (ADR 0012) — last
    // registration wins, mirroring the auto-route's "last write wins" below — in
    // addition to registering the fetch route the primer/`visible` tier needs.
    this.dataLoaders.set(source.name, loader as (c: Context) => MaybePromise<unknown>);

    // A private source means any page inlining it must not be shared-cached (2d).
    if (source.scope !== "shared") {
      this.hasPrivateData = true;
    }

    // The guards run AFTER the app-level `.use` middleware (which `.get` prepends)
    // and BEFORE the loader — the same order a page's file-route guards run in its
    // chain (`chainOf`: `[...middleware, ...guards, pageHandler]`). A guard that
    // answers (a redirect / 403) short-circuits the loader; one that falls through
    // (returns nothing) advances the chain to it.
    return this.get(dataSourceHref(source.name), ...guards, async (c) => {
      const response = c.json(await loader(c));

      return { ...response, headers: { ...response.headers, "cache-control": cacheControl } };
    });
  }

  /**
   * Declare the app's client runtime module, emitted as a `<script type="module"
   * src=…>` in every page's `<head>` (ADR 0011, amended 2026-06-11).
   *
   * It is CONFIG-DRIVEN, not island-gated, on purpose: streaming flushes the
   * `<head>` before the body renders, so a page cannot retroactively gate a head
   * tag on whether it grew an island. Declaring the client module once is also
   * the right altitude — shipping a client runtime is an app-level fact, not a
   * per-page guess. An island-less page on a client-configured app pays one
   * cached, deferred module fetch; the alternative (buffering the body to detect
   * islands) would forfeit streaming.
   */
  client(src: string): this {
    this.clientModuleSrc = src;

    return this;
  }

  /**
   * Declare the app's framework stylesheet, emitted as a `<link rel="stylesheet"
   * href=…>` in every page's `<head>` (ADR 0037) — the matched sibling of
   * {@link client}.
   *
   * Like `.client(...)`, it is CONFIG-DRIVEN, not page-gated: a styled app ships the
   * stylesheet on every page (a streamed `<head>` flushes before the body renders, so
   * a tag cannot be retroactively gated on what a page used). The value is a STABLE
   * constant — the CSS build's `/styles.css`, written beside `/client.js` — baked into
   * the worker JS exactly like the client module, so it resolves identically on node
   * and the Cloudflare edge (which has no request-time asset manifest). A page's own
   * `metadata.links` stays for additional stylesheets; an identical `/styles.css`
   * there collapses to one (deduped by rel+href).
   */
  styles(src: string): this {
    this.clientStylesSrc = src;

    return this;
  }

  /**
   * Select the server-render dialect (ADR 0008's matched pair).
   *
   * Pass the Preact `ServerRenderer` (`@lesto/ui/server-preact`'s `preactServerRenderer`)
   * when this app's client bundle is built under the `react`→`preact/compat`
   * alias, so an `ssr: true` island's SERVER markup is the dialect its client
   * hydrates against — mismatch the two and every `ssr: true` island re-renders
   * on hydration. Unset (the default) is React streaming.
   *
   * It is the matched pair because ONE input chooses both halves: the CLI reads
   * the single `ui.dialect` key and, via {@link applyUiDialect}, calls this AND
   * builds the client under the matching alias — never one without the other. An
   * app that wires its own bespoke worker (estate) calls this directly with the
   * same renderer its build aliases to.
   *
   * Calling it twice with renderers of DIFFERENT dialects is a wiring bug — the
   * matched pair would be ambiguous — and is refused with a coded
   * {@link WebError} (`WEB_DIALECT_MISMATCH`). Re-selecting the same dialect is
   * idempotent.
   */
  renderer(serverRenderer: ServerRenderer): this {
    if (
      this.serverRenderer !== undefined &&
      this.serverRenderer.dialect !== serverRenderer.dialect
    ) {
      throw new WebError(
        "WEB_DIALECT_MISMATCH",
        `the app's server renderer is already "${this.serverRenderer.dialect}"; ` +
          `cannot also select "${serverRenderer.dialect}" — the matched pair must agree`,
        { existing: this.serverRenderer.dialect, requested: serverRenderer.dialect },
      );
    }

    this.serverRenderer = serverRenderer;

    return this;
  }

  /**
   * Set the hard deadline (ms) for this app's streamed page renders — the
   * app-level override of the renderer's `DEFAULT_RENDER_DEADLINE_MS` (10s).
   *
   * React ships no render timeout, so a hung `<Suspense>` boundary would hold the
   * socket open indefinitely; this is the bound that aborts it (chained with the
   * request's own abort signal, whichever fires first). An app fronting a slow
   * data tier raises it; a latency-sensitive one tightens it. A non-positive value
   * is a wiring bug — a zero/negative deadline would abort every render before it
   * began — and is refused with a coded {@link WebError} (`WEB_BAD_RENDER_DEADLINE`).
   * Only the React streaming path observes it; the Preact buffered path has no
   * streaming twin to bound.
   */
  renderDeadline(ms: number): this {
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new WebError(
        "WEB_BAD_RENDER_DEADLINE",
        `render deadline must be a positive number of milliseconds; got ${ms}`,
        { ms },
      );
    }

    this.renderDeadlineMs = ms;

    return this;
  }

  /**
   * Override where the client-error beacon (`POST /__lesto/client-errors`) forwards
   * its events.
   *
   * The route is a built-in — registered for every app — so this only swaps its
   * SINK; the default is a structured-log sink. The observability wave wires this
   * to OTLP (`onClientError → tracer`), so a hydration failure in a real browser
   * becomes an operator-visible event paired with the server-side traces. The
   * route stays PII-free regardless of the sink: only component names and counts
   * ever reach it.
   */
  clientErrors(sink: ClientErrorSink): this {
    this.clientErrorSink = sink;

    return this;
  }

  /**
   * Override where the browser-RUM receiver (`POST /__lesto/browser-spans`)
   * forwards its normalized spans.
   *
   * The route is a built-in — registered for every app — so this only swaps its
   * SINK; the default is a structured-log sink. The canonical wiring points it at
   * `traces.seams.onBrowserSpan`, so a browser navigation/resource/web-vital span
   * lands in the SAME OTLP collector as the server `http.request` span, joined by
   * the trace id the page adopted from the SSR-injected `lesto-traceparent` meta —
   * the UI→API→DB trace ARCHITECTURE.md §7 promises. The route stays PII-free
   * regardless of the sink: only same-origin paths, timing numbers, and vital
   * values ever reach it.
   */
  browserSpans(sink: BrowserSpanSink): this {
    this.browserSpanSink = sink;

    return this;
  }

  /** The server-render dialect this app emits, or `undefined` for the React default. */
  get serverDialect(): UiDialect | undefined {
    return this.serverRenderer?.dialect;
  }

  /**
   * Mount a sub-router, optionally under a path prefix.
   *
   * Each of the child's routes is re-registered here with its pattern prefixed
   * and the parent's current middleware (and, for a page, layouts) composed around
   * it — outermost — so a feature slice declared in its own module slots in
   * without losing the enclosing app's middleware or chrome.
   *
   * The sub-app's data loaders (ADR 0012) are merged into the parent's map, the
   * sub's winning on a name collision — last-write-wins, consistent with
   * `.data()` itself.
   *
   * KNOWN LIMITATION (ADR 0010 corrections #8): a prefixed mount prefixes the data
   * *route* but a bound island's `bind.href` still points at root
   * (`/__lesto/data/<name>`). Register data sources on the ROOT app. A prefix-aware
   * href is future work.
   */
  route(sub: Lesto): this;
  route(prefix: string, sub: Lesto): this;
  route(prefixOrSub: string | Lesto, maybeSub?: Lesto): this {
    const prefix = typeof prefixOrSub === "string" ? prefixOrSub : "";
    const sub = typeof prefixOrSub === "string" ? (maybeSub as Lesto) : prefixOrSub;

    for (const route of sub.collected) {
      this.collected.push({
        method: route.method,
        pattern: prefix + route.pattern,
        middleware: [...this.useChain, ...route.middleware],
        own: isPage(route.own)
          ? {
              def: route.own.def,
              layouts: [...this.layoutChain, ...route.own.layouts],
              // A page's file-route guards ride along unchanged when its sub-app is
              // mounted — they run inside the page route, after the (now-merged)
              // app-level middleware, exactly as they did in the sub-app.
              guards: route.own.guards,
            }
          : route.own,
      });
    }

    // Merge the sub's loaders; the sub wins on collision (last-write-wins).
    for (const [name, loader] of sub.dataLoaders) {
      this.dataLoaders.set(name, loader);
    }

    // A sub-app's private source makes the parent's pages no-store too (2d).
    if (sub.hasPrivateData) {
      this.hasPrivateData = true;
    }

    this.table = undefined;

    return this;
  }

  /** Every registered route's verb + pattern, in resolution order, for inspection. */
  routes(): ReadonlyArray<{ method: string; pattern: string }> {
    return this.collected.map((route) => ({ method: route.method, pattern: route.pattern }));
  }

  /**
   * Resolve and run a request, returning its response.
   *
   * Matches method + path once, builds the {@link Context} with the captured
   * params, and runs the route's handler chain. No match still runs the app's
   * top-level `.use` middleware (wrapping the terminal below), so global concerns —
   * a CORS preflight to an unrouted `OPTIONS`, a rate-limit on an unknown path —
   * are answered for every request, matched or not.
   *
   * Three miss outcomes, distinguished so the status is honest (RFC 9110):
   *   - **`HEAD` with a `GET` route but no explicit `HEAD`** — a resource that
   *     answers `GET` MUST also answer `HEAD` (§9.1), so we run the GET chain and
   *     drop the body ({@link headResponseHandler}), rather than 404 it.
   *   - **A known path hit with an unsupported verb** — a 405 carrying an `Allow`
   *     header of the path's methods (§15.5.6), NOT a 404.
   *   - **A genuinely unknown path** — the plain 404 as before.
   *
   * A path that fails to route because a param is a malformed percent-encoding
   * (`match` throws a coded `ROUTER_MALFORMED_PARAM`) still runs the global
   * middleware around a terminal that re-raises the coded error, so it reaches the
   * transport as a 400 without slipping past CORS/rate-limit. The declared return
   * is the string-bodied {@link LestoResponse} dispatch contract; a handler may
   * produce a wider body (bytes, a stream — a page streams its HTML), which the
   * transport, not this contract, writes — so it is narrowed back here.
   */
  async handle(method: string, path: string, options?: HandleOptions): Promise<LestoResponse> {
    const matcher = this.matcher();

    let match: Match<readonly Handler[]> | undefined;
    let headMatch: Match<readonly Handler[]> | undefined;
    let malformed: unknown;

    try {
      match = matcher.match(method, path);
    } catch (error) {
      // A malformed percent-encoded param can't be routed, but global middleware
      // must still see the request — defer the coded refusal to a terminal below.
      // (Only `.match` can throw here, and only `ROUTER_MALFORMED_PARAM`; a bad
      // pattern fails earlier in `matcher()`, outside this try, as before.)
      malformed = error;
    }

    // No explicit route answered a HEAD: fall back to the path's GET route (RFC 9110
    // §9.1 — GET implies HEAD). A malformed param on THAT route defers to the same
    // coded refusal, so a bad `HEAD /q/%zz` still surfaces a 400, not a 404.
    if (match === undefined && malformed === undefined && method === "HEAD") {
      try {
        headMatch = matcher.match("GET", path);
      } catch (error) {
        malformed = error;
      }
    }

    const request: LestoRequest = {
      method,
      path,
      // A miss carries no params; keep it NULL-PROTOTYPE like a match's params (see
      // `RouteTable.match`) so `c.param("constructor")` is `undefined`, not a method.
      // A HEAD fallback carries the matched GET route's params.
      params:
        (match ?? headMatch)?.params ??
        (Object.create(null) as Record<string, string | string[]>),
      query: options?.query ?? {},
      headers: options?.headers ?? {},
      body: options?.body,
      ...(options?.rawBody === undefined ? {} : { rawBody: options.rawBody }),
      ...(options?.rawBytes === undefined ? {} : { rawBytes: options.rawBytes }),
    };

    let chain: readonly Handler[];

    if (match !== undefined) {
      // A direct match runs its baked chain (middleware + handler/page) unchanged.
      chain = match.value;
    } else if (headMatch !== undefined) {
      // The GET chain already carries the app middleware; do NOT re-wrap it in
      // `useChain` — `headResponseHandler` runs it and strips the body.
      chain = [headResponseHandler(headMatch.value)];
    } else if (malformed !== undefined) {
      // A malformed-param path: global middleware runs around a re-raise (a 400).
      chain = [...this.useChain, raisingHandler(malformed)];
    } else {
      // A known path hit with an unsupported verb is a 405 + `Allow`; only a path
      // no route matches at all is a 404. Either terminal still runs the global
      // middleware, so CORS/rate-limit see every request.
      const allowed = matcher.allowedMethods(path);

      chain = [
        ...this.useChain,
        allowed.length === 0
          ? notFoundHandler
          : methodNotAllowedHandler(allowHeaderValue(allowed)),
      ];
    }

    const response = await runChain(chain, new Context(request));

    return response as LestoResponse;
  }

  /**
   * The terminal handler for a page route: render its component, wrapped in its
   * layouts, with the per-request render-time data resolver and the head module
   * tag (ADR 0011 + 0012).
   *
   * The resolver is built PER REQUEST and closes over that request's context, so
   * a loader sees the live request. It is memoized by source name (one loader run
   * per source per request, shared by every island that binds it). A bind on a
   * source that was never registered is a wiring bug: the resolver throws a coded
   * {@link WebError} (`WEB_UNKNOWN_DATA_SOURCE`) rather than silently feeding the
   * island `undefined`; the render error path contains it to that island.
   */
  private pageHandler(payload: PagePayload): Handler {
    // A static (prerendered, cacheable) page resolves NO per-request data at
    // render: its islands must fetch their per-user data on the client (bind +
    // primer), or a build-time value would be baked into the cached HTML for
    // every visitor (auth-aware static — ADR 0010/0012, `PageDef.static`). A
    // dynamic page (the default) gets the render-time resolver, so its islands
    // inline their data with no client waterfall.
    const isStatic = payload.def.static === true;

    // The per-route opt-out of the app-wide `private` cache cliff (ADR 0010 §3a).
    // `this.hasPrivateData` is an APP-WIDE flag — registering any private source
    // flips it — so without an override EVERY dynamic page on the app is stamped
    // `private, no-store`, even an island-free marketing page that inlines nothing
    // private. A page that declares `cache: "public"` asserts its island graph
    // binds no private source (the author knows it; the framework can't, since the
    // component is an arbitrary React function and a streamed page can't report
    // what it inlined before its headers flush), so its document keeps the default
    // cacheable policy. `"auto"`/unset follows the safe app-wide rule.
    const privateData = payload.def.cache === "public" ? false : this.hasPrivateData;

    return (c) => {
      const options: RenderPageOptions = {
        privateData,
        ...(this.clientModuleSrc === undefined ? {} : { clientModule: this.clientModuleSrc }),
        ...(this.clientStylesSrc === undefined ? {} : { clientStyles: this.clientStylesSrc }),
        ...(this.serverRenderer === undefined ? {} : { serverRenderer: this.serverRenderer }),
        ...(this.renderDeadlineMs === undefined ? {} : { renderDeadlineMs: this.renderDeadlineMs }),
      };

      if (!isStatic) {
        // The browser→server trace join (ARCHITECTURE.md §7): when a tracer is
        // wired, the runtime publishes this request's span on the context, so we
        // stamp its `traceparent` into the page head and the browser RUM runtime
        // adopts the trace id. Only a DYNAMIC page does this — a static page is
        // prerendered with no live request span, and baking one request's trace id
        // into cached HTML would mis-join every later visitor. Absent a span
        // (tracing off), no meta is emitted.
        const span = currentRequestSpan();

        if (span !== undefined) {
          options.traceparent = formatTraceparent(span.data.traceId, span.data.spanId);
        }

        options.resolver = createSourceResolver((name) => {
          const loader = this.dataLoaders.get(name);

          if (loader === undefined) {
            throw new WebError(
              "WEB_UNKNOWN_DATA_SOURCE",
              `island bound to data source "${name}", which no .data() registered`,
              { source: name },
            );
          }

          return loader(c);
        });
      }

      return renderPageResponse(payload.def, c, payload.layouts, options);
    };
  }

  /**
   * The full handler chain a route runs: its app-level middleware, then — for a page
   * — its file-route guards (which run before the loader and may short-circuit), then
   * its own work (the page render, or an API route's inline handlers).
   *
   * A page's guards precede its terminal so a redirect-before-load guard answers
   * before any render begins; a guard that falls through leaves its `c.set(...)` in
   * the context the loader then reads. An API route carries no guards.
   */
  private chainOf(route: CollectedRoute): readonly Handler[] {
    const own = isPage(route.own) ? [...route.own.guards, this.pageHandler(route.own)] : route.own;

    return [...route.middleware, ...own];
  }

  private matcher(): RouteTable<readonly Handler[]> {
    if (this.table === undefined) {
      const table = new RouteTable<readonly Handler[]>();

      for (const route of this.collected) {
        table.add(route.method, route.pattern, this.chainOf(route));
      }

      // The client-error beacon receiver is a BUILT-IN: registered into the
      // matcher (not `collected`) so every app accepts the browser's
      // hydration-failure beacon out of the box, WITHOUT leaking into
      // `routes()` — the surface `openapi`/`mcp` enumerate and `.route()` merges,
      // neither of which should see an internal endpoint. Added LAST, and the
      // table resolves first-match-wins, so a user route declared at the same path
      // overrides this default. Wrapped in the app's top-level middleware so the
      // security batteries cover it; the handler reads `this.clientErrorSink` per
      // request, so `.clientErrors()` swaps the sink even after the table is built.
      table.add("POST", CLIENT_ERRORS_ROUTE, [
        ...this.useChain,
        clientErrorsHandler((event) => this.clientErrorSink(event)),
      ] as readonly Handler[]);

      // The browser-RUM span receiver is a BUILT-IN too, registered the same way
      // (into the matcher, not `collected`, so it never leaks into `routes()` and
      // is overridable by a user route at the same path). Wrapped in the app's
      // top-level middleware so the security batteries cover it; the handler reads
      // `this.browserSpanSink` per request, so `.browserSpans()` swaps the sink even
      // after the table is built. This is the server end of the UI→API→DB trace
      // (ARCHITECTURE.md §7): the browser's navigation/resource/vital spans land
      // here and route to the exporter, joined to the server trace by trace id.
      table.add("POST", BROWSER_SPANS_ROUTE, [
        ...this.useChain,
        browserSpansHandler((span) => this.browserSpanSink(span)),
      ] as readonly Handler[]);

      this.table = table;
    }

    return this.table;
  }
}

/** Start a new code-first router. */
export function lesto(): Lesto {
  return new Lesto();
}

/**
 * Which component runtime an app's UI is built for (ADR 0007/0008). The single
 * `ui.dialect` config key the CLI reads; it drives BOTH the client bundle's
 * `react`→`preact/compat` alias AND the server renderer, as one matched pair.
 */
export type UiDialect = "react" | "preact";

/**
 * Wire a single `ui.dialect` key onto a `lesto()` app as ADR 0008's matched pair,
 * returning the dialect the caller must ALSO build the client bundle for.
 *
 * This is the one place the two halves are chosen together: it sets the app's
 * server renderer to the dialect's renderer and hands back that same dialect, so
 * a caller (the CLI) feeds the identical value to the client build — the client
 * alias and the server renderer can never be wired independently. `"react"` (or
 * an unset key, which the CLI defaults to `"react"`) sets the React renderer,
 * which `renderPageResponse` treats as its streaming default.
 *
 * If the app ALREADY selected a different dialect (a bespoke `.renderer()` call),
 * `app.renderer` refuses with a coded `WEB_DIALECT_MISMATCH` — the matched pair
 * cannot be ambiguous. Returns the wired dialect for the client build.
 *
 * ASYNC because the Preact server renderer is loaded LAZILY: `preactServerRenderer`
 * lives behind `@lesto/ui/server-preact`, whose only runtime import is the OPTIONAL
 * `preact-render-to-string` peer. Importing it eagerly (a static import here, or a
 * module-scope renderer map) would drag that peer into every React consumer's graph
 * and crash a React-only app on bare import (L-863b3f6f). So the peer is resolved
 * once, here, ONLY on the `"preact"` branch — the per-request render path
 * (`renderPageMarkup`) stays synchronous, holding the already-resolved renderer.
 */
export async function applyUiDialect(app: Lesto, dialect: UiDialect): Promise<UiDialect> {
  const renderer =
    dialect === "preact"
      ? (await import("@lesto/ui/server-preact")).preactServerRenderer
      : reactServerRenderer;

  app.renderer(renderer);

  return dialect;
}

/**
 * One entry in a captured read contract: a route's wire `response`, projected from
 * the handler's `c.json(...)` return. Shaped to match `@lesto/client`'s `RouteSpec`
 * exactly, so `createApi<ContractOf<typeof api>>()` consumes it with no adapter.
 */
export interface CapturedRouteSpec {
  response: unknown;
}

/**
 * A captured read contract: keys are `"METHOD /path"`, values each route's
 * {@link CapturedRouteSpec}. {@link ContractOf} projects an {@link ApiRoutes}
 * builder's `typeof` to this — the read-path mirror of `MutationContractOf`.
 */
export type CapturedContract = Record<string, CapturedRouteSpec>;

/** The handler a typed read route runs: it MUST answer with a `c.json(...)` value. */
type TypedHandler<P extends string, Json> = (
  c: Context<P>,
  next: Next,
) => MaybePromise<TypedResponse<Json>>;

/**
 * The verbs a typed read route may declare. Reads project a response contract;
 * `GET` is the canonical read, but a `POST`/`PUT`/`PATCH`/`DELETE` that answers
 * with `c.json(...)` is captured the same way (the contract keys carry the verb,
 * exactly as `@lesto/client`'s contract does).
 */
type CapturedMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * A typed read-route builder — the drift-proof read path (Workstream 4 / ADR plan).
 *
 * `apiRoutes()` returns this. Each `.get(path, handler)` / `.post(...)` / … CAPTURES
 * the handler's `c.json(...)` response type into the accumulated contract `C`, so the
 * server routes ARE the single source of truth and the client cannot drift: a
 * handler edited to return the wrong shape changes `C`, and a `createApi` call typed
 * to the old shape stops compiling.
 *
 *   const api = apiRoutes()
 *     .get("/listings/:id", (c) => c.json(getListing(c.param("id"))))   // response captured
 *     .get("/saved", (c) => c.json({ saved: load() }));
 *
 *   // server: mount the real routes (a plain `lesto()` sub-app)
 *   app.route(api.routes());
 *
 *   // client: the contract is `typeof api` projected — no hand-written interface
 *   type Api = ContractOf<typeof api>;
 *   const client = createApi<Api>();
 *   await client.get("/listings/:id", { params: { id } });             // typed, drift-proof
 *
 * It is the `defineMutation`/`MutationContractOf` pattern for reads: the response
 * type rides a phantom on `c.json`'s {@link TypedResponse}, the builder accumulates
 * a `C` of `"METHOD /path" → { response }`, and {@link ContractOf} reads `C` back
 * out. `Lesto` itself stays NON-generic — `apiRoutes()` wraps a private `lesto()`
 * and hands back a plain `Lesto` from {@link ApiRoutes.routes} — so nothing that
 * consumes `Lesto` (`.route`, `applyFileRoutes`, `mutationRoutes`) is disturbed.
 *
 * **What this catches:** a handler whose `c.json(...)` shape stops matching what the
 * client call expects becomes a `tsc` error at the call site. **What it does NOT
 * catch:** a handler that answers with `c.text(...)`/`c.html(...)`/`c.bytes(...)`
 * instead of `c.json(...)` (the `TypedHandler` return type rejects it at
 * registration — those are not read-contract routes); a route declared with the
 * untyped `Lesto.get` (only `apiRoutes()` routes are captured); and a runtime body
 * that diverges from what was `c.json`'d (TypeScript checks the value passed to
 * `c.json`, not the bytes on the wire — there is no runtime schema here).
 *
 * **One constraint to know:** a handler's response type is inferred from a SINGLE
 * `c.json(...)` shape. A handler that returns two different shapes by status —
 * `if (!ok) return c.json({ error }, 400); return c.json(data);` — does not infer a
 * union; the second `c.json` must match the first or it is a `tsc` error. Annotate
 * the union explicitly (`c.json<Ok | Err>(…)`) on each branch, or — the idiomatic
 * Lesto way — let an error THROW (it surfaces as the client's coded `CLIENT_HTTP_ERROR`)
 * and keep the typed `c.json` to the one success shape.
 */
export class ApiRoutes<C extends CapturedContract = Record<never, never>> {
  // A typed builder is a thin façade over a real `lesto()`: it records the same
  // routes for dispatch, while its TYPE parameter accumulates the captured
  // contract. The two never diverge — every `.get`/… both registers and captures.
  private readonly app: Lesto;

  constructor(app: Lesto = lesto()) {
    this.app = app;
  }

  /**
   * Register `handler` on the inner app and re-type `this` with the contract grown
   * by one `"METHOD /path" → { response }` entry. The handler is a real `Handler`
   * at runtime (a {@link TypedResponse} IS a `LestoResponse`); only its captured
   * RETURN type is narrower, which is the whole point. One private body so every
   * verb method shares the exact same register-then-retype move.
   */
  private grow<M extends CapturedMethod, P extends string, Json>(
    register: (app: Lesto, path: P, handler: Handler) => Lesto,
    path: P,
    handler: TypedHandler<P, Json>,
  ): ApiRoutes<C & Record<`${M} ${P}`, { response: Json }>> {
    register(this.app, path, handler as Handler);

    return this as unknown as ApiRoutes<C & Record<`${M} ${P}`, { response: Json }>>;
  }

  /** Declare a typed `GET` route, capturing its `c.json(...)` response into the contract. */
  get<P extends string, Json>(
    path: P,
    handler: TypedHandler<P, Json>,
  ): ApiRoutes<C & Record<`GET ${P}`, { response: Json }>> {
    return this.grow<"GET", P, Json>((app, p, h) => app.get(p, h), path, handler);
  }

  /** Declare a typed `POST` route, capturing its `c.json(...)` response into the contract. */
  post<P extends string, Json>(
    path: P,
    handler: TypedHandler<P, Json>,
  ): ApiRoutes<C & Record<`POST ${P}`, { response: Json }>> {
    return this.grow<"POST", P, Json>((app, p, h) => app.post(p, h), path, handler);
  }

  /** Declare a typed `PUT` route, capturing its `c.json(...)` response into the contract. */
  put<P extends string, Json>(
    path: P,
    handler: TypedHandler<P, Json>,
  ): ApiRoutes<C & Record<`PUT ${P}`, { response: Json }>> {
    return this.grow<"PUT", P, Json>((app, p, h) => app.put(p, h), path, handler);
  }

  /** Declare a typed `PATCH` route, capturing its `c.json(...)` response into the contract. */
  patch<P extends string, Json>(
    path: P,
    handler: TypedHandler<P, Json>,
  ): ApiRoutes<C & Record<`PATCH ${P}`, { response: Json }>> {
    return this.grow<"PATCH", P, Json>((app, p, h) => app.patch(p, h), path, handler);
  }

  /** Declare a typed `DELETE` route, capturing its `c.json(...)` response into the contract. */
  delete<P extends string, Json>(
    path: P,
    handler: TypedHandler<P, Json>,
  ): ApiRoutes<C & Record<`DELETE ${P}`, { response: Json }>> {
    return this.grow<"DELETE", P, Json>((app, p, h) => app.delete(p, h), path, handler);
  }

  /**
   * The mountable `lesto()` sub-app carrying every captured route — `.route()` it
   * into the parent. A plain {@link Lesto}, so the contract TYPE is erased here and
   * mounting composes middleware/layouts exactly as any sub-app does.
   */
  routes(): Lesto {
    return this.app;
  }
}

/**
 * Start a typed read-route builder (Workstream 4). Every `.get`/`.post`/… captures
 * its handler's `c.json(...)` response into a contract `@lesto/client` consumes via
 * {@link ContractOf}, so the read client cannot drift from the server. See
 * {@link ApiRoutes}.
 */
export function apiRoutes(): ApiRoutes {
  return new ApiRoutes();
}

/**
 * Project an {@link ApiRoutes} builder's `typeof` to the read contract `@lesto/client`
 * consumes — the read-path mirror of `MutationContractOf<typeof defs>`.
 *
 *   const api = apiRoutes().get("/saved", (c) => c.json(load()));
 *   const client = createApi<ContractOf<typeof api>>();   // server is the source of truth
 *
 * It unwraps the builder's accumulated contract `C` (whose keys already are the
 * `"METHOD /path"` strings, values `{ response }`), so it lands as the exact shape
 * `createApi` infers over. Phantom-derived and erased at runtime.
 */
export type ContractOf<A> = A extends ApiRoutes<infer C> ? { [K in keyof C]: C[K] } : never;

// Re-exported so a route builder's handler can name a `c.json(...)` return type, and
// a contract projection can read it, without reaching into `handler-context`.
export type { JsonOf, TypedResponse } from "./handler-context";
