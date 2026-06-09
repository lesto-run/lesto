import { QueueError } from "./errors";
import { systemClock } from "./time";

import type { Queue } from "./queue";
import type { Clock, JsonValue } from "./types";

/**
 * The scheduler turns time into jobs.
 *
 * All of the *deciding* lives in `tick(now)` — a pure function of the clock —
 * so it is trivially testable without real timers. `start()` is the thin wire
 * that calls `tick` on a cadence; that is all it does, and all it should.
 */

const CRON_FIELDS = 5;

function matchField(field: string, value: number): boolean {
  return field.split(",").some((part) => {
    if (part === "*") {
      return true;
    }

    if (part.startsWith("*/")) {
      return value % Number(part.slice(2)) === 0;
    }

    if (part.includes("-")) {
      const dash = part.indexOf("-");

      return value >= Number(part.slice(0, dash)) && value <= Number(part.slice(dash + 1));
    }

    return Number(part) === value;
  });
}

/** Does a 5-field cron expression (`min hour day month weekday`) match `date`? */
export function cronMatches(expression: string, date: Date): boolean {
  const fields = expression.trim().split(/\s+/);

  if (fields.length !== CRON_FIELDS) {
    throw new QueueError(
      "QUEUE_INVALID_CRON_EXPRESSION",
      `A cron expression needs exactly ${CRON_FIELDS} fields: "${expression}".`,
      { expression },
    );
  }

  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];

  return (
    matchField(minute, date.getMinutes()) &&
    matchField(hour, date.getHours()) &&
    matchField(day, date.getDate()) &&
    matchField(month, date.getMonth() + 1) &&
    matchField(weekday, date.getDay())
  );
}

interface CronEntry {
  readonly expression: string;
  readonly name: string;
  readonly payload: JsonValue;
  lastMinuteKey: string | null;
}

interface IntervalEntry {
  readonly everyMs: number;
  readonly name: string;
  readonly payload: JsonValue;
  lastRunAt: number | null;
}

export interface SchedulerOptions {
  readonly queue: Queue;
  readonly clock?: Clock;
}

export interface StartOptions {
  readonly intervalMs?: number;
  readonly setInterval?: (callback: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

export interface SchedulerHandle {
  stop(): void;
}

export class Scheduler {
  private readonly queue: Queue;

  private readonly clock: Clock;

  private readonly crons: CronEntry[] = [];

  private readonly intervals: IntervalEntry[] = [];

  constructor(options: SchedulerOptions) {
    this.queue = options.queue;
    this.clock = options.clock ?? systemClock;
  }

  /** Register a cron entry. Validates the expression eagerly. */
  cron(expression: string, name: string, payload: JsonValue = {}): this {
    cronMatches(expression, this.clock());

    this.crons.push({ expression, name, payload, lastMinuteKey: null });

    return this;
  }

  /** Enqueue `name` every `everyMs`, fired by `tick`. */
  every(everyMs: number, name: string, payload: JsonValue = {}): this {
    this.intervals.push({ everyMs, name, payload, lastRunAt: null });

    return this;
  }

  /** Evaluate every entry at `now`, enqueueing those due. Returns how many fired. */
  tick(now: Date = this.clock()): number {
    const minuteKey = now.toISOString().slice(0, 16); // yyyy-mm-ddThh:mm

    const dueCrons = this.crons.filter(
      (entry) => entry.lastMinuteKey !== minuteKey && cronMatches(entry.expression, now),
    );

    for (const entry of dueCrons) {
      entry.lastMinuteKey = minuteKey;
      this.queue.enqueue(entry.name, entry.payload);
    }

    const dueIntervals = this.intervals.filter(
      (entry) => entry.lastRunAt === null || now.getTime() - entry.lastRunAt >= entry.everyMs,
    );

    for (const entry of dueIntervals) {
      entry.lastRunAt = now.getTime();
      this.queue.enqueue(entry.name, entry.payload);
    }

    return dueCrons.length + dueIntervals.length;
  }

  /** Begin ticking on a cadence. The handle stops the cadence. */
  start(options: StartOptions = {}): SchedulerHandle {
    const intervalMs = options.intervalMs ?? 1000;
    const setTimer = options.setInterval ?? ((callback, ms) => setInterval(callback, ms));
    const clearTimer = options.clearInterval ?? ((handle) => clearInterval(handle as never));

    const handle = setTimer(() => {
      this.tick();
    }, intervalMs);

    return {
      stop: (): void => clearTimer(handle),
    };
  }
}
