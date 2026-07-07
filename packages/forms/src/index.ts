/**
 * @lesto/forms — schema-driven forms on @lesto/ui.
 *
 *   const spec: FormSpec = {
 *     action: "/signup",
 *     fields: [
 *       { name: "email", type: "email", required: true },
 *       { name: "age", type: "number" },
 *     ],
 *   };
 *
 *   const registry = createFormRegistry();       // Form / Field / Submit
 *   const tree     = renderForm(spec);           // a @lesto/ui UiNode tree
 *   const { valid, errors } = validateSubmission(spec, { email: "a@b.co" });
 *
 * The package ships its own form components, so it never reaches for
 * @lesto/ui-kit — only @lesto/ui's engine and types.
 */

export { Field, Form, formComponents, Submit } from "./components";

export { createFormRegistry } from "./registry";

export { renderForm } from "./render";
export type { RenderFormOptions } from "./render";

export { validateSubmission } from "./validate";

export { FormError, LestoError } from "./errors";
export type { FormErrorCode } from "./errors";

export type { FieldType, FormField, FormSpec } from "./types";
