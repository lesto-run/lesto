import type { Clock } from "./types";

/**
 * Time, made injectable.
 *
 * The default clock reads the wall clock in epoch milliseconds. Tests inject a
 * frozen clock instead, so every expiry path is deterministic and nothing waits.
 */
export const systemClock: Clock = () => Date.now();
