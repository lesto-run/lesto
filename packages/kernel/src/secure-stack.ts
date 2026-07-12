/**
 * `secureStack` — the one composition that turns Lesto's security batteries on.
 *
 * Before the pipeline existed, `@lesto/cors`, `@lesto/ratelimit`, and `@lesto/csrf`
 * were dead code: built, tested, and unmountable. This bundles them into an
 * ordered middleware list an app drops into `createApp({ middleware })`.
 *
 * The order is deliberate and is the onion from outside in:
 *
 *   1. `cors` — outermost, so a preflight is answered before any work and the
 *      `Access-Control-*` headers wrap *every* inner response, including a 429
 *      or 403 (a browser can only read a cross-origin error if it carries CORS
 *      headers).
 *   2. `rateLimit` — a cheap gate next, so a flood is shed before it can reach
 *      the comparatively expensive CSRF crypto or a controller.
 *   3. `originCheck` — the header-based CSRF defense, before the token check so a
 *      forged cross-site request is refused before any crypto runs. Present only
 *      when configured.
 *   4. `csrf` — innermost, the signed-token check, present ONLY when configured.
 *      CORS and rate-limit are safe to enable for everyone; the CSRF checks change
 *      what a token-less / cross-site request can do, so neither is on unless the
 *      app asks.
 *
 * The contract that protects every existing app: with `cors`/`rateLimit`
 * omitted the stack adds nothing in those slots, and with `csrf` omitted no CSRF
 * check runs at all — so a token-less POST keeps working exactly as today until
 * the app opts in.
 *
 * Pit-of-success durability (ADR 0013): pass a `db` and the rate-limit slot
 * is fleet-correct with zero config — it keys every member of the fleet against
 * one shared `sqlRateLimitStore` instead of a per-process `Map`. Omit the `db`
 * in production and the stack warns ONCE (the {@link KERNEL_MEMORY_STORES_CODE}
 * latch) that the limiter is per-process memory — the silent degradation made
 * loud, mirroring `@lesto/ratelimit`'s `RATELIMIT_UNKNOWN_CLIENT` idiom.
 *
 * Durable does NOT mean auto-bounded: the SQL store grows one `lesto_rate_limits`
 * row per distinct client key until a sweep reclaims the dead ones. Pass
 * {@link SecureStackOptions.rateLimitSweep} to have secureStack drive that sweep
 * (unref'd, tear down with {@link stopManagedRateLimitSweeps}); it is opt-in, not
 * default-on, because the table is shared with `@lesto/identity`'s brute-force
 * limiters and only the operator knows a safe retention (see that field's doc).
 */

import type { Dialect } from "@lesto/db";

import { cors } from "@lesto/cors";
import type { CorsOptions } from "@lesto/cors";

import type { SqlSessionStore } from "@lesto/auth";

import { RateLimiter, rateLimit, sqlRateLimitStore, startRateLimitSweep } from "@lesto/ratelimit";
import type {
  RateLimitOptions,
  RateLimitSweepHandle,
  RateLimitSweepOptions,
  SqlDatabase as RateLimitSql,
  SqlRateLimitStore,
} from "@lesto/ratelimit";

import { csrf, originCheck } from "@lesto/csrf";
import type { CsrfOptions, OriginCheckOptions } from "@lesto/csrf";

import type { Middleware } from "@lesto/web";

import type { KernelDatabase } from "./kernel";

/**
 * The stable code the production memory-stores warning carries.
 *
 * Logs and ops tooling branch on this code, never the prose — the house pattern
 * (`@lesto/ratelimit`'s `RATELIMIT_UNKNOWN_CLIENT_CODE`). A `secureStack` built
 * with `production: true` and no `db` cannot share sessions or rate limits across
 * a fleet: each process holds its own buckets, so a flood throttled on one node
 * sails through the next. This code names that hazard so an operator can find it.
 */
export const KERNEL_MEMORY_STORES_CODE = "KERNEL_MEMORY_STORES";

/**
 * The default warning for the production-without-`db` fallback: one
 * `console.warn`, carrying {@link KERNEL_MEMORY_STORES_CODE}.
 */
function warnMemoryStores(): void {
  console.warn(
    `[${KERNEL_MEMORY_STORES_CODE}] secureStack is running in production with no db, so the ` +
      `rate limiter is keyed to PER-PROCESS MEMORY. Limits are not shared across the fleet: a ` +
      `flood throttled on one instance is not throttled on the next, and a restart forgets every ` +
      `bucket. Pass { db } to secureStack (and wire a SQL session store into your identity layer) ` +
      `so sessions and limits are shared through SQL.`,
  );
}

