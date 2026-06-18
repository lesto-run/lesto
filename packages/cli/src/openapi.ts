/**
 * `lesto openapi` — export the app's route surface as an OpenAPI 3.1 document.
 *
 * The MCP control plane drives the app for agents; this makes the same surface
 * legible to *humans and tools* — a spec a generated client, a Swagger UI, or a
 * contract test can build against (operability-dx #5).
 *
 * It is the route-shape skeleton: every route becomes a path + operation with
 * its `:param` placeholders. Request and response **schemas** (extracted from
 * the Zod boundary validators, ADR 0005) are the deliberate post-1.0 follow-on —
 * the command says so on the way out, so no one mistakes the absence for a bug.
 *
 * Internal routes are excludable: pass `--exclude <prefix>` (repeatable) to drop
 * anything whose path starts with that prefix — a health probe, an admin zone —
 * from the exported surface, layered on top of the `@lesto/openapi` filter.
 *
 * Like `run`, the core is pure and fully injected: a test hands it a fake
 * `loadApp` and a spy `write` and asserts on the document and the path it wrote.
 */

import { toJson, toOpenApi } from "@lesto/openapi";
import type { OpenApiOptions, RouteEntry } from "@lesto/openapi";

import type { LestoAppConfig } from "@lesto/kernel";

import { parseStringFlag } from "./flags";

/** Where `lesto openapi` writes when no `--out` flag is given. */
const DEFAULT_OUT = "openapi.json";

/** The document's `info` block when the app declares no `meta` of its own. */
const DEFAULT_INFO = { title: "Lesto API", version: "0.0.0" } as const;

/** The seams `lesto openapi` depends on — all injected, never imported live. */
export interface OpenApiDeps {
  /** Load the project's app config (the bin reads `lesto.app.ts`; tests fake it). */
  loadApp: () => Promise<LestoAppConfig>;

  /** Write the serialized document to a path (the bin passes an fs writer; tests spy). */
  write: (path: string, contents: string) => Promise<void>;

  /** Where a line of output goes (the bin passes `console.log`). */
  out: (line: string) => void;
}

/**
 * Pull every `--exclude <prefix>` out of the args, in order.
 *
 * A repeatable flag — `--exclude /healthz --exclude /admin` — so a caller can
 * drop several prefixes in one run. Each value is the token after the flag; a
 * trailing `--exclude` with nothing after it contributes no prefix.
 */
function excludePrefixes(args: readonly string[]): string[] {
  const prefixes: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--exclude") continue;

    const value = args[index + 1];

    // A trailing `--exclude` with no value names no prefix; skip it.
    if (value !== undefined) prefixes.push(value);
  }

  return prefixes;
}

/**
 * Build the `isInternal` predicate from the `--exclude` prefixes.
 *
 * A route is internal (excluded) when its pattern starts with any given prefix.
 * No prefixes means no predicate at all — the document carries every route the
 * app's own `internal` flags do not already drop.
 */
function internalFilter(prefixes: readonly string[]): OpenApiOptions {
  if (prefixes.length === 0) return {};

  return {
    isInternal: (route: RouteEntry) => prefixes.some((prefix) => route.pattern.startsWith(prefix)),
  };
}

/**
 * Export the app's routes as an OpenAPI 3.1 document on disk.
 *
 * Loads the app (no boot needed — the route list is declared on the `lesto()`
 * app, not produced by migrating), builds the spec with internal routes
 * filtered out, and writes it to `--out` (default `openapi.json`). Prints the
 * path and route count, then the standing limitation so the schema gap is never
 * mistaken for a defect.
 */
export async function runOpenApi(args: readonly string[], deps: OpenApiDeps): Promise<number> {
  const config = await deps.loadApp();

  const routes: readonly RouteEntry[] = config.app.routes();

  const options = internalFilter(excludePrefixes(args));

  const spec = toOpenApi(routes, DEFAULT_INFO, options);

  const out = parseStringFlag(args, "out") ?? DEFAULT_OUT;

  await deps.write(out, toJson(spec));

  // Report against the EXPORTED paths, not the input route count — the number an
  // author cares about is what landed in the document after filtering.
  const paths = spec["paths"] as Record<string, unknown>;

  deps.out(`wrote ${out}: ${Object.keys(paths).length} paths`);
  deps.out("note: request/response schemas are not yet emitted (Zod extraction is post-1.0)");

  return 0;
}
