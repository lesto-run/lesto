---
title: "Forms"
description: "@lesto/forms is a schema-driven forms layer on @lesto/ui: describe a form once as a FormSpec, then render it to a UI tree and validate submissions back against the same spec."
section: Batteries
order: 16
---

# Forms

`@lesto/forms` is a small, schema-driven forms layer built on
[`@lesto/ui`](/concepts). You describe a form once as a plain `FormSpec` — where
it submits and the fields it collects — and the package does two jobs from that
single description: it renders the spec to a `@lesto/ui` tree (the markup), and
it validates a submission's raw values back against the same spec (the server
check). One spec, both ends, so the rendered form and the validation can't drift
apart.

The spec is plain JSON, which is the point: a model — or a human — can emit it,
and the same vetted vocabulary (`Form` / `Field` / `Submit`) renders it safely.
The package ships its own form components, so it never reaches for a component
kit — only `@lesto/ui`'s engine and types.

## Describe a form

A `FormSpec` is data: an `action`, a list of `fields`, and two optional
presentation hints (`method`, `submitLabel`). Each `FormField` carries a `name`,
a `type`, and optional `label` / `required` / `options`:

```ts
import type { FormSpec } from "@lesto/forms";

const signup: FormSpec = {
  action: "/signup",
  method: "post", // "post" | "patch"; defaults to "post"
  submitLabel: "Join",
  fields: [
    { name: "email", type: "email", required: true },
    { name: "age", type: "number" },
    { name: "plan", type: "select", options: ["free", "pro"], required: true },
    { name: "agree", type: "checkbox", label: "I agree", required: true },
  ],
};
```

The field `type` is a closed set — `FieldType` is `"text" | "email" | "number" |
"checkbox" | "textarea" | "select"`. Each kind maps to a native control: `text`
/ `email` / `number` to an `<input>` of that type, `textarea` to a `<textarea>`,
`select` to a `<select>` over its `options`, and `checkbox` to a checkbox input.

## Render the spec to a tree

`renderForm(spec)` is pure data assembly: it turns the spec into a `@lesto/ui`
`UiNode` — a `Form` node wrapping one `Field` node per field, then a single
trailing `Submit`. There's no React here; the result is the plain JSON tree the
`@lesto/ui` engine consumes.

```ts
import { createFormRegistry, renderForm } from "@lesto/forms";
import { validateTree } from "@lesto/ui";
import { renderTree } from "@lesto/ui/server";

const registry = createFormRegistry(); // a Registry with Form, Field, Submit
const tree = renderForm(signup);

// Optional: confirm the tree matches the vetted vocabulary before rendering.
const check = validateTree(registry, tree); // { valid, errors }

// Server render to a React element you hand to your page.
const { element, errors } = renderTree(registry, tree);
```

`createFormRegistry()` returns a fresh `@lesto/ui` `Registry` preloaded with the
three form components, so a form tree validates and renders against a known
vocabulary with no extra wiring. `renderForm` only attaches the props a field
actually set — an omitted `label`, `required`, or `options` is left off the node
entirely rather than emitted as `undefined`.

## Validate a submission

`validateSubmission(spec, values)` reconciles the raw values a form posted
against the same spec. It's pure — no throws, no I/O — and returns a per-field
error map plus an overall `valid` flag the caller acts on:

```ts
import { validateSubmission } from "@lesto/forms";

const { valid, errors } = validateSubmission(signup, {
  email: "ada@example.com",
  plan: "pro",
  agree: true,
});

if (!valid) {
  // errors is { [fieldName]: message }, e.g. { age: "age must be a number" }
}
```

The rules are deliberately small and run per field:

- **required** — a missing or all-whitespace value fails (`"<name> is required"`).
- **email** — must match a simple `one@dotted.domain` shape (not full RFC 5322).
- **number** — must parse to a finite number (`Number`, not `NaN`).
- **select** — the value must be one of the field's `options`.
- **checkbox** — coerced to a boolean; it never fails on its own, so it only
  participates via the `required` check.

Type rules judge only a *present, non-blank* value. An optional field that was
omitted — or sent blank — is silently fine; enforcing presence is the `required`
check's job alone.

## Reject a bad submission with a coded error

When you want to turn a failed validation into a thrown error your handler can
branch on, use `FormError`. It extends `LestoError` (re-exported here for
convenience) and carries a stable, machine-readable `code` — the only
`FormErrorCode` is `"FORM_INVALID"` — alongside a frozen `details` bag:

```ts
import { FormError, validateSubmission } from "@lesto/forms";

const { valid, errors } = validateSubmission(signup, values);

if (!valid) {
  throw new FormError("FORM_INVALID", "submission rejected", { errors });
}
```

Branch on `error.code`, never on the message string — messages are free to
change for humans without breaking machines. See
[Validation](/guides/validation) for where this sits relative to boundary
validation, and [Observability](/batteries/observability) for how coded errors
surface in traces.

## Notes and gotchas

- **One spec drives both sides.** `renderForm` and `validateSubmission` read the
  same `FormSpec`. Validation is independent of `@lesto/ui` — it inspects the
  spec directly — so you can validate a submission without rendering anything.
- **The `action` is treated as untrusted.** Because a form spec can be
  AI-composed, the `Form` component runs an allowlist on `action` at render
  time: only `https:` / `http:` or a plain relative URL passes. A
  `javascript:` / `data:` / `vbscript:` scheme, a protocol-relative `//host`,
  or one disguised with embedded tabs/newlines is **dropped** (the form falls
  back to posting to the current URL) and reported via a `console.warn` coded
  `FORM_UNSAFE_ACTION`. This is an XSS defense, not a convenience default.
- **Email validation is intentionally loose.** The pattern is one `@` and a
  dotted domain — enough to catch obvious typos, not a deliverability check.
  Treat it as a first gate, not proof an address exists.
- **A select with no `options` rejects every value.** A present value on a
  `select` field with no `options` array fails the membership check. Give every
  `select` its options, or the field can never validate.
- **Method is `post` or `patch` only.** `FormSpec.method` is a two-value union;
  there is no `get` / `put` / `delete`. The `Form` component defaults a missing
  method to `post`, and `Submit` defaults a missing label to `"Submit"`.
- **No client-side runtime.** This package builds the markup and validates the
  values; it does not ship a browser controller, live field-level validation, or
  submission wiring. Post the form to a route and call `validateSubmission`
  there. See [Routing](/guides/routing) for handling the request.

For the rendering engine these forms target, see [Concepts](/concepts); for the
broader request lifecycle, [the quickstart](/quickstart).
