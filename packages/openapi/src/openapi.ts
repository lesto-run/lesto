/**
 * @volo/openapi — generate an OpenAPI 3.1 document from a Volo app's route list.
 *
 * Pure transformation: every entry in the app's `routes()` (a `{ method, pattern }`
 * list) becomes one method entry under its path. The router's `:param` segments
 * become OpenAPI `{param}` placeholders, and each is declared as a required
 * string path parameter so generated clients know to fill it in.
 *
 * This is the route-shape skeleton; request/response *schemas* (from the Zod
 * boundary validators) are layered on in a later tier. It takes the plain route
 * list rather than a router object, so it is decoupled from any one router type.
 */

/** One route to document: its verb and its path pattern (the shape `volo().routes()` yields). */
export interface RouteEntry {
  method: string;

  pattern: string;

  /**
   * Mark a route as internal so it is dropped before export — a health probe, an
   * admin-only endpoint, anything that should not appear in the public API
   * surface a generated client builds against. Absent (or `false`) means the
   * route is documented. The flag lives on the route rather than in a separate
   * exclude list so a route declares its own visibility at the source.
   */
  internal?: boolean;
}

/** What to leave out of the document before it is built. */
export interface OpenApiOptions {
  /**
   * An extra predicate that, returning true, marks a route internal — excluded
   * from the export. It runs alongside the per-route `internal` flag (either
   * excludes), so a caller can drop a whole prefix (`/admin`, `/_internal`)
   * without touching each route. Absent means only the flags decide.
   */
  isInternal?: (route: RouteEntry) => boolean;
}

/** The `info` block of the document: the human-facing title and version. */
export interface OpenApiInfo {
  title: string;

  version: string;

  /** A longer prose description, surfaced only when the caller provides one. */
  description?: string;
}

// A `:param` segment in a route pattern. Capturing the bare name lets us both
// rewrite the path and list the parameter.
const PARAM_SEGMENT = /:([A-Za-z_][A-Za-z0-9_]*)/g;

/** One OpenAPI path parameter: always in the path, always required, always a string. */
interface PathParameter {
  name: string;

  in: "path";

  required: true;

  schema: { type: "string" };
}

// Rewrite ":id" -> "{id}" so the path reads in OpenAPI's templating syntax.
const toOpenApiPath = (pattern: string): string =>
  pattern.replace(PARAM_SEGMENT, (_segment, name: string) => `{${name}}`);

// Pull the ordered list of `:param` names out of a route pattern.
const paramNames = (pattern: string): string[] =>
  [...pattern.matchAll(PARAM_SEGMENT)].map((match) => match[1] as string);

// Each captured name becomes a fully-specified, required string path parameter.
const pathParameters = (pattern: string): PathParameter[] =>
  paramNames(pattern).map((name) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string" },
  }));

/**
 * A stable operationId derived from the verb and path.
 *
 * The old router carried a `controller#action` target to use here; the code-first
 * router does not, so the id is the lowercased method followed by each path
 * segment capitalized (a `:param` contributes its name). `GET /posts/:id` becomes
 * `getPostsId` — deterministic and unique per method+pattern.
 */
const operationId = (method: string, pattern: string): string => {
  const camel = pattern
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      const name = segment.startsWith(":") ? segment.slice(1) : segment;
      return name.charAt(0).toUpperCase() + name.slice(1);
    })
    .join("");

  return method.toLowerCase() + camel;
};

/**
 * True iff a route should be left out of the document.
 *
 * A route is internal if it carries the `internal` flag OR the caller's
 * `isInternal` predicate matches it — either is enough, so a route can opt out
 * at its source and a caller can drop a whole prefix without editing each one.
 */
const isInternal = (route: RouteEntry, options: OpenApiOptions): boolean =>
  route.internal === true || (options.isInternal?.(route) ?? false);

/**
 * Build an OpenAPI 3.1 document from a route list.
 *
 * Routes are grouped by their OpenAPI path; within a path, each route adds one
 * lowercased-method operation, with an `operationId` derived from the verb +
 * path and parameters from the pattern's `:param` segments.
 *
 * Internal routes are filtered out *before* the document is built — both those
 * flagged `internal` and any the caller's `options.isInternal` matches — so the
 * exported surface is exactly the public API.
 *
 * Documented limitation: this is the route-shape skeleton only. Request and
 * response *schemas* (extracted from the Zod boundary validators, ADR 0005) are
 * the post-1.0 follow-on; every operation here carries a bare `200 OK` and no
 * body schema.
 */
export const toOpenApi = (
  routes: readonly RouteEntry[],
  info: OpenApiInfo,
  options: OpenApiOptions = {},
): Record<string, unknown> => {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    // Internal routes never reach the document: skip before opening a path bucket
    // so an all-internal path leaves no empty entry behind.
    if (isInternal(route, options)) continue;

    const path = toOpenApiPath(route.pattern);

    // The first route to touch a path opens its bucket; later verbs join it.
    const operations = (paths[path] ??= {});

    operations[route.method.toLowerCase()] = {
      operationId: operationId(route.method, route.pattern),
      parameters: pathParameters(route.pattern),
      responses: { "200": { description: "OK" } },
    };
  }

  return {
    openapi: "3.1.0",

    // `description` is optional in the document just as it is in the input.
    info: {
      title: info.title,
      version: info.version,
      ...(info.description === undefined ? {} : { description: info.description }),
    },

    paths,
  };
};

/** Serialize a spec to pretty-printed JSON — 2-space indent, ready to write to disk. */
export const toJson = (spec: Record<string, unknown>): string => JSON.stringify(spec, null, 2);
