/**
 * @volo/queue — a durable job queue on the SQL database.
 *
 *   const queue = new Queue({ db });
 *   queue.define("send_email", async ({ to }) => { ... });
 *   queue.enqueue("send_email", { to: "ada@example.com" });
 *   const worker = queue.work();        // drains forever; worker.stop() drains gracefully
 *
 *   const schedule = new Scheduler({ queue });
 *   schedule.cron("0 9 * * *", "daily_digest");
 *   schedule.start();
 */

export { Queue, installSchema } from "./queue";
export type { QueueOptions, Worker, WorkOptions } from "./queue";

export { cronMatches, Scheduler } from "./scheduler";
export type { SchedulerHandle, SchedulerOptions, StartOptions } from "./scheduler";

export { RetentionScheduler } from "./retention";
export type {
  RetentionClock,
  RetentionHandle,
  RetentionOptions,
  RetentionResult,
  RetentionStartOptions,
  RetentionTask,
} from "./retention";

export {
  isPermanentFailure,
  VoloError,
  permanentFailure,
  PERMANENT_FAILURE,
  QueueError,
} from "./errors";
export type { PermanentFailure, QueueErrorCode } from "./errors";

export { systemClock } from "./time";

export type {
  Clock,
  Dialect,
  EnqueueOptions,
  Job,
  JobContext,
  JobEvent,
  JobHandler,
  JobObserver,
  JobStatus,
  JsonObject,
  JsonValue,
  QueueStats,
  RunOutcome,
  RunResult,
  SqlDatabase,
  SqlStatement,
} from "./types";
