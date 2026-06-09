/**
 * The form components: the vetted vocabulary @keel/forms ships to @keel/ui.
 *
 * Three components compose every form:
 *   Form    — the <form> wrapper, carries `action` and `method`
 *   Field   — one labelled input; its `type` chooses the control
 *   Submit  — the submit button, carries its `label`
 *
 * Each is a plain `ComponentDef`: a prop schema, a child policy, and a `render`
 * that turns validated props into real React elements. The package depends only
 * on @keel/ui's types — never on @keel/ui-kit — so it ships its own controls.
 */

import { createElement } from "react";
import type { ReactElement, ReactNode } from "react";

import type { ComponentDef } from "@keel/ui";

/** The field kinds the registry advertises, kept in lockstep with `FieldType`. */
const FIELD_TYPES = ["text", "email", "number", "checkbox", "textarea", "select"] as const;

/** Read a prop as a string, or fall back to `""` when it is absent. */
function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Read a prop as a boolean; only a real `true` counts. */
function asBoolean(value: unknown): boolean {
  return value === true;
}

/** Read a prop as a string array, or an empty list when it is absent. */
function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** The Form wrapper: a real <form> carrying its action and method. */
export const Form: ComponentDef = {
  name: "Form",
  description: "A form wrapper.",
  props: {
    action: { type: "string", required: true },
    method: { type: "enum", values: ["post", "patch"], default: "post" },
  },
  children: ["Field", "Submit"],
  render: (props, children) =>
    createElement(
      "form",
      { action: asString(props.action), method: asString(props.method) },
      children,
    ),
};

/** The control for a field, chosen by its `type`. */
function fieldControl(
  name: string,
  type: string,
  required: boolean,
  options: string[],
): ReactElement {
  if (type === "textarea") {
    return createElement("textarea", { name, required });
  }

  if (type === "select") {
    return createElement(
      "select",
      { name, required },
      options.map((option) => createElement("option", { key: option, value: option }, option)),
    );
  }

  if (type === "checkbox") {
    return createElement("input", { name, type: "checkbox", required });
  }

  // text / email / number map straight onto a native input of that type.
  return createElement("input", { name, type, required });
}

/** The Field component: a labelled control whose `type` picks the input. */
export const Field: ComponentDef = {
  name: "Field",
  description: "A single labelled form field.",
  props: {
    name: { type: "string", required: true },
    type: { type: "enum", values: FIELD_TYPES, default: "text" },
    label: { type: "string" },
    required: { type: "boolean", default: false },
    options: { type: "array" },
  },
  children: false,
  render: (props) => {
    const name = asString(props.name);
    const type = asString(props.type);
    const required = asBoolean(props.required);
    const options = asStringArray(props.options);

    const control = fieldControl(name, type, required, options);

    // A label is optional; render the bare control when none was given.
    const label = props.label;

    if (typeof label !== "string") {
      return createElement("label", { "data-field": name }, control);
    }

    const caption: ReactNode = label;

    return createElement("label", { "data-field": name }, caption, control);
  },
};

/** The Submit component: a submit button carrying its label. */
export const Submit: ComponentDef = {
  name: "Submit",
  description: "A form submit button.",
  props: {
    label: { type: "string", default: "Submit" },
  },
  children: false,
  render: (props) => createElement("button", { type: "submit" }, asString(props.label)),
};

/** The form ComponentDefs, in declaration order: Form, Field, Submit. */
export function formComponents(): ComponentDef[] {
  return [Form, Field, Submit];
}
