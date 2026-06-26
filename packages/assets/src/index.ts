/**
 * @lesto/assets — the framework-owned client-asset pipeline (ADR 0011, Seam 2).
 *
 *   const deps = viteBuildClientDeps(projectRoot);
 *   await buildClient({ islandsDir, outDir, mode: "production", dialect: "preact" }, deps);
 *
 * Synthesizes the island hydration entry from an `app/islands/` convention (the
 * framework writes the `client.tsx` an app used to hand-author), bundles it
 * (splitting + the opt-in preact dialect), and sweeps stale chunks — so an app
 * ships an optimized `/client.js` with no bespoke build script.
 *
 * The orchestration (`buildClient`) and the decision logic (`synthesizeEntry`,
 * `isChunkFile`, the alias map) are pure and bundler-agnostic; the real bundler +
 * filesystem wiring is the injected deps. Two backends ship: `viteBuildClientDeps`
 * (Vite/Rolldown — `lesto build`, sharing ONE bundler with the `lesto dev` island
 * server, DX-parity R2 Phase 2) and `bunBuildClientDeps` (`Bun.build` — the dev
 * fallback for an app that opts out of the `@lesto/island-dev` Vite dev server).
 */

export { buildClient } from "./build-client";
export type {
  ArtifactSize,
  BuildClientDeps,
  BuildClientOptions,
  BuildClientResult,
  BuildMode,
  BuildReport,
  BundleArtifact,
  BundleRequest,
  Dialect,
} from "./build-client";

export { islandFileFromModule, synthesizeEntry } from "./synthesize";
export type { BeaconConfig, IslandFile } from "./synthesize";

// The browser-RUM wiring the synthesized entry emits (ARCHITECTURE.md §7): the
// `@lesto/observability/rum` import + the `startBrowserRum()` call.
export { RUM_MODULE, rumImport, rumStartCall } from "./rum-client";
export type { RumConfig } from "./rum-client";

export {
  BEACON_PATH,
  DEFAULT_SAMPLE_RATE,
  errorClass,
  hydrateEvent,
  reportClientErrors,
  shouldSample,
} from "./client-beacon";
export type { BeaconEvent, BeaconEventKind, BeaconOptions, BeaconPayload } from "./client-beacon";

export { isChunkFile } from "./chunks";

export { verifyPublicEnvDefine } from "./public-env";
export type { PublicEnvDefine } from "./public-env";

export { PREACT_ALIAS } from "./preact-alias";

// The Vite dialect config (preact alias + per-dialect dedupe/include) shared by the
// prod island build (`vite-build.ts`) and the `@lesto/island-dev` dev server, so the
// two bundlers can never drift in how the dialect resolves.
export { dialectRuntimeDeps, preactAliases } from "./vite-alias";
export type { DialectAlias, DialectRuntimeDeps } from "./vite-alias";

export { bunBuildClientDeps } from "./bun";

export { viteBuildClientDeps } from "./vite-build";

export { AssetsError, LestoError } from "./errors";
export type { AssetsErrorCode } from "./errors";
