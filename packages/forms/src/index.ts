/**
 * @keel/forms — schema-driven forms on @keel/ui.
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
 *   const tree     = renderForm(spec);           // a @keel/ui UiNode tree
 *   const { valid, errors } = validateSubmission(spec, { email: "a@b.co" });
 *
 * The package ships its own form components, so it never reaches for
 * @keel/ui-kit — only @keel/ui's engine and types.
 */

export { Field, Form, formComponents, Submit } from "./components";

export { createFormRegistry } from "./registry";

export { renderForm } from "./render";

export { validateSubmission } from "./validate";

export { FormError, KeelError } from "./errors";
export type { FormErrorCode } from "./errors";

export type { FieldType, FormField, FormSpec } from "./types";