/**
 * The warn-once latch, module-scoped so the warning fires EXACTLY ONCE per
 * process no matter how many `secureStack`s are composed. `secureStack` is a
 * boot-time call, so a single global latch is the right grain — a fleet member
 * misconfigured with memory stores says so once, not on every composed stack.
 *
 * Exported only as a test seam: `resetMemoryStoresWarning` lets the suite cover
 * both the "fires" and the "already fired, stays silent" branches deterministically.
 */
let memoryStoresWarned = false;

/** Test-only: reset the warn-once latch so both latch branches are coverable. */
export function resetMemoryStoresWarning(): void {
  memoryStoresWarned = false;
}

/**
 * Handles for every periodic rate-limit sweep {@link secureStack} has started
 * this process (see {@link SecureStackOptions.rateLimitSweep}). `secureStack`
 * returns a plain `Middleware[]` with nowhere to hand a per-app disposer back, so —
 * like the warn-once latch — the handles live module-scoped and
 * {@link stopManagedRateLimitSweeps} drains them. Every sweep is `unref`'d, so a
 * process can exit cleanly WITHOUT draining; this registry exists for deterministic
 * test teardown and for an app that wants an explicit graceful stop.
 */
const managedSweeps = new Set<RateLimitSweepHandle>();

/**
 * Stop every periodic rate-limit sweep {@link secureStack} started this process,
 * and forget them. Idempotent. A test seam (so a suite can tear down deterministically
 * rather than leaning on the `unref`), and a graceful-shutdown hook for an app that
 * wired {@link SecureStackOptions.rateLimitSweep} and wants the timers torn down on
 * `SIGTERM` instead of at process exit.
 */
export function stopManagedRateLimitSweeps(): void {
  for (const handle of managedSweeps) handle.stop();

  managedSweeps.clear();
}

/**
 * What goes into the secure stack. Every field is optional: an empty
 * `secureStack({})` is an empty pipeline — the no-op floor — and each present
 * field adds exactly its one middleware, in the fixed safe order.
 */
export interface SecureStackOptions {
  /**
   * CORS policy. Present → a `cors` middleware is added (answers preflight,
   * wraps responses). Absent → no CORS middleware, behavior unchanged.
   */
  readonly cors?: CorsOptions;

  /**
   * Rate-limit policy. Present → a `rateLimit` middleware is added, keyed by the
   * request-context client IP. Absent → no rate limiting.
   *
   * The store is chosen by {@link SecureStackOptions.db}: with a `db` the slot is
   * fleet-correct over `sqlRateLimitStore`; without one it is per-process memory.
   * Passing an explicit `limiter` in the options overrides both — your limiter,
   * your store, no auto-wiring and no warning.
   */
  readonly rateLimit?: RateLimitOptions;

  /**
   * Origin / Fetch-Metadata CSRF check. Present → an `originCheck` middleware
   * refuses cross-site state-changing requests by reading `Sec-Fetch-Site` (and
   * `Origin` as a fallback) — no token plumbing required. The cheap, recommended
   * CSRF default; `{ originCheck: {} }` is enough for modern browsers. Absent →
   * no origin check. Pair it with {@link csrf} for defense in depth, or use it
   * alone where the token machinery isn't yet wired.
   */
  readonly originCheck?: OriginCheckOptions;

  /**
   * The browser-safe preset: `true` turns on the recommended cross-site defense
   * (`originCheck` with default options) without the per-deployment ceremony, so
   * a browser-UI app is cross-site-safe by setting ONE field instead of leaning
   * on the `SameSite=Lax` cookie alone. It is shorthand for `originCheck: {}` —
   * an explicit {@link originCheck} always wins, and it deliberately does NOT turn
   * on the signed-token {@link csrf} (that needs token plumbing and would 403
   * token-less requests). API-only services leave it off to keep non-browser
   * clients un-403'd.
   */
  readonly browser?: boolean;

  /**
   * CSRF policy. Present → a `csrf` middleware enforces tokens on state-changing
   * methods. Absent (the default) → NO CSRF enforcement, so a token-less request
   * is untouched. This is the opt-in switch; it is never flipped implicitly.
   */
  readonly csrf?: CsrfOptions;

