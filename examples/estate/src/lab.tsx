/**
 * The `/lab` zone — a gallery of framework features, each on its own `.page`.
 *
 * Where the marketing zone shows auth-aware static and `/mls` shows the real app,
 * `/lab` is the deliberate test-bench: one page per capability, composed as a sub
 * app that `controllers.ts` mounts (so every lab page inherits the EstateLayout +
 * the root's client runtime + secureStack). It exercises, end to end:
 *
 *   - SSR data fetching + a typed `:id` param      (`/lab/listings/:id`)
 *   - shell-first streaming with `<Suspense>`       (`/lab/streaming`)
 *   - CSR data fetching through the typed client    (`/lab` — the LiveListing island)
 *   - feature flags (`@volo/flags`, off → 404)      (`/lab/flags`)
 *   - authorization (`@volo/authz`, deny-by-default)(`/lab/admin`)
 *   - the data route the CSR island calls           (`GET /lab/api/listings/:id`)
 *   - admin CRUD + an audit trail (`@volo/admin`)    (`/lab/admin/api/*`)
 */

import type { ReactNode } from "react";

import { volo } from "@volo/web";
import type { Context, Handler, VoloResponse, Volo } from "@volo/web";
import { defineFlags } from "@volo/flags";
import { createGuard, definePolicy } from "@volo/authz";
import { createTableSql, defineTable, integer, text } from "@volo/db";
import type { Db } from "@volo/db";
import { AdminError, createAdmin } from "@volo/admin";
import type { Admin, AuditEvent } from "@volo/admin";
import { z } from "zod";

import { Button, Hero, ListingCard, Main, Section, SiteHeader } from "./ui/components";
import { LiveListing } from "./ui/live-listing";
import { DeferredPanel } from "./ui/deferred-panel";
import { buildContentRoutes } from "./content";
import type { ContentStore } from "./content";
import { LISTINGS, findListing, formatPrice } from "./listings";
import type { Listing } from "./listings";

// A flag that gates the preview page: off by default (→ 404), flipped on by the
// dynamic `?preview=1` escape hatch (the static default otherwise wins).
const flags = defineFlags({
  defaults: { "lab-preview": false },
  resolve: (_flag, c) => (c.query("preview") === "1" ? true : undefined),
});

// One policy, deny-by-default: only the `admin` role may reach `lab.admin`.
const policy = definePolicy({
  roles: ["guest", "admin"],
  can: { "lab.admin": ["admin"] },
});
const { can } = createGuard(policy);

// A demo roles middleware: in a real app the roles come from the session; here
// `?role=admin` is the knob, so the authz demo is self-contained.
const withDemoRole: Handler = (c, next) => {
  c.set("roles", c.query("role") === "admin" ? ["admin"] : ["guest"]);

  return next();
};

/** The lab landing page: links to each demo + the live (CSR) listing island. */
function LabIndex(): ReactNode {
  return (
    <>
      <SiteHeader />

      <Main>
        <Hero
          heading="Framework Lab"
          sub="One page per capability — the playground's test bench."
        />

        <Section title="Pages">
          <p className="copy">
            <Button href="/lab/listings/bel-air-glen">SSR data + typed param</Button>{" "}
            <Button href="/lab/streaming">Async server data</Button>{" "}
            <Button variant="ghost" href="/lab/flags?preview=1">
              Feature flag
            </Button>{" "}
            <Button variant="ghost" href="/lab/admin?role=admin">
              Authorization
            </Button>{" "}
            <Button variant="ghost" href="/lab/content/welcome">
              DB-driven page
            </Button>
          </p>
        </Section>

        <Section title="CSR data fetching (the LiveListing island)">
          <p className="copy">
            This card is fetched in the BROWSER, after hydration, through the typed @volo/client —
            the client-side twin of the server-resolved Account island.
          </p>

          <LiveListing listingId="malibu-cliff" />
        </Section>

        <Section title="Deferred hydration (the DeferredPanel island)">
          <p className="copy">
            Below the fold on purpose: this island's JavaScript wires up only when it scrolls into
            view (`hydrate: "visible"`).
          </p>

          <DeferredPanel />
        </Section>
      </Main>
    </>
  );
}

/** SSR data fetching + a typed `:id` param: the listing is resolved on the server. */
function ListingDetailPage({
  id,
  listing,
}: {
  id: string;
  listing: Listing | undefined;
}): ReactNode {
  return (
    <>
      <SiteHeader />

      <Main>
        {listing === undefined ? (
          <Hero heading="Not found" sub={`No listing "${id}".`} />
        ) : (
          <>
            <Hero
              heading={listing.title}
              sub={`${listing.neighborhood} · ${formatPrice(listing.price)}`}
            />

            <Section title="Resolved on the server">
              <ListingCard
                title={listing.title}
                neighborhood={listing.neighborhood}
                price={formatPrice(listing.price)}
                beds={listing.beds}
                baths={listing.baths}
              />
            </Section>
          </>
        )}
      </Main>
    </>
  );
}

