/**
 * The vocabulary of a form: the kinds of fields it can hold, a single field's
 * shape, and the whole form spec the AI (or a human) emits as plain data.
 */

/** The input kinds a form field can take. */
export type FieldType = "text" | "email" | "number" | "checkbox" | "textarea" | "select";

/** One field in a form: its name, kind, and presentation/validation hints. */
export interface FormField {
  name: string;
  type: FieldType;
  label?: string;
  required?: boolean;
  options?: string[];
}

/** A whole form: where it submits, how, and the fields it collects. */
export interface FormSpec {
  action: string;
  fields: FormField[];
  method?: "post" | "patch";
  submitLabel?: string;
}
