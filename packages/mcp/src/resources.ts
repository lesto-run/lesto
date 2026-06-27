/**
 * The read-only app contract, as MCP *resources* (ADR 0034 Part A).
 *
 * A resource is the MCP way to hand an agent a stable, addressable document it
 * can read without invoking a tool — here, the app's own contract: its route
 * map, its OpenAPI document, its content collections, and its declared schema
 * shape. `buildResources` is symmetric with {@link buildTools}: each entry is a
 * pure `{ uri, name, mimeType, read() }` descriptor, and ALL select/dispatch
 * logic lives here (covered), so the transport wiring in `server.ts` stays a
 * true one-handler-per-capability passthrough that adds no branch.
 *
 * The same payload is also offered as the `describe_app` *tool* (`tools.ts`), for
 * clients that don't speak resources — both read through these builders, so the
 * two views can never drift.
 */

import { toOpenApi } from "@lesto/openapi";

import { McpError } from "./errors";
import type { LestoMcpContext } from "./tools";

/** Every Lesto resource serves JSON. */
const JSON_MIME = "application/json";

/** The `info` block used when the app supplies none (`context.openApiInfo` absent). */
const DEFAULT_OPENAPI_INFO = { title: "Lesto API", version: "0.0.0" } as const;

/** A read-only MCP resource: a stable URI and a pure reader for its JSON body. */
export interface LestoResource {
  /** The stable `lesto://…` URI a client reads this resource by. */
  uri: string;

  /** A human-facing name for the resource. */
  name: string;

  /** An optional caveat/limitation note, surfaced to the client in `resources/list`. */
  description?: string;

  /** The MIME type of the `read()` payload — `application/json` for every Lesto resource. */
  mimeType: string;

  /** Produce the resource body. Pure; may be async (e.g. loading the content peers). */
  read(): Promise<unknown> | unknown;
}

/**
 * Build the app-contract resources for a context — the route map, the OpenAPI
 * document, the content collections, and the declared schema shape.
 *
 * The list order is stable (clients and tests rely on it), and every resource
 * degrades gracefully: an app with no content peers or no declared schema yields
 * an empty-but-valid body, never a refusal — reading the contract must never fail.
 */
export function buildResources(context: LestoMcpContext): LestoResource[] {
  return [
    {
      uri: "lesto://routes",
      name: "Route map",
      mimeType: JSON_MIME,
      read: () => context.routes,
    },
    {
      uri: "lesto://openapi",
      name: "OpenAPI document",
      description:
        "Route-shape skeleton only: every operation carries a bare 200 and no request/response body schema (the Zod-extracted tier is post-1.0). This is the UNFILTERED route set — internal routes are not excluded here.",
      mimeType: JSON_MIME,
      read: () => toOpenApi(context.routes, context.openApiInfo ?? DEFAULT_OPENAPI_INFO),
    },
    {
      uri: "lesto://collections",
      name: "Content collections",
      mimeType: JSON_MIME,
      read: () => readCollections(context),
    },
    {
      uri: "lesto://schema",
      name: "Schema shape",
      description:
        "Declared shape only — known migration versions and each defineTable's column names/types, not full database reflection.",
      mimeType: JSON_MIME,
      read: () => context.schema ?? { migrations: [], tables: [] },
    },
  ];
}

/**
 * The content collections, each with its entry count — or an empty-but-valid list
 * when the optional content peers aren't wired.
 *
 * Graceful degradation (ADR 0034 Part A must-fix): unlike the
 * `list_content_collections` tool, which throws `MCP_CONTENT_PACKAGES_MISSING`
 * through `requireContent` when `context.loadContent` is absent, the contract
 * resource yields `[]` so reading the app contract never fails on a content-less
 * app. Where the peers ARE wired it mirrors that tool's `{ name, count }` shape.
 */
async function readCollections(
  context: LestoMcpContext,
): Promise<{ name: string; count: number }[]> {
  if (context.loadContent === undefined) return [];

  const content = await context.loadContent();

  return content.core.getCollections().map((collection) => ({
    name: collection.name,
    count: collection.entries.length,
  }));
}

/**
 * The `resources/list` payload: each resource's metadata, no body.
 *
 * The covered half of the stdio server's `resources/list` handler — `server.ts`
 * delegates here so it carries no select logic.
 */
export function listResources(resources: LestoResource[]): {
  resources: { uri: string; name: string; description?: string; mimeType: string }[];
} {
  return {
    resources: resources.map(({ uri, name, description, mimeType }) => ({
      uri,
      name,
      ...(description === undefined ? {} : { description }),
      mimeType,
    })),
  };
}

/**
 * Read one resource by URI, rendering its body as MCP `contents`.
 *
 * Throws `MCP_UNKNOWN_RESOURCE` when no resource carries the URI, so a client
 * typo or a stale list never silently yields nothing. The covered half of the
 * stdio server's `resources/read` handler.
 */
export async function readResource(
  resources: LestoResource[],
  uri: string,
): Promise<{ contents: { uri: string; mimeType: string; text: string }[] }> {
  const resource = resources.find((candidate) => candidate.uri === uri);

  if (resource === undefined) {
    throw new McpError("MCP_UNKNOWN_RESOURCE", `No MCP resource has the URI "${uri}".`, { uri });
  }

  const body = await resource.read();

  return {
    contents: [{ uri, mimeType: resource.mimeType, text: JSON.stringify(body) }],
  };
}
