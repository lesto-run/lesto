/**
 * @volo/ui-generate — AI generation of validated @volo/ui trees.
 *
 *   const registry = new Registry().define(...);
 *
 *   const result = await generateUi({
 *     registry,
 *     prompt: "a sign-up form",
 *     complete: anthropicComplete(),   // or any injected Complete in tests
 *   });
 *
 *   if (result.valid) render(result.tree);
 *
 * The registry becomes a forced tool's JSON Schema, the model fills it, and the
 * result is re-validated against the registry before it ever reaches you.
 */

export { generateUi } from "./generate";
export type { Complete, GenerateResult } from "./generate";

export { GenerateError } from "./errors";
export type { GenerateErrorCode } from "./errors";

export { anthropicComplete } from "./anthropic";
