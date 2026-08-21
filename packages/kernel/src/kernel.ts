/**
 * The application kernel: it assembles a Lesto app from its parts.
 *
 * Everything a Lesto app is made of meets here — the database, the migrations
 * that shape it, and the composed `lesto()` app that maps and answers requests.
 * The kernel wires them together into one bootable `App` and owns the assembly
 * order: run pending migrations against the supplied database, then delegate
 * dispatch to the app.
 *
 * Handlers query the database through `@lesto/db` (see ADR 0004) — they close
 * over a typed `Db` from the app's factory rather than reaching for a global.
 * The kernel itself never touches the data layer beyond handing `config.db` to
 * the migrator.
 *
 * Deliberately transport-free. The node:http listener and the CLI are thin
 * adapters that feed an `App` and write its responses back; they live
 * elsewhere. What lives here is the pure, fully-coverable assembly +
 * delegation.
 */

import type { Dialect, SqlDatabase } from "@lesto/db";

import { Migrator } from "@lesto/migrate";
import type { MigrationEntry } from "@lesto/migrate";

import { runPipeline } from "@lesto/web";
import type {
  HandleOptions,
  Lesto,
  LestoRequest,
  LestoResponse,
  Middleware,
  UiDialect,
} from "@lesto/web";

import { installDurableSchema, secureStack } from "./secure-stack";
import type { SecureStackOptions } from "./secure-stack";

/**
 * The default per-client rate limit a `createApp` app gets unless it says
 * otherwise — a flood-shedding safety net, not a tight quota. Generous on
 * purpose: a single client rarely issues 100 dynamic requests in a burst, and
 * the bucket refills at 50/s, so legitimate use (and any normal test) never
 * trips it while a sustained flood is shed. Apps tune it via `secure.rateLimit`.
 */
export const KERNEL_DEFAULT_RATE_LIMIT = { capacity: 100, refillPerSecond: 50 } as const;

/**
 * Resolve the app-wide security middleware the kernel wraps every request in.
 *
 * Deny-by-omission would be the wrong default (a forgetful app shipping with no
 * rate limit is the readiness review's residual DoS vector), so the safe baseline
 * is rate-limiting ON, keyed per client IP — see {@link KERNEL_DEFAULT_RATE_LIMIT}.
 * The CSRF/CORS layers are deliberately NOT defaulted: a forced origin/token check
 * 403s legitimate non-browser API clients, and their safe policy is
 * deployment-specific, so they stay one field away (`secure: { originCheck: {} }`)
 * rather than implicit (ADR 0016). An app that serves a BROWSER UI should set
 * `secure: { browser: true }` (the shorthand that turns on the recommended
 * origin-check defense) — without it the only cross-site defense is the session
 * cookie's `SameSite=Lax`.
 *
 *   - `secure: false` — opt out entirely (an app composing its own `secureStack`).
 *   - `secure` omitted — the rate-limit baseline above.
 *   - `secure: {...}` — layered OVER the baseline: a spelled `rateLimit` retunes
 *     it; `originCheck`/`cors`/`csrf` add to it; the durable store + dialect are
 *     threaded in so the app need not repeat the `db` wiring.
 *
 * The rate-limit store is the fleet-correct SQL one when the durable schema is
 * installed (`durable !== false`, the default); a `durable: false` deploy gets
 * per-process memory buckets, matching its opt-out of the SQL stores.
 */
function resolveSecure(config: LestoAppConfig): readonly Middleware[] {
  if (config.secure === false) return [];

  const durableWiring: Pick<SecureStackOptions, "db" | "dialect"> =
    config.durable === false ? {} : { db: config.db, dialect: config.dialect ?? "sqlite" };

  // The rate-limit baseline is always present; the app's own `secure` fields LAYER
  // over it — a spelled `rateLimit` retunes it, while `originCheck`/`cors`/`csrf`
  // add to it — so turning ON a CSRF check never silently turns OFF the DoS net.
  // Opt out of the baseline entirely with `secure: false` (handled above).
  return secureStack({
    rateLimit: { ...KERNEL_DEFAULT_RATE_LIMIT },
    ...durableWiring,
    // `config.secure` is `SecureStackOptions | undefined` here (the `false` case
    // returned above); spreading `undefined` is a no-op, so no fallback is needed.
    ...config.secure,
  });
}

