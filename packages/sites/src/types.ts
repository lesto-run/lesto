/**
 * One project, many sites. A site is a named view over the same app and
 * substrate, mounted at a path, rendered either statically (prerendered to
 * files) or dynamically (served live).
 */

/** How a site is rendered. */
export type SiteRender = "static" | "dynamic";

/**
 * The routes a static site prerenders, relative to its `basePath`.
 *
 * A fixed list, or a function that derives one — so pages can come from a
 * content collection, a database query, or anywhere else, resolved at build time.
 */
export type PagesSource =
  | readonly string[]
  | (() => readonly string[] | Promise<readonly string[]>);

interface BaseSite {
  /** Unique within the project; also the output directory for static builds. */
  readonly name: string;

  /** The path prefix this site is mounted at — `/` for the root, `/mls` for a zone. */
  readonly basePath: string;
}

/** A site prerendered to static files and served from a CDN with no runtime. */
export interface StaticSite extends BaseSite {
  readonly render: "static";

  /** The routes (relative to `basePath`) to prerender. */
  readonly pages: PagesSource;
}

/** A site served live, per request, by the running app. */
export interface DynamicSite extends BaseSite {
  readonly render: "dynamic";
}

/** Any site in the set. */
export type Site = StaticSite | DynamicSite;

/**
 * The slice of a response the prerenderer needs.
 *
 * `@keel/web`'s `KeelResponse` satisfies this structurally, so the app's own
 * `handle` is a `PageHandler` with no adapter — and tests can pass a fake.
 */
export interface RenderResponse {
  readonly status: number;

  readonly body: string;
}

/** Renders one path to a response. Pass the app's `handle`. */
export type PageHandler = (method: string, path: string) => Promise<RenderResponse>;

/** One prerendered page: where it came from, where it goes, and what it is. */
export interface RenderedPage {
  /** The full origin path the app rendered, e.g. `/mls/about`. */
  readonly path: string;

  /** The file to write, e.g. `marketing/about/index.html`. */
  readonly outputPath: string;

  /** The app's response status — the build fails the page if it is not 2xx. */
  readonly status: number;

  readonly html: string;
}

/**
 * Where prerendered files go.
 *
 * The default writes to the local filesystem ({@link nodeSink}), but any sink —
 * S3, an in-memory map, a CDN upload — satisfies the same shape.
 */
export type OutputSink = (path: string, contents: string) => Promise<void>;
