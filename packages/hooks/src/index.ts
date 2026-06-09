/**
 * @keel/hooks — the WordPress-style extensibility core.
 *
 *   const hooks = new Hooks();
 *
 *   hooks.addAction("user_registered", async (user) => { ...send welcome... });
 *   await hooks.doAction("user_registered", user);
 *
 *   hooks.addFilter("post_title", (title) => String(title).trim(), 5);
 *   const clean = await hooks.applyFilters("post_title", rawTitle);
 *
 * Actions are side effects; filters thread a value through a chain. Lower
 * priority runs first; ties run in insertion order. Pure — no external deps.
 */

export { Hooks } from "./hooks";

export type { ActionListener, FilterListener } from "./types";
