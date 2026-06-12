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

import { RouteTable } from "@keel/router";
import { createSourceResolver, dataSourceHref } from "@keel/ui";
import type { DataSource } from "@keel/ui";

import { WebError } from "./errors";
import { Context } from "./handler-context";
import type { Middleware, Next } from "./middleware";
import { renderPageResponse } from "./render-page";
import type { Layout, PageDef } from "./render-page";
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
   * are answered exactly as the legacy `Application` pipeline answered them. The
   * declared return is the string-bodied {@link KeelResponse} dispatch contract;
   * a handler may produce a wider body (bytes, a stream — a page streams its
   * HTML), which the transport, not this contract, writes — so it is narrowed
   * back here.
   */
  async handle(method: string, path: string, options?: HandleOptions): Promise<KeelResponse> {
    const match = this.matcher().match(method, path);

    const request: KeelRequest = {
      method,
      path,
      params: match?.params ?? {},
      query: options?.query ?? {},
      headers: options?.headers ?? {},
      body: options?.body,
    };

    // A match runs its baked chain (middleware + handler/page); a miss still runs
    // the app's global middleware around a 404, so CORS/rate-limit see every request.
    const chain = match === undefined ? [...this.useChain, notFoundHandler] : match.value;

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
    return (c) => {
      const resolver = createSourceResolver((name) => {
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

      return renderPageResponse(payload.def, c, payload.layouts, {
        resolver,
        privateData: this.hasPrivateData,
        ...(this.clientModuleSrc === undefined ? {} : { clientModule: this.clientModuleSrc }),
      });
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

      this.table = table;
    }

    return this.table;
  }
}

/** Start a new code-first router. */
export function keel(): Keel {
  return new Keel();
}