/**
 * The one database handle the kernel threads through the migrator — the canonical
 * `@lesto/db` SQL surface, re-exported here under the kernel's own name.
 *
 * `@lesto/migrate` consumes `exec` (for DDL) + `prepare` (for the bookkeeping
 * table); `@lesto/db` consumes the same shape for the runtime query layer. A
 * single better-sqlite3 (or future Postgres) adapter satisfies both
 * structurally, so the kernel hands the same handle to the migrator and the app
 * wraps it in `createDb(handle)` for its controllers.
 *
 * It used to be a *separate* interface with the identical shape, which made the
 * kernel's handle and `@lesto/queue`'s `SqlDatabase` nominally distinct: feeding
 * one `openSqlite` handle into both `createApp` and `new Queue({ db })` forced a
 * `handle as unknown as SqlDatabase` cast even though the methods matched. It is
 * now an alias of `@lesto/db`'s `SqlDatabase` (which `@lesto/queue` re-exports too),
 * so the same handle flows into `createDb`, `createApp`, `new Queue({ db })`, and
 * every `installSchema` with NO cast. The kernel's `schemas` seam closes over the
 * same type — see {@link LestoAppConfig.schemas}. The alias is retained (rather
 * than dropped for a bare re-export) so existing imports of `KernelDatabase`
 * keep resolving.
 */
export type KernelDatabase = SqlDatabase;

/**
 * One served request's access record, as handed to {@link LestoAppConfig.logRequest}.
 *
 * A STRUCTURAL MIRROR of `@lesto/runtime`'s `AccessEntry`, not an import: `@lesto/runtime`
 * depends on this package, so importing it here would close a dependency cycle. (The same
 * shape `EdgeAccessEntry`, `RequestTracer`, and `TraceparentParser` are already mirrored in.)
 *
 * Drift is caught by the compiler, but only in ONE direction on its own. `@lesto/cli`'s
 * `runServe` assigns a config's `logRequest` into `serve`'s option, and under
 * `strictFunctionTypes` a callback parameter is CONTRAVARIANT — so that assignment rejects a
 * field REMOVED from `AccessEntry` or RETYPED, while a field ADDED to it compiles clean and
 * silently never reaches an app's sink. Addition is the likely direction (both `truncated` and
 * `activeStreams` arrived that way), so the honest guard is the explicit both-ways assertion in
 * `@lesto/cli`'s `test/run.test.ts` — the one package that can see both types.
 */
export interface AccessLogEntry {
  readonly method: string;

  readonly path: string;

  readonly status: number;

  readonly ms: number;

  /** The per-request id, shared with the request context and the request span. */
  readonly requestId: string;

  /** The trace this request ran on, when a tracer is wired; absent when it is not. */
  readonly traceId?: string;

  /** Present (`true`) only when the response body tore down mid-stream. */
  readonly truncated?: boolean;

  /** The concurrent held-stream gauge, present only on a long-lived-stream line (ADR 0040). */
  readonly activeStreams?: number;
}

/**
 * Everything needed to assemble an app: a composed `lesto()` app, its database,
 * and migrations.
 *
 * Routes, pages, and middleware all live on the `app` — there is no separate
 * `router`/`controllers`/`middleware` to thread (ADR 0004). The kernel runs
 * migrations, then delegates dispatch straight to `app.handle`.
 */
export interface LestoAppConfig {
  db: KernelDatabase;

  app: Lesto;

  /**
   * Schema migrations to bring the database up to date on boot. Absent means
   * none. Pass the literal `"skip"` for a fleet member that must NOT migrate on
   * boot — when one instance (or a separate release step) owns the migration and
   * the rest should come up against the already-migrated schema. `"skip"` runs
   * zero migrations and reports an empty applied list.
   */
  migrations?: MigrationEntry[] | "skip";

