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

/**
 * A failed submission's per-field messages and previously-typed values, threaded
 * into the rendered tree so the re-render can show a message beside its field and
 * keep what the user already typed — instead of a hand-rolled error summary above
 * an emptied form. Both are optional; omitting `options` entirely (or passing it)
 * with neither key set produces the same tree as before this option existed.
 */
export interface RenderFormOptions {
  errors?: Record<string, string>;
  values?: Record<string, unknown>;
}

/** The Field node for one spec field, carrying only the props it actually set. */
function fieldNode(field: FormField, options?: RenderFormOptions): UiNode {
  const error = options?.errors?.[field.name];
  const value = options?.values?.[field.name];

  return {
    type: "Field",
    props: {
      name: field.name,
      type: field.type,

      // exactOptionalPropertyTypes: only attach a prop when the spec set it.
      ...(field.label === undefined ? {} : { label: field.label }),
      ...(field.required === undefined ? {} : { required: field.required }),
      ...(field.options === undefined ? {} : { options: field.options }),

      // Only attach an error when one was actually reported for this field.
      ...(typeof error === "string" ? { error } : {}),

      // A checkbox's prior "value" is presence (checked); every other field's
      // prior value is the text it held. Attach only when a value was given at
      // all — an absent key means no prior submission touched this field.
      ...(value === undefined
        ? {}
        : field.type === "checkbox"
          ? { checked: Boolean(value) }
          : { value: String(value) }),
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

/**
 * Build the Form tree for a spec: a Field per field, then a Submit.
 *
 * `options` threads a failed submission's errors and prior values into the
 * fields that need them (see {@link RenderFormOptions}). Omitting it produces
 * the exact same tree `renderForm` always has.
 */
export function renderForm(spec: FormSpec, options?: RenderFormOptions): UiNode {
  const fields = spec.fields.map((field) => fieldNode(field, options));

  return {
    type: "Form",
    props: {
      action: spec.action,

      ...(spec.method === undefined ? {} : { method: spec.method }),
    },
    children: [...fields, submitNode(spec)],
  };
}