  /**
   * The SQL handle that makes the stack's stores durable (ADR 0013). Present →
   * the rate-limit slot is wired over `sqlRateLimitStore(db, { dialect })`, so a
   * fleet shares one set of buckets with ZERO config. Absent → the slot falls
   * back to per-process memory (and warns once in {@link production}).
   *
   * This wires the RATE-LIMIT half only. The session half lives on the app's
   * identity layer, which is built before `secureStack`; use {@link durableStores}
   * to construct the matching `sqlSessionStore` over the same handle.
   */
  readonly db?: KernelDatabase;

  /**
   * The SQL dialect the durable rate-limit store renders for. Threaded into
   * `sqlRateLimitStore` so the Postgres `FOR UPDATE` path runs on a PG deploy.
   * Ignored without a {@link db}. Defaults to `"sqlite"`.
   */
  readonly dialect?: Dialect;

  /**
   * Wire a periodic sweep of the durable rate-limit table when secureStack owns
   * the SQL store (a {@link db} is present and you brought no
   * {@link RateLimitOptions.limiter}). A `db` moves the limiter's growth from a
   * self-bounding in-memory Map to `lesto_rate_limits` ROWS — one per distinct
   * client key — so "durable" is NOT "bounded" until something reclaims the dead
   * rows. Present → secureStack starts a `startRateLimitSweep` over the store
   * (unref'd, no-overlap) and tracks it for {@link stopManagedRateLimitSweeps}.
   *
   * It is **opt-in, not default-on**, deliberately:
   *   1. `lesto_rate_limits` is a SHARED table — `@lesto/identity`'s login/TOTP
   *      brute-force limiters key into it too — and a sweep is table-wide, blind to
   *      which limiter owns a row. secureStack knows only THIS per-IP policy's
   *      full-refill horizon, not a co-tenant limiter's, so a framework-chosen
   *      default retention could delete a still-locked-out login bucket (it then
   *      re-materializes full — a brute-force reset). The operator, who knows every
   *      limiter sharing the table, must pick `retentionMs` (see its doc); and
   *   2. `secureStack` returns a plain middleware list with no seam to hand a
   *      per-app disposer back, so the sweep it starts is process-scoped (drained
   *      via {@link stopManagedRateLimitSweeps}), which is an explicit opt-in, not a
   *      hidden always-on timer inside a pure composition.
   *
   * Absent (the default) → NO sweep is started: wire this, call
   * `startRateLimitSweep` yourself, or drive `sweep` from `@lesto/queue`'s
   * `RetentionScheduler`. Ignored without a {@link db} (a memory store self-bounds
   * via its `maxBuckets` cap, so there is nothing to sweep).
   */
  readonly rateLimitSweep?: RateLimitSweepOptions;

  /**
   * Whether this stack runs in production. True + a rate limit + no {@link db} →
   * the memory-store fallback is a real hazard (limits unshared across the
   * fleet), so the stack warns once. False (the default) keeps a dev/test stack
   * quiet — memory stores are correct there.
   */
  readonly production?: boolean;

  /**
   * Called the first time a production stack falls back to memory rate limiting
   * for want of a {@link db}. Defaults to a `console.warn` carrying
   * {@link KERNEL_MEMORY_STORES_CODE}; inject to route it to a real logger, or a
   * no-op to silence it. The warn-once latch is module-scoped, so this fires at
   * most once per process across every composed stack.
   */
  readonly onMemoryStores?: () => void;
}

/** The matched pair of SQL-backed stores wired over one handle (ADR 0013). */
export interface DurableStores {
  /**
   * The fleet-correct session store to hand to your identity layer — the same
   * rows survive a restart and are seen by every node sharing the handle.
   */
  readonly sessionStore: SqlSessionStore;

  /** The fleet-correct rate-limit store `secureStack({ db })` wires for you. */
  readonly rateLimitStore: SqlRateLimitStore;
}

/**
 * Build the matched pair of durable stores over one SQL handle.
 *
 * The app owns its identity layer (built before `secureStack`), so the SESSION
 * store cannot be auto-wired the way the rate-limit one is. This helper closes
 * that gap: construct both stores over the same `db` here, hand `sessionStore`
 * to your identity layer and let `secureStack({ db })` wire the rate-limit half.
 *
 * Lazily imports `@lesto/auth` so the kernel's hot path (no durable stores) never
 * pulls auth's crypto in. The schema must already exist — `createApp` installs
 * it after migrate, or call {@link installDurableSchema} yourself.
 */
export async function durableStores(
  db: KernelDatabase,
  options: { dialect?: Dialect } = {},
): Promise<DurableStores> {
  const { sqlSessionStore } = await import("@lesto/auth");

  return {
    sessionStore: sqlSessionStore(db),
    rateLimitStore: sqlRateLimitStore(db as RateLimitSql, { dialect: pgOrSqlite(options.dialect) }),
  };
}

