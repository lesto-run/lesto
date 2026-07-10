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

import { dialectRuntimeDeps, preactAliases } from "@lesto/assets";
import type { PublicEnvDefine } from "@lesto/assets";

import type { IslandDialect } from "./dialect";
import { SCAN_ENTRY_PATH } from "./entry";
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

    /**
     * Bind exactly the CLI-chosen port or fail — never silently drift to another, which
     * would strand the CLI's proxy (it targets {@link port}) on the wrong server. The CLI
     * picks a FREE port per `lesto dev` (`findIslandDevPorts`), so the bind effectively
     * always succeeds; on the rare TOCTOU loss the bind rejects and the CLI degrades to
     * full reload rather than crashing.
     */
    readonly strictPort: true;

    /** Vite's HMR WebSocket on a dedicated port (the Bun reload socket keeps its own). */
    readonly hmr: { readonly port: number };
  };

  /** Build-time literal replacements — the verified PUBLIC_* inject map (ADR-0011). */
  readonly define: Record<string, string>;

  /**
   * How Vite pre-bundles the island graph's npm dependencies, on both of its levers:
   *
   *   - `include` names the dialect's client runtime, so Vite optimizes it ONCE rather
   *     than re-discovering it on the first island request.
   *   - `entries` points Vite's dep SCANNER at the on-disk twin of the synthesized entry
   *     ({@link SCAN_ENTRY_PATH}). Without it the scanner's default (`**\/*.html`) matches
   *     nothing — this server has no `index.html` — so the scanner never runs and EVERY
   *     npm package beyond `include` is a mid-crawl discovery that forces a second
   *     optimizer pass and can 504 a racing island request (L-90d2de01). With it, the
   *     scan and the crawl see one graph and cold start settles in a single pass.
   *
   * Both are plain `string[]` (not `readonly`) because Vite's `DepOptimizationOptions`
   * fields are mutable — this narrow config spreads straight into the real `InlineConfig`
   * ({@link viteIslandConfig}).
   */
  readonly optimizeDeps: { readonly include: string[]; readonly entries: string[] };

  /**
   * Module resolution. `alias` is empty for `react`, the anchored preact/compat map for
   * `preact`; `dedupe` forces ONE runtime copy across the app and the symlinked workspace
   * `@lesto/ui` — a second React/preact instance breaks hooks AND Fast Refresh (the
   * duplicate-runtime footgun `vite.ts` flagged). `dedupe` is a plain `string[]` for the
   * same Vite-mutability reason as `optimizeDeps.include`.
   */
  readonly resolve: { readonly alias: readonly ViteIslandAlias[]; readonly dedupe: string[] };
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

/**
 * Build the narrow Vite config for the island dev server.
 *
 * The preact `resolve.alias` and the per-dialect `{ dedupe, include }` runtime deps are
 * derived from `@lesto/assets`'s SHARED {@link preactAliases} / {@link dialectRuntimeDeps}
 * — the SAME derivation the prod island build (`vite-build.ts`) consumes — so dev and
 * prod can never drift in how `react` is rewritten or which runtime is deduped to one
 * copy. The shared aliases come back as the narrow `{ find, replacement }` shape, which
 * is exactly this config's {@link ViteIslandAlias}, so they spread straight in.
 */
export function viteIslandConfig(options: ViteIslandConfigOptions): ViteIslandConfig {
  const runtime = dialectRuntimeDeps(options.dialect);

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
    optimizeDeps: { include: runtime.include, entries: [SCAN_ENTRY_PATH] },
    resolve: {
      alias: options.dialect === "preact" ? preactAliases() : [],
      dedupe: runtime.dedupe,
    },
  };
}
