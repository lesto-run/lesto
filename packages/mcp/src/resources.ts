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

import { McpError } from "./errors";
import type { LestoMcpContext } from "./tools";

/** Every Lesto resource serves JSON. */
const JSON_MIME = "application/json";

/** A read-only MCP resource: a stable URI and a pure reader for its JSON body. */
export interface LestoResource {
  /** The stable `lesto://…` URI a client reads this resource by. */
  uri: string;

  /** A human-facing name for the resource. */
  name: string;

  /** The MIME type of the `read()` payload — `application/json` for every Lesto resource. */
  mimeType: string;

  /** Produce the resource body. Pure; may be async (e.g. loading the content peers). */
  read(): Promise<unknown> | unknown;
}

/**
 * Build the app-contract resources for a context.
 *
 * Increment 1 ships the **route map** (`context.routes`, already on the context);
 * the OpenAPI, collections, and schema-shape resources follow in Increment 2.
 * The list order is stable — clients and tests can rely on it.
 */
export function buildResources(context: LestoMcpContext): LestoResource[] {
  return [
    {
      uri: "lesto://routes",
      name: "Route map",
      mimeType: JSON_MIME,
      read: () => context.routes,
    },
  ];
}

/**
 * The `resources/list` payload: each resource's metadata, no body.
 *
 * The covered half of the stdio server's `resources/list` handler — `server.ts`
 * delegates here so it carries no select logic.
 */
export function listResources(resources: LestoResource[]): {
  resources: { uri: string; name: string; mimeType: string }[];
} {
  return {
    resources: resources.map(({ uri, name, mimeType }) => ({ uri, name, mimeType })),
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