/** A deliberately slow data source, to show the load awaiting before render. */
function slowListings(): Promise<readonly Listing[]> {
  return new Promise((resolve) => setTimeout(() => resolve(LISTINGS), 30));
}

/**
 * Async server data: the `load` awaits a slow source, then the component renders
 * the resolved listings. Portable across runtimes — on Node the document still
 * streams shell-first (every `.page` does), and the Worker renders it buffered
 * under Preact, where a `<Suspense>` + `use()` boundary could not resolve.
 */
function AsyncDataPage({ listings }: { listings: readonly Listing[] }): ReactNode {
  return (
    <>
      <SiteHeader />

      <Main>
        <Hero
          heading="Async server data"
          sub="The load awaited a slow source on the server; the listings render resolved."
        />

        <section className="grid">
          {listings.map((listing) => (
            <ListingCard
              key={listing.id}
              title={listing.title}
              neighborhood={listing.neighborhood}
              price={formatPrice(listing.price)}
              beds={listing.beds}
              baths={listing.baths}
            />
          ))}
        </section>
      </Main>
    </>
  );
}

/** The flag-gated page — only reachable when `lab-preview` resolves on. */
function FlagPage(): ReactNode {
  return (
    <>
      <SiteHeader />

      <Main>
        <Hero
          heading="Preview feature"
          sub="You reached this because the lab-preview flag is on."
        />
      </Main>
    </>
  );
}

/** The authorized page — only reachable for the `admin` role. */
function AdminPage(): ReactNode {
  return (
    <>
      <SiteHeader />

      <Main>
        <Hero heading="Admin only" sub="Cleared the lab.admin policy (deny-by-default)." />
      </Main>
    </>
  );
}

// ---------------------------------------------------------------------------
// The @volo/admin dogfood — `/lab/admin/api/*`
//
// `@volo/admin` is the generic CRUD backbone a WordPress-style admin UI sits
// on. This wires it over the SAME injected store the DB-driven content page
// uses (`ContentStore = () => Promise<Db>`), so the admin runs unchanged on
// Node SQLite (server) and Cloudflare D1 (edge) — no driver in this module the
// Worker can't load. It exists to PROVE the Wave-3 admin hardening end to end:
// paginated `list`, the `fields` projection allow-list, and — the headline —
// the optional `onMutation` audit hook, which every write here flows through so
// the audit trail is observable at `GET /lab/admin/api/audit`.
// ---------------------------------------------------------------------------

/** A tiny admin-managed resource: a note with a title + body and an int PK. */
const notes = defineTable("notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  body: text("body").notNull(),
});

const noteInsert = z.object({
  title: z.string().min(1, "Title is required."),
  body: z.string(),
});

const noteUpdate = z.object({
  title: z.string().min(1).optional(),
  body: z.string().optional(),
});

/** Map an admin error code to the HTTP status the admin UI / API expects. */
function statusForAdminError(code: string): number {
  switch (code) {
    case "ADMIN_UNKNOWN_RESOURCE":
    case "ADMIN_RECORD_NOT_FOUND":
      return 404;
    case "ADMIN_VALIDATION_FAILED":
    case "ADMIN_EMPTY_UPDATE":
      return 422;
    default:
      return 500;
  }
}

/** Run an admin call, turning any `AdminError` into a coded JSON error response. */
async function adminJson(c: Context, run: () => Promise<unknown>): Promise<VoloResponse> {
  try {
    return c.json(await run());
  } catch (error) {
    if (error instanceof AdminError) {
      return c.json({ error: error.code }, statusForAdminError(error.code));
    }

    throw error;
  }
}

/**
 * The admin wiring for one runtime: the `Admin` itself plus the in-process
 * audit log the {@link AuditEvent}s land in. A getter resolves both lazily and
 * exactly once (the underlying store memoizes its `Db`), creating the `notes`
 * table idempotently on first touch.
 */
interface AdminWiring {
  readonly admin: Admin;
  readonly audit: readonly AuditEvent[];
}

/**
 * Build a lazy admin over the injected content store. The audit log is a plain
 * array the `onMutation` hook appends to — the simplest observable sink, and all
 * the dogfood needs to prove the event reaches a host. A real app would forward
 * the event to a durable audit table or a log pipeline instead.
 */
