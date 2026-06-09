/**
 * @keel/openapi — generate an OpenAPI 3.1 document from a @keel/router Router.
 *
 * Pure transformation: every route in `router.list()` becomes one method entry
 * under its path. The router's `:param` segments become OpenAPI `{param}`
 * placeholders, and each one is also declared as a required string path
 * parameter so generated clients know to fill it in.
 */

import type { Router } from "@keel/router";

/** The `info` block of the document: the human-facing title and version. */
export interface OpenApiInfo {
  title: string;

  version: string;

  /** A longer prose description, surfaced only when the caller provides one. */
  description?: string;
}

// A `:param` segment in a router pattern — the same shape the router compiles.
// Capturing the bare name lets us both rewrite the path and list the parameter.
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

// Pull the ordered list of `:param` names out of a router pattern.
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
 * Build an OpenAPI 3.1 document from a router.
 *
 * Routes are grouped by their OpenAPI path; within a path, each route adds one
 * lowercased-method operation. The operation's `operationId` is the router
 * target (e.g. `posts#show`), and its parameters come from the pattern's
 * `:param` segments.
 */
export const toOpenApi = (router: Router, info: OpenApiInfo): Record<string, unknown> => {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of router.list()) {
    const path = toOpenApiPath(route.pattern);

    // The first route to touch a path opens its bucket; later verbs join it.
    const operations = (paths[path] ??= {});

    operations[route.method.toLowerCase()] = {
      operationId: route.target,
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
