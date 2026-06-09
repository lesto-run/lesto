import type { Clock } from "./types";

/**
 * Time, made injectable.
 *
 * The default clock reads the real wall clock in epoch milliseconds; tests pass
 * a frozen clock instead, so every `startedAt` / `endedAt` is deterministic.
 */

export const systemClock: Clock = () => Date.now();