function makeAdminWiring(store: ContentStore): () => Promise<AdminWiring> {
  const audit: AuditEvent[] = [];
  let ready: Promise<AdminWiring> | undefined;

  const open = async (): Promise<AdminWiring> => {
    const db: Db = await store();

    // Create the table idempotently — safe on a persistent D1 across cold starts.
    await db.exec(createTableSql(notes).replace(/^CREATE TABLE/, "CREATE TABLE IF NOT EXISTS"));

    const admin = createAdmin(
      db,
      [
        {
          name: "notes",
          table: notes,
          insertSchema: noteInsert,
          updateSchema: noteUpdate,
          fields: ["title", "body"],
        },
      ],
      { onMutation: (event) => audit.push(event) },
    );

    return { admin, audit };
  };

  return () => (ready ??= open());
}

/** The audit actor for a write — the demo's `?role` knob, so events are attributed. */
function actorOf(c: Context): { actor: string } {
  return { actor: c.query("role") ?? "anonymous" };
}

/** Read a positive integer query param, or `undefined` when absent/invalid. */
function intQuery(c: Context, name: string): number | undefined {
  const raw = c.query(name);
  if (raw === undefined) return undefined;

  const value = Number(raw);

  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * The admin CRUD + audit routes, over the injected store — mounted into `/lab`.
 *
 * Every write carries an `actor` (the demo's `?role` knob, so the audit event is
 * attributed without a real session), and every write flows through the
 * `onMutation` hook, so `GET /lab/admin/api/audit` shows the trail. When no
 * store is configured (a Worker without a D1 binding) the routes answer 503 —
 * the same honest "not configured" signal the content page renders.
 */
function buildAdminRoutes(store?: ContentStore): Volo {
  if (store === undefined) {
    return volo().get("/lab/admin/api/*rest", (c) =>
      c.json({ error: "admin store not configured" }, 503),
    );
  }

  const wiring = makeAdminWiring(store);

  return (
    volo()
      // List notes — paginated + projected (id + declared fields only).
      .get("/lab/admin/api/notes", async (c) => {
        const { admin } = await wiring();
        const limit = intQuery(c, "limit");
        const offset = intQuery(c, "offset");

        return adminJson(c, () =>
          admin.list("notes", {
            ...(limit === undefined ? {} : { limit }),
            ...(offset === undefined ? {} : { offset }),
          }),
        );
      })
      // Create — body is the validated attributes; the audit event records the actor.
      .post("/lab/admin/api/notes", async (c) => {
        const { admin } = await wiring();

        return adminJson(c, () => admin.create("notes", c.req.body, actorOf(c)));
      })
      // Update — `:id` plus a patch; an empty patch surfaces ADMIN_EMPTY_UPDATE (422).
      .patch("/lab/admin/api/notes/:id", async (c) => {
        const { admin } = await wiring();

        return adminJson(c, () =>
          admin.update("notes", Number(c.param("id")), c.req.body, actorOf(c)),
        );
      })
      // Destroy — records a patch-less audit event.
      .delete("/lab/admin/api/notes/:id", async (c) => {
        const { admin } = await wiring();

        return adminJson(c, async () => {
          await admin.destroy("notes", Number(c.param("id")), actorOf(c));

          return { ok: true };
        });
      })
      // The audit trail the onMutation hook fills — the dogfood's observability.
      .get("/lab/admin/api/audit", async (c) => {
        const { audit } = await wiring();

        return c.json(audit);
      })
  );
}

/**
 * Build the `/lab` sub-app — mounted by both the Node app (`controllers.ts`) and
 * the Worker (`edge.ts`). `contentStore` is the DB-driven page's backend: the Node
 * SQLite store on the server, the D1 store on the edge, or `undefined` when no
 * store is configured (the content page then renders a "configure D1" view).
 */
export function buildLabRoutes(contentStore?: ContentStore): Volo {
  // The flag- and authz-gated pages live in their own sub-routers so the gate
  // wraps ONLY that page, not the whole lab zone.
  const flagGated = volo()
    .use(flags.gate("lab-preview"))
    .page("/lab/flags", { component: FlagPage });

  const adminGated = volo()
    .use(withDemoRole)
    .use(can("lab.admin"))
    .page("/lab/admin", { component: AdminPage });

  return (
    volo()
      .page("/lab", { component: LabIndex })
      .page("/lab/listings/:id", {
        load: (c) => {
          const id = c.param("id");

          return { id, listing: findListing(id) };
        },
        component: ListingDetailPage,
      })
      .page("/lab/streaming", {
        load: async () => ({ listings: await slowListings() }),
        component: AsyncDataPage,
      })
      .route(flagGated)
      .route(adminGated)
      // DB-driven (WordPress-style) pages: a block tree loaded by slug.
      .route(buildContentRoutes(contentStore))
      // The @volo/admin dogfood: paginated CRUD + the onMutation audit trail.
      .route(buildAdminRoutes(contentStore))
      // The data route the LiveListing island fetches (typed by `LabApi`).
      .get("/lab/api/listings/:id", (c) => {
        const listing = findListing(c.param("id"));

        return listing === undefined ? c.json({ error: "not found" }, 404) : c.json(listing);
      })
  );
}
