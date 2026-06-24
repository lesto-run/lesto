/**
 * The pure Vite `InlineConfig` builder for the island dev server.
 *
 * It is intentionally NARROW — its own {@link ViteIslandConfig} shape, not Vite's
 * sprawling `InlineConfig` — so the decision logic (ports, base, the preact alias) is
 * covered and asserted without dragging Vite's types into a covered module. The
 * coverage-excluded `vite.ts` edge adapts this to a real Vite config, adding the
 * plugin INSTANCES (Fast Refresh + the virtual-entry plugin) it alone can construct.
 *
 * Two choices are load-bearing:
 *   - `appType: "custom"` + a dedicated `base` ({@link VITE_BASE}) — Vite serves
 *     modules under one ownable prefix and never an index.html / SPA fallback (the app
 *     owns HTML). Island modules live INSIDE the project root, so Vite serves them as
 *     ROOT-RELATIVE URLs (NOT `/@fs/`); the dedicated base is what keeps that whole set
 *     from shadowing the app's request space ({@link paths}).
 *   - Vite listens on its OWN loopback `server.port`; the CLI proxies Vite-owned
 *     requests to it server-side (so the browser sees one same-origin server), while
 *     Vite's HMR WebSocket runs on a DEDICATED `server.hmr.port` the browser connects
 *     to directly — leaving the existing Bun reload socket for server-driven signals
 *     (overlay, CSS, route swap).
 */

import { PREACT_ALIAS } from "@lesto/assets";
import type { PublicEnvDefine } from "@lesto/assets";

import type { IslandDialect } from "./dialect";
import { VITE_BASE } from "./paths";

/** One anchored module-resolution alias (the preact dialect's `react` → `preact/compat`). */
export interface ViteIslandAlias {
  readonly find: RegExp;
  readonly replacement: string;
}

/** The narrow Vite config the {@link viteIslandConfig} builder produces. */
export interface ViteIslandConfig {
  /** The project root — where islands, `node_modules`, and the entry resolve from. */
  readonly root: string;

  /** The dedicated prefix every Vite-served URL sits under ({@link VITE_BASE}). */
  readonly base: string;

  /** `custom`: Vite serves modules but never an index.html / SPA fallback (the app owns HTML). */
  readonly appType: "custom";

  /** Never load the app's own `vite.config` — this inline config is authoritative. */
  readonly configFile: false;

  /** Leave the terminal alone; the CLI owns dev output. */
  readonly clearScreen: false;

  /** Quiet Vite's own logging; build failures surface through the CLI's overlay. */
  readonly logLevel: "warn";

  readonly server: {
    /** Bind loopback-only — Vite is reached server-side by the CLI proxy, never the LAN. */
    readonly host: "127.0.0.1";

    /** The internal port Vite's HTTP server listens on (proxied to by the CLI dev path). */
    readonly port: number;

    /** Fail fast if the internal port is taken rather than silently drifting to another. */
    readonly strictPort: true;

    /** Vite's HMR WebSocket on a dedicated port (the Bun reload socket keeps its own). */
    readonly hmr: { readonly port: number };
  };

  /** Build-time literal replacements — the verified PUBLIC_* inject map (ADR-0011). */
  readonly define: Record<string, string>;

  /** Module aliases — empty for `react`, the anchored preact/compat map for `preact`. */
  readonly resolve: { readonly alias: readonly ViteIslandAlias[] };
}

/** Inputs the {@link viteIslandConfig} builder reads. */
export interface ViteIslandConfigOptions {
  /** The project root. */
  readonly root: string;

  /** The internal loopback port Vite's HTTP server listens on (the CLI proxies to it). */
  readonly vitePort: number;

  /** The dedicated port for Vite's HMR WebSocket (the browser connects here directly). */
  readonly hmrPort: number;

  /** The client dialect (ADR 0008) — drives the alias map. */
  readonly dialect: IslandDialect;

  /** The verified PUBLIC_* inject map, or absent (no public config to inline). */
  readonly publicEnvDefine?: PublicEnvDefine;
}

/** Escape a string so it matches literally inside a `new RegExp(...)`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * The preact dialect's resolve aliases: each `react*` specifier anchored (`^…$`) to
 * its `preact/compat` target, so `react` is rewritten without also catching
 * `react-dom`. The matched sibling of `@lesto/assets`'s Bun `preactAliasPlugin` —
 * same map, expressed as Vite `resolve.alias` instead of an `onResolve` plugin.
 */
function preactAliases(): readonly ViteIslandAlias[] {
  return Object.entries(PREACT_ALIAS).map(([from, to]) => ({
    find: new RegExp(`^${escapeRegExp(from)}$`),
    replacement: to,
  }));
}

/** Build the narrow Vite config for the island dev server. */
export function viteIslandConfig(options: ViteIslandConfigOptions): ViteIslandConfig {
  return {
    root: options.root,
    base: VITE_BASE,
    appType: "custom",
    configFile: false,
    clearScreen: false,
    logLevel: "warn",
    server: {
      host: "127.0.0.1",
      port: options.vitePort,
      strictPort: true,
      hmr: { port: options.hmrPort },
    },
    define: options.publicEnvDefine === undefined ? {} : { ...options.publicEnvDefine },
    resolve: { alias: options.dialect === "preact" ? preactAliases() : [] },
  };
}
