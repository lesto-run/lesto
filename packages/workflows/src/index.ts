/**
 * @keel/workflows — durable workflows on the SQL database.
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
 *   // Re-running the same runId replays completed steps instead of re-charging.
 *   await engine.run("checkout", "order-42", { card: "tok_abc" });
 */

export { Engine, installWorkflowSchema } from "./engine";
export type { EngineOptions } from "./engine";

export { systemSleep } from "./sleep";

export { KeelError, WorkflowError } from "./errors";
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
