/**
 * `keel()` — the code-first router that registers API routes AND pages on one
 * composable surface.
 *
 *   const app = keel()
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

import { formatTraceparent } from "@keel/observability";
import { RouteTable } from "@keel/router";
import type { Match } from "@keel/router";
import { createSourceResolver, dataSourceHref } from "@keel/ui";
import type { DataSource } from "@keel/ui";
import { preactServerRenderer, reactServerRenderer } from "@keel/ui/server";
import type { ServerRenderer } from "@keel/ui/server";

import { BROWSER_SPANS_ROUTE, browserSpansHandler, defaultBrowserSpanSink } from "./browser-spans";
import type { BrowserSpanSink } from "./browser-spans";
import { CLIENT_ERRORS_ROUTE, clientErrorsHandler, defaultClientErrorSink } from "./client-errors";
import type { ClientErrorSink } from "./client-errors";
import { currentRequestSpan } from "./context";
import { WebError } from "./errors";
import { Context } from "./handler-context";
import type { Middleware, Next } from "./middleware";
import { renderPageResponse } from "./render-page";
import type { Layout, PageDef, RenderPageOptions } from "./render-page";
import type { AnyKeelResponse, HandleOptions, KeelRequest, KeelResponse } from "./types";

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
) => MaybePromise<AnyKeelResponse | void>;

/**
 * Adapt a request-shaped {@link Middleware} into a {@link Handler}.
 *
 * The security batteries (`@keel/cors`, `@keel/ratelimit`, `@keel/csrf`, and the
 * `secureStack` that bundles them) are written against the request-and-next
 * contract — they read the request's headers/method and either answer or delegate.
 * That is exactly a handler minus the context wrapper, so the bridge is to hand
 * the middleware the context's request: `app.use(fromRequestMiddleware(cors()))`.
 * One adapter keeps those packages unchanged while they run in the new chain.
 */
export function fromRequestMiddleware(middleware: Middleware): Handler {
  return (c, next) => middleware(c.req, next);
}

/** A page's own payload: its definition plus the layouts wrapping it, outermost first. */
interface PagePayload {
  def: PageDef;