/**
 * Install both durable-store schemas (sessions + rate limits) on one handle.
 *
 * Idempotent (`IF NOT EXISTS`), so it is safe at every boot. `createApp` calls
 * this after the migrator so the tables exist before the first request; an app
 * wiring stores by hand can call it directly. Lazily imports both store packages
 * so the install cost lands only when durability is actually in play.
 */
export async function installDurableSchema(db: KernelDatabase): Promise<void> {
  const [{ installSessionSchema }, { installRateLimitSchema }] = await Promise.all([
    import("@lesto/auth"),
    import("@lesto/ratelimit"),
  ]);

  await installSessionSchema(db);
  await installRateLimitSchema(db as RateLimitSql);
}

/**
 * The SQL store only knows two dialects (`FOR UPDATE` is its lone fork); the
 * kernel's wider `Dialect` is narrowed here — anything that is not `"postgres"`
 * keys the SQLite path (which needs no row lock).
 */
function pgOrSqlite(dialect: Dialect | undefined): "sqlite" | "postgres" {
  return dialect === "postgres" ? "postgres" : "sqlite";
}

/**
 * Resolve the rate-limit options, swapping in the durable store when a `db` is
 * present (and the caller did not bring its own `limiter`), or warning once when
 * a production stack is left on memory. Returns the options to hand to
 * `rateLimit` — either the original, or a copy carrying the SQL-backed limiter.
 */
function resolveRateLimit(options: SecureStackOptions, policy: RateLimitOptions): RateLimitOptions {
  // The caller brought their own limiter (and thus their own store): an explicit
  // operator choice. No auto-wiring, no warning — exactly as a custom `keyFor`
  // suppresses the unknown-client warning in the middleware.
  if (policy.limiter !== undefined) return policy;

  // A db is wired: build the limiter over the shared SQL store so the fleet
  // throttles as one. Zero config — this is the pit of success.
  if (options.db !== undefined) {
    const store = sqlRateLimitStore(options.db as RateLimitSql, {
      dialect: pgOrSqlite(options.dialect),
    });

    // Durable is not bounded until something reclaims the rows. secureStack owns
    // this store, so wire the sweep here when the caller opts in — see
    // {@link SecureStackOptions.rateLimitSweep} for why it is opt-in, not default-on
    // (a SHARED table whose co-tenant horizons this policy cannot know + no seam to
    // hand a per-app disposer back). The handle is tracked for
    // {@link stopManagedRateLimitSweeps}; the sweep is unref'd, so it never pins the
    // process open.
    if (options.rateLimitSweep !== undefined) {
      managedSweeps.add(startRateLimitSweep(store, options.rateLimitSweep));
    }

    return {
      ...policy,
      limiter: new RateLimiter({
        store,
        capacity: policy.capacity,
        refillPerSecond: policy.refillPerSecond,
      }),
    };
  }

  // No db. In production that is the silent degradation: warn once.
  if (options.production === true && !memoryStoresWarned) {
    memoryStoresWarned = true;
    (options.onMemoryStores ?? warnMemoryStores)();
  }

  return policy;
}

/**
 * Compose the configured security middleware into an ordered list.
 *
 * Builds the list in the fixed `cors → rateLimit → originCheck → csrf` order,
 * including only the middleware whose options were supplied. The result is a
 * plain `readonly Middleware[]` to hand to `createApp({ middleware })` —
 * composable with an app's own middleware (concatenate to add layers around or
 * within).
 */
export function secureStack(options: SecureStackOptions): readonly Middleware[] {
  const middleware: Middleware[] = [];

  if (options.cors !== undefined) {
    middleware.push(cors(options.cors));
  }

  if (options.rateLimit !== undefined) {
    middleware.push(rateLimit(resolveRateLimit(options, options.rateLimit)));
  }

  // The two CSRF defenses sit innermost, both conditional. The cheap header-based
  // origin check runs first (it sheds a forged cross-site request before the
  // token crypto), then the signed-token check. `browser: true` is shorthand for
  // a default origin check; an explicit `originCheck` always wins.
  const effectiveOriginCheck = options.originCheck ?? (options.browser === true ? {} : undefined);

  if (effectiveOriginCheck !== undefined) {
    middleware.push(originCheck(effectiveOriginCheck));
  }

  // CSRF token is last and conditional: enforcement only when explicitly configured.
  if (options.csrf !== undefined) {
    middleware.push(csrf(options.csrf));
  }

  return middleware;
}
