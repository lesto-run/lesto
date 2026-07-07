/**
 * examples/workflows — @lesto/workflows step memoization behind real HTTP routes.
 *
 * A checkout workflow with three side-effecting steps — charge the card, reserve
 * inventory, email the receipt — plus a settlement `sleep` in the middle. The
 * whole point of the battery shows up at the HTTP boundary:
 *
 *   - a FIRST `POST /checkout/:orderId` runs every step once and returns the receipt;
 *   - a RE-POST with the same orderId REPLAYS the journaled steps — the card is
 *     never charged twice, and the same receipt comes back;
 *   - if a step FAILS mid-run (the receipt mailer is down), the caller retries the
 *     same orderId and the completed steps (charge, reserve) REPLAY while only the
 *     failed step re-executes — exactly-once for the irreversible charge, across
 *     what is effectively a crash-and-resume.
 *
 * Resume is caller-driven by design (this is memoization, not a durable scheduler
 * — see the `Engine` doc): re-invoking `run()` with the same `runId` is what a
 * retry queue would do. Here the HTTP retry stands in for that driver.
 *
 * The `onStep` observability sink is wired into a per-run trace exposed at
 * `GET /checkout/:orderId/trace`, so "which steps executed vs replayed" is
 * visible over HTTP — that is how the test proves a resume actually replayed.
 *
 * Side effects (charge/reserve/email) are injected services with call counters,
 * so the test can assert exactly-once at the boundary; `sleep` is injected too, so
 * tests never wait on a real timer.
 */

import { Engine, installWorkflowSchema, WorkflowError } from "@lesto/workflows";
import type { Sleep, SqlDatabase, StepEvent } from "@lesto/workflows";
import { lesto } from "@lesto/web";
import type { Lesto } from "@lesto/web";

/** The workflow name, referenced by both `define` and `run`. */
const CHECKOUT = "checkout";

/** A settlement pause between reserving inventory and emailing the receipt. */
const SETTLEMENT_MS = 1_000;

/** What a checkout run is given. `orderId` is the run's identity (also its runId). */
export interface CheckoutInput {
  readonly orderId: string;
  readonly card: string;
  readonly amountCents: number;
}

/** What a completed checkout returns — the ids each step produced. */
export interface CheckoutReceipt {
  readonly chargeId: string;
  readonly reservationId: string;
  readonly receiptId: string;
}

/**
 * The irreversible side effects a checkout performs. Injected so the example can
 * count how many times each actually RAN (the exactly-once proof) and so a test
 * can make the mailer fail on demand to exercise resume.
 */
export interface CheckoutServices {
  chargeCard(input: CheckoutInput): Promise<string>;
  reserveInventory(orderId: string): Promise<string>;
  emailReceipt(orderId: string, chargeId: string): Promise<string>;
  /** Live call counts — the boundary proof that a replay ran no side effects. */
  readonly calls: {
    readonly charges: number;
    readonly reservations: number;
    readonly receipts: number;
  };
}

/**
 * A set of in-memory checkout services with call counters.
 *
 * `failReceiptTimes` makes `emailReceipt` throw that many times before it
 * succeeds — the injected "the mailer is down" fault that lets the test drive a
 * mid-workflow failure and then a resume.
 */
export function createCheckoutServices(
  options: { failReceiptTimes?: number } = {},
): CheckoutServices {
  let charges = 0;
  let reservations = 0;
  let receipts = 0;
  let remainingFailures = options.failReceiptTimes ?? 0;

  return {
    async chargeCard(input: CheckoutInput): Promise<string> {
      charges += 1;

      return `charge_${input.amountCents}_${charges}`;
    },

    async reserveInventory(orderId: string): Promise<string> {
      reservations += 1;

      return `resv_${orderId}_${reservations}`;
    },

    async emailReceipt(orderId: string, chargeId: string): Promise<string> {
      if (remainingFailures > 0) {
        remainingFailures -= 1;

        throw new Error(`receipt mailer unavailable for ${orderId}`);
      }

      receipts += 1;

      return `rcpt_${chargeId}_${receipts}`;
    },

    get calls() {
      return { charges, reservations, receipts };
    },
  };
}