  /**
   * The SQL dialect the boot migrations render DDL for. Defaults to `"sqlite"`.
   * A Postgres deploy MUST set `"postgres"` or the migrator emits SQLite-only
   * DDL (`GENERATED ALWAYS AS IDENTITY` becomes `AUTOINCREMENT`, which Postgres
   * rejects) and skips the advisory-lock boot guard. The app wires the same
   * dialect into its own `createDb(handle, { dialect })`.
   */
  dialect?: Dialect;

  /**
   * The UI client/server dialect (ADR 0007/0008's matched pair). The single key
   * that drives BOTH the island client bundle's `react`→`preact/compat` alias
   * (read by the CLI for `lesto dev`/`build`) AND the page server renderer
   * (applied to `app` here, on boot). `{ dialect: "preact" }` shrinks the island
   * runtime to ~10 KB gzip; absent (or `"react"`) keeps React streaming, the
   * default. `createApp` wires the server half; the CLI wires the client half
   * from the same value, so the two can never diverge.
   *
   * `css` is the Tailwind v4 CSS entry (ADR 0037) — the `@import "tailwindcss"`
   * source the CLI compiles to `out/styles.css` on `build`/`dev`. Read by the CLI
   * only; defaults by convention to `app/styles/app.css`, and the build is skipped
   * entirely when the resolved file is absent (Tailwind stays opt-in). The server
   * never reads it — the stylesheet `<link>` is injected via `lesto().styles(...)`
   * (the matched sibling of `.client(...)`).
   *
   * `cssScanRoot` is the directory Tailwind scans for utility classes, relative to
   * the project root (CLI-only, ADR 0037). Defaults to `app/` — the convention for
   * a standard app whose components live under `app/`. An app whose markup lives
   * elsewhere (e.g. a marketing/docs site with components in `src/`) points it
   * there so its classes are not missed.
   */
  ui?: { dialect: UiDialect; css?: string; cssScanRoot?: string };

  /**
   * Where a one-line access record goes for each served request — the app's own sink,
   * REPLACING `@lesto/runtime`'s `defaultLogRequest`. Absent keeps that default (a
   * structured JSON line per request), so an app that sets nothing is unchanged.
   *
   * `serve` has always taken this seam; what it lacked was a way for an APP to reach it.
   * `lesto serve` builds its serve options itself, so a project had no hook and every
   * deploy got the default sink — which logs `path` VERBATIM. That is a real leak for a
   * URL that carries a credential in the path (a signed calendar/feed URL, a capability
   * link): the secret lands in stdout and then in whatever ships logs onward. Setting
   * this to a redacting sink makes that an app-level control, configured where the rest
   * of the app is configured.
   *
   * Read by `@lesto/cli` on the `lesto serve` path; the kernel itself never calls it (it
   * wires no server), the same way it carries `ui.css` for the CLI to read.
   *
   * SCOPE — this is the served stdout access line, and nothing else:
   *   - `lesto dev` does NOT honour it. Dev installs its own sink to feed the dev-state
   *     ring the MCP control plane reads (ADR 0032), so a dev run still logs — and still
   *     records — the verbatim path.
   *   - A Cloudflare Worker entry builds its own app and passes its own `logRequest` to
   *     `toFetchHandler`, so it never reads this field.
   *   - With `LESTO_OTLP_URL` set, the request SPAN still carries `http.path` verbatim.
   *     Redacting the log does not redact the trace.
   *
   * A custom sink REPLACES the default wholesale rather than layering on it, so a sink
   * that only forwards to a collector also silences the console line — call
   * `defaultLogRequest` from inside it when you want both. It is a SINK, not a
   * transform: returning a redacted string changes nothing, and a throw is caught and
   * reported rather than failing the request.
   */
  logRequest?: (entry: AccessLogEntry) => void;

  /**
   * Install the durable-store schemas (sessions + rate limits, ADR 0013) on the
   * `db` after migrate, so a SQL-backed `sqlSessionStore` / `sqlRateLimitStore`
   * has its tables ready before the first request. This is the pit-of-success
   * default: a `createApp({ db })` app gets durable, fleet-correct stores with
   * zero config — pair it with `secureStack({ db })` for limits and
   * `durableStores(db)` for the session half.
   *
   * Set `false` to opt OUT — for a deploy whose sessions/limits are deliberately
   * per-process memory, or a fleet member that defers schema installation to the
   * release step that owns the migration. The schema install is idempotent
   * (`IF NOT EXISTS`), so leaving it on is harmless even when nothing uses the
   * tables. Defaults to `true`.
   */
  durable?: boolean;

