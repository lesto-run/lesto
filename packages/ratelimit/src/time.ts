import type { Clock } from "./types";

/**
 * Time, made injectable.
 *
 * The default clock reads the wall clock in epoch milliseconds; tests inject a
 * controllable clock so every refill path is deterministic with no real waiting.
 */

export const systemClock: Clock = () => Date.now();
