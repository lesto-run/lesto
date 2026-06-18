/**
 * @lesto/workflows — resumable step memoization on the SQL database.
 *
 * Each step's result is journaled the first time it runs; re-invoking `run()`
 * with the same `runId` replays completed steps instead of re-executing them.
 * This is memoization, NOT crash-safe durable execution: resume is caller-driven
 * (the app must re-invoke `run()` with the same `runId` to continue an interrupted
 * run) — there is no run journal or scheduler. See the `Engine` doc for the full
 * boundary; a durable journal + resume driver is deferred post-1.0.
 *
 *   installWorkflowSchema(db);
 *
 *   const engine = new Engine({ db });
 *   engine.define("checkout", async (input, ctx) => {
 *     const charge = await ctx.step("charge", () => chargeCard(input.card));
 *     await ctx.sleep(1000);
 *     const receipt = await ctx.step("receipt", () => emailReceipt(charge));
 *     return receipt;
 *   });
 *
 *   // Re-invoking with the same runId replays completed steps instead of re-charging.
 *   await engine.run("checkout", "order-42", { card: "tok_abc" });
 */

export { Engine, installWorkflowSchema } from "./engine";
export type { EngineOptions } from "./engine";

export { systemSleep } from "./sleep";

export { LestoError, WorkflowError } from "./errors";
export type { WorkflowErrorCode } from "./errors";

export type {
  Dialect,
  Sleep,
  SqlDatabase,
  SqlStatement,
  StepEvent,
  StepObserver,
  WorkflowContext,
  WorkflowFn,
} from "./types";