/** The per-run step trace the `onStep` sink fills — what executed vs replayed. */
export type Trace = Map<string, StepEvent[]>;

/** The routes, closing over the engine and the trace the `onStep` sink writes. */
export function buildWorkflowApp(deps: { engine: Engine; trace: Trace }): Lesto {
  const { engine, trace } = deps;

  return lesto()
    .post("/checkout/:orderId", async (c) => {
      const orderId = c.param("orderId");

      const body = c.req.body as { card?: unknown; amountCents?: unknown } | null;
      if (typeof body?.card !== "string" || typeof body.amountCents !== "number") {
        return c.json({ error: "`card` (string) and `amountCents` (number) are required." }, 422);
      }

      const input: CheckoutInput = { orderId, card: body.card, amountCents: body.amountCents };

      try {
        // The same orderId is the runId: re-posting resumes rather than restarts.
        const receipt = await engine.run<CheckoutInput, CheckoutReceipt>(CHECKOUT, orderId, input);

        return c.json(receipt);
      } catch (error) {
        if (error instanceof WorkflowError) {
          // An unknown workflow name is a 400 — a client/programmer error.
          return c.json({ error: error.message, code: error.code }, 400);
        }

        // A step threw (e.g. the mailer is down). The run is resumable: the caller
        // retries the SAME orderId and completed steps replay. 502 = upstream fault.
        return c.json({ error: (error as Error).message, resumable: true }, 502);
      }
    })
    .get("/checkout/:orderId/trace", (c) => {
      const events = trace.get(c.param("orderId")) ?? [];

      // Fold to just what a reader cares about: the step and whether it replayed.
      return c.json(events.map((e) => ({ step: e.step, replayed: e.replayed })));
    });
}

/** What `buildApp` returns: the app plus the handles run.ts / the test need. */
export interface Booted {
  readonly app: Lesto;
  readonly engine: Engine;
  readonly services: CheckoutServices;
  readonly trace: Trace;
}

export interface BuildOptions {
  /** A SQL database handle (from `@lesto/runtime`'s `openSqlite`). */
  readonly handle: SqlDatabase;

  /** The checkout side effects. Injected so the caller owns their counters/faults. */
  readonly services: CheckoutServices;

  /** Injected so tests never wait on a real timer; defaults to the engine's system sleep. */
  readonly sleep?: Sleep;
}

/**
 * Boot the workflow app: install the step-journal schema, build an `Engine` with
 * the trace-collecting `onStep` sink, define the `checkout` workflow over the
 * injected services, and wire the routes.
 *
 * The single `handle` flows straight into `installWorkflowSchema` and the
 * `Engine` — the `@lesto/workflows` SQL seam is exactly `@lesto/runtime`'s SQLite
 * handle shape, so there is no adapter and no cast.
 */
export async function buildApp(options: BuildOptions): Promise<Booted> {
  const { handle, services } = options;

  await installWorkflowSchema(handle);

  const trace: Trace = new Map();

  const engine = new Engine({
    db: handle,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    onStep: (event) => {
      const events = trace.get(event.runId) ?? [];
      events.push(event);
      trace.set(event.runId, events);
    },
  });

  engine.define<CheckoutInput, CheckoutReceipt>(CHECKOUT, async (input, ctx) => {
    // Each `step` memoizes: on a resume its result replays instead of re-running
    // the side effect. The charge is the irreversible one exactly-once protects.
    const chargeId = await ctx.step("charge", () => services.chargeCard(input));
    const reservationId = await ctx.step("reserve", () => services.reserveInventory(input.orderId));

    // A durable pause between reserving and receipting. `sleep` is not a step —
    // it just delays this pass; injected so the test resolves it instantly.
    await ctx.sleep(SETTLEMENT_MS);

    const receiptId = await ctx.step("receipt", () =>
      services.emailReceipt(input.orderId, chargeId),
    );

    return { chargeId, reservationId, receiptId };
  });

  const app = buildWorkflowApp({ engine, trace });

  return { app, engine, services, trace };
}
