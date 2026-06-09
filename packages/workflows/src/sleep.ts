import type { Sleep } from "./types";

/**
 * The default sleep: a real timer.
 *
 * Injected by the Engine only when the caller provides none, so production code
 * waits for wall-clock time while tests substitute an instant, inspectable spy.
 */
export const systemSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
