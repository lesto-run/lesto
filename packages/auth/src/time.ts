import type { Clock } from "./types";

/**
 * Time, made injectable.
 *
 * The default clock reads the system wall clock in epoch milliseconds. Tests
 * inject a clock they can stop, so every expiry path is deterministic.
 */
export const systemClock: Clock = () => Date.now();