  /**
   * Extra schema installers a battery brings to the table — run in order against
   * the same `db`, right after migrations (and the durable-store install).
   *
   * This is the kernel seam for first-class batteries that ride a SQL table of
   * their own but are NOT part of the app's `migrations`. `@lesto/queue` is the
   * motivating case: `@lesto/mail` enqueues delivery jobs onto the queue, so a
   * mail app needs the `lesto_jobs` table before the first `mailer.send`. Without
   * this seam the app had to *remember* to call `@lesto/queue`'s `installSchema`
   * separately, or the first send hit a missing table. Now it declares the
   * dependency once:
   *
   *   import { installSchema } from "@lesto/queue";
   *   await createApp({ db, app, migrations, schemas: [installSchema] });
   *
   * Each installer takes the same {@link KernelDatabase} handle `createApp` runs
   * everything else against — so one `openSqlite` handle feeds `createDb`,
   * `createApp`, and `new Queue({ db })` with no cast (the unified `@lesto/db` SQL
   * surface). Installers are expected to be idempotent (`IF NOT EXISTS`), like
   * the durable-store install, so they are safe at every boot. They run AFTER
   * `installDurableSchema` and in array order, awaited serially, so a later
   * installer may depend on an earlier one's tables.
   *
   * Orthogonal to {@link durable}: `durable` governs only the built-in
   * session/rate-limit schemas; `schemas` is the open-ended list a battery opts
   * into. Absent (or empty) means no extra installers run.
   */
  schemas?: ReadonlyArray<(db: KernelDatabase) => Promise<void>>;

  /**
   * The app-wide security baseline the kernel wraps every request in (ADR 0016).
   *
   * Omitted — the pit-of-success default: per-client rate limiting is ON (a
   * flood-shedding net, see {@link KERNEL_DEFAULT_RATE_LIMIT}), keyed by the
   * resolved client IP and backed by the same durable SQL store the kernel
   * installs. CSRF/CORS stay OFF by default — a forced origin/token check refuses
   * legitimate non-browser API clients, and their safe policy is
   * deployment-specific — so a browser app turns them on explicitly, one field
   * away: `secure: { browser: true }` (shorthand for the recommended origin check).
   *
   * `{ ...SecureStackOptions }` — layer your own policy OVER the baseline: add
   * `browser: true` / `originCheck` (CSRF) / `cors` / the signed-token `csrf`, or retune `rateLimit`.
   * The rate-limit net stays on unless you override it, and the kernel threads its
   * `db` + `dialect` in so you need not repeat them. `false` — opt out entirely,
   * for an app that composes `secureStack` on its own `lesto()` chain (and must not
   * get it twice).
   */
  secure?: SecureStackOptions | false;
}

/** A booted application: a request handler plus the record of what migrations ran. */
export interface App {
  /**
   * Dispatch a request through the web core, returning the controller's
   * response.
   *
   * `options` is `@lesto/web`'s {@link HandleOptions} — the same shape
   * `Lesto.handle` takes — so it carries `rawBytes` (the byte-exact companion
   * to `rawBody`) end-to-end: a caller with the raw wire bytes (e.g. the
   * site dispatcher forwarding an inbound webhook) can pass them through the
   * kernel's `App.handle` and have them reach a controller's
   * `c.req.rawBytes`, never widened away at this seam.
   */
  handle(method: string, path: string, options?: HandleOptions): Promise<LestoResponse>;

  /** The migration versions applied during boot, in the order they ran. */
  readonly migrationsApplied: readonly string[];
}

/**
 * Assemble a bootable app from its parts.
 *
 * The order is the contract: bring the schema up to date *first*, then delegate
 * dispatch over the now-ready database — so a handler's first query hits a
 * migrated schema, not an empty one.
 */
