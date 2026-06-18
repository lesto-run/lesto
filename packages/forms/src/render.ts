/**
 * Spec -> @lesto/ui tree.
 *
 * `renderForm` is pure data assembly: it turns a `FormSpec` into a plain
 * `UiNode` Form tree — one Field node per spec field, then a single Submit —
 * that the form Registry validates and renders. No React here; the tree is the
 * AI-shaped JSON the engine consumes.
 */

import type { UiNode } from "@lesto/ui";

import type { FormField, FormSpec } from "./types";

/** The Field node for one spec field, carrying only the props it actually set. */
function fieldNode(field: FormField): UiNode {
  return {
    type: "Field",
    props: {
      name: field.name,
      type: field.type,

      // exactOptionalPropertyTypes: only attach a prop when the spec set it.
      ...(field.label === undefined ? {} : { label: field.label }),
      ...(field.required === undefined ? {} : { required: field.required }),
      ...(field.options === undefined ? {} : { options: field.options }),
    },
  };
}

/** The Submit node for a spec, defaulting its label when none was given. */
function submitNode(spec: FormSpec): UiNode {
  return {
    type: "Submit",
    props: spec.submitLabel === undefined ? {} : { label: spec.submitLabel },
  };
}

/** Build the Form tree for a spec: a Field per field, then a Submit. */
export function renderForm(spec: FormSpec): UiNode {
  const fields = spec.fields.map(fieldNode);

  return {
    type: "Form",
    props: {
      action: spec.action,

      ...(spec.method === undefined ? {} : { method: spec.method }),
    },
    children: [...fields, submitNode(spec)],
  };
}