  layouts: readonly Layout[];
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
const notFound = (): KeelResponse => ({
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
 * request (the {@link Keel.handle} invariant); the coded error then propagates to
 * the transport, which maps it to a 400 — exactly as it does for an error thrown
 * deeper in the chain.
 */
const raisingHandler =
  (error: unknown): Handler =>
  () => {
    throw error;
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
function runChain(chain: readonly Handler[], c: Context): Promise<AnyKeelResponse> {
  const run = async (index: number): Promise<AnyKeelResponse> => {
    const handler = chain[index];

    if (handler === undefined) return notFound();

    let advanced: Promise<AnyKeelResponse> | undefined;
    const next: Next = () => (advanced ??= run(index + 1));

    const response = await handler(c, next);

    return response === undefined ? next() : response;
  };

  return run(0);
}

export class Keel {
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

  // Where the client-error beacon (`POST /__keel/client-errors`, registered as a
  // built-in below) forwards its normalized events. Defaults to the structured-log
  // sink; `.clientErrors(sink)` swaps it (the observability wave wires OTLP here).
  // The route reads this field at request time, so an override set after
  // construction still takes effect.
  private clientErrorSink: ClientErrorSink = defaultClientErrorSink;

  // Where the browser-RUM receiver (`POST /__keel/browser-spans`, registered as a
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

  /** Register a page at `path`, wrapped in the layouts declared so far. */
  page<P extends string, Loaded>(path: P, def: PageDef<P, Loaded>): this {
    // The public def is typed over its loaded shape (so the component's props are
    // inferred); storage is over the erased `PageDef`. A React component is
    // contravariant in its props, so a specific def is not directly assignable to
    // the open one — the erasure is deliberate and lives only at this boundary.
    return this.add("GET", path, {
      def: def as unknown as PageDef,
      layouts: [...this.layoutChain],
    });
  }

  /**
   * Register a data source's loader and auto-expose it at `GET /__keel/data/<name>`
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
   */
  data<T>(source: DataSource<T>, loader: (c: Context) => MaybePromise<T>): this {
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

    return this.get(dataSourceHref(source.name), async (c) => {
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
   * Select the server-render dialect (ADR 0008's matched pair).
   *
   * Pass the Preact `ServerRenderer` (`@keel/ui/server`'s `preactServerRenderer`)
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
   * Override where the client-error beacon (`POST /__keel/client-errors`) forwards
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
   * Override where the browser-RUM receiver (`POST /__keel/browser-spans`)
   * forwards its normalized spans.
   *
   * The route is a built-in — registered for every app — so this only swaps its
   * SINK; the default is a structured-log sink. The canonical wiring points it at
   * `traces.seams.onBrowserSpan`, so a browser navigation/resource/web-vital span
   * lands in the SAME OTLP collector as the server `http.request` span, joined by
   * the trace id the page adopted from the SSR-injected `keel-traceparent` meta —
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
   * (`/__keel/data/<name>`). Register data sources on the ROOT app. A prefix-aware
   * href is future work.
   */
  route(sub: Keel): this;
  route(prefix: string, sub: Keel): this;
  route(prefixOrSub: string | Keel, maybeSub?: Keel): this {
    const prefix = typeof prefixOrSub === "string" ? prefixOrSub : "";
    const sub = typeof prefixOrSub === "string" ? (maybeSub as Keel) : prefixOrSub;

    for (const route of sub.collected) {
      this.collected.push({
        method: route.method,
        pattern: prefix + route.pattern,
        middleware: [...this.useChain, ...route.middleware],
        own: isPage(route.own)
          ? { def: route.own.def, layouts: [...this.layoutChain, ...route.own.layouts] }
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
   * top-level `.use` middleware (wrapping a 404 terminal), so global concerns —
   * a CORS preflight to an unrouted `OPTIONS`, a rate-limit on an unknown path —
   * are answered for every request, matched or not. A path that fails to route
   * because a param is a malformed percent-encoding (`match` throws a coded
   * `ROUTER_MALFORMED_PARAM`) is treated the same way: the global middleware runs
   * around a terminal that re-raises the coded error, so it still reaches the
   * transport as a 400 without slipping past CORS/rate-limit. The declared return
   * is the string-bodied {@link KeelResponse} dispatch contract;
   * a handler may produce a wider body (bytes, a stream — a page streams its
   * HTML), which the transport, not this contract, writes — so it is narrowed
   * back here.
   */
  async handle(method: string, path: string, options?: HandleOptions): Promise<KeelResponse> {
    const matcher = this.matcher();

    let match: Match<readonly Handler[]> | undefined;
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

    const request: KeelRequest = {
      method,
      path,
      params: match?.params ?? {},
      query: options?.query ?? {},
      headers: options?.headers ?? {},
      body: options?.body,
    };

    // A match runs its baked chain (middleware + handler/page); a miss still runs
    // the app's global middleware, around a 404 for an unknown path or a re-raise
    // for a malformed param — either way CORS/rate-limit see every request.
    const chain =
      match !== undefined
        ? match.value
        : [...this.useChain, malformed === undefined ? notFoundHandler : raisingHandler(malformed)];

    const response = await runChain(chain, new Context(request));

    return response as KeelResponse;
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

  /** The full handler chain a route runs: its middleware, then its own work (or page render). */
  private chainOf(route: CollectedRoute): readonly Handler[] {
    const own = isPage(route.own) ? [this.pageHandler(route.own)] : route.own;

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
export function keel(): Keel {
  return new Keel();
}

/**
 * Which component runtime an app's UI is built for (ADR 0007/0008). The single
 * `ui.dialect` config key the CLI reads; it drives BOTH the client bundle's
 * `react`→`preact/compat` alias AND the server renderer, as one matched pair.
 */
export type UiDialect = "react" | "preact";

/** The server renderer each dialect maps to — the matched pair's server half. */
const RENDERER_FOR_DIALECT: Record<UiDialect, ServerRenderer> = {
  react: reactServerRenderer,
  preact: preactServerRenderer,
};

/**
 * Wire a single `ui.dialect` key onto a `keel()` app as ADR 0008's matched pair,
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
 */
export function applyUiDialect(app: Keel, dialect: UiDialect): UiDialect {
  app.renderer(RENDERER_FOR_DIALECT[dialect]);

  return dialect;
}