export async function createApp(config: LestoAppConfig): Promise<App> {
  // Run pending migrations up front so the schema is ready before any
  // request. No migrations configured means nothing ran — empty applied list.
  // Migrations are async now (ADR 0006): await them so the schema is fully
  // applied before dispatch is stood up — a query's first hit must land on a
  // migrated schema, never a half-applied one.
  // `undefined` (no migrations configured) and `"skip"` (a fleet member that
  // defers to another instance's migrate) both run nothing — empty applied list.
  const migrationsApplied: readonly string[] =
    config.migrations === undefined || config.migrations === "skip"
      ? []
      : await new Migrator(config.db, config.migrations, {
          dialect: config.dialect ?? "sqlite",
        }).migrate();

  // Durable stores are the pit-of-success default (ADR 0013): install the
  // session + rate-limit schemas right after migrate so a SQL-backed store has
  // its tables before the first request. Idempotent (`IF NOT EXISTS`), so it is
  // safe even when nothing uses the tables; `durable: false` opts a deliberately
  // memory-store (or migration-deferring) deploy out of the install entirely.
  // A ternary (not a bare `if`) so coverage scores both arms — the install and
  // the explicit `durable: false` skip — without an un-instrumentable implicit else.
  await (config.durable === false ? Promise.resolve() : installDurableSchema(config.db));

  // Then the battery-declared installers (Finding #2): a mail app passes
  // `schemas: [installSchema]` so `@lesto/queue`'s `lesto_jobs` table exists before
  // the first `mailer.send` enqueues. Run serially, in array order, against the
  // same handle — a later installer may build on an earlier one's tables, and the
  // serial await keeps the boot order deterministic. `?? []` so the absent case is
  // a zero-iteration loop, not an implicit branch coverage can't reach.
  for (const installSchema of config.schemas ?? []) {
    await installSchema(config.db);
  }

  // The lesto() app owns dispatch (routes, pages, and middleware all live on it),
  // so the kernel just delegates to app.handle once the schema is ready.
  //
  // The matched pair's SERVER half (ADR 0008) is wired elsewhere: under the CLI's
  // in-process Node/Bun runtime the page renderer is React (`react-dom/server`) —
  // the process is NOT aliased to Preact — so the server renderer stays React even
  // when `ui.dialect: "preact"` selects the Preact CLIENT bundle. That pairing is
  // sound for deferred (`ssr: false`) islands, which mount fresh on the Preact
  // client and never hydrate server markup (the scaffold's default). Full
  // server-side Preact (byte-identical `ssr: true` markup) is the estate bespoke
  // path, where the WHOLE worker process is aliased react→preact/compat at build
  // time and the app calls `.renderer(preactServerRenderer)` itself — a Preact
  // server renderer cannot consume React's `createElement` output in a React
  // process, so the CLI does not force it. The `applyUiDialect` / `.renderer()`
  // seam + the `WEB_DIALECT_MISMATCH` guard remain for that bespoke wiring; the
  // CLI drives only the client half from `ui.dialect`.
  // The app-wide security baseline (rate-limit on by default; CSRF/CORS opt-in).
  // Built ONCE here — the rate limiter's buckets must outlive a single request —
  // then wrapped around every dispatch. An opt-out (`secure: false`) yields an
  // empty list and the original zero-overhead delegation.
  const secure = resolveSecure(config);

  return {
    migrationsApplied,
    handle: (method, path, options) => {
      if (secure.length === 0) return config.app.handle(method, path, options);

      // The security middleware reads the request (originCheck inspects headers;
      // rate-limit reads the ambient request context's resolved IP, established by
      // the transport around this call), then delegates to the app. The pipeline's
      // coded refusals (429/403) are string-bodied, so the narrow back to
      // `LestoResponse` holds.
      const request: LestoRequest = {
        method,
        path,
        params: {},
        query: options?.query ?? {},
        headers: options?.headers ?? {},
        body: options?.body,
      };

      return runPipeline(secure, request, () =>
        config.app.handle(method, path, options),
      ) as Promise<LestoResponse>;
    },
  };
}
