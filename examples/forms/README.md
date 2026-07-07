# examples/forms — schema-driven forms over HTTP

Wires **`@lesto/forms`** behind real HTTP routes: one `FormSpec` renders an HTML
form on GET and validates the submission on POST, so the form and its rules can
never drift apart.

## What it shows

A signup form defined as plain **data**:

```ts
const signupSpec: FormSpec = {
  action: "/signup",
  method: "post",
  fields: [
    { name: "email", type: "email", required: true },
    { name: "plan", type: "select", options: ["free", "pro"], required: true },
    // …
  ],
};
```

| Route          | Behavior                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /signup`  | `renderForm(spec)` → a `@lesto/ui` tree → HTML (`@lesto/ui/server`).                                                                                    |
| `POST /signup` | `validateSubmission(spec, values)` — on success, record + confirm (`201`); on failure, **re-render the same form** with a per-field error list (`422`). |
| `GET /signups` | The accepted signups.                                                                                                                                   |

- **One spec, both halves.** The fields the form renders are exactly the fields
  validation knows about.
- **Real form bodies.** A browser posts `application/x-www-form-urlencoded`; the
  route parses that string, and also accepts a decoded JSON object.
- **Unsafe actions are dropped.** The Form component refuses a `javascript:` (or
  off-origin) `action` and drops the attribute rather than rendering a
  script-running submit target — proven in the test.

Only `@lesto/forms`' public API drives the form lifecycle (`renderForm`,
`createFormRegistry`, `validateSubmission`, the `FormSpec` type); the tree is
serialized with `@lesto/ui/server`; routes are `@lesto/web`. **No database** — a
form is render + validate, nothing more.

## How to run

```bash
bun run examples/forms/run.ts
```

Renders the form, submits an invalid body (watch the per-field errors come back),
submits a valid one (confirmation), and reads the accepted signups.

## How it's tested (the QA gate)

```bash
bun run --filter '@lesto/example-forms' test
```

`test/forms.test.ts` asserts, over HTTP: the spec renders real controls (email
input, select with options, textarea, checkbox, submit label); a valid submission
is recorded with a confirmation; a missing/blank submission re-renders with
`… is required` per field and records nothing; present-but-invalid values report
type errors (`must be a valid email` / `must be a number` / `must be one of the
allowed options`); a real urlencoded body works; and an unsafe `action` is dropped
with a coded `FORM_UNSAFE_ACTION` warning.

## DX findings

1. **Error display is entirely the host's job.** `@lesto/forms` renders the form
   and validates a submission, but the two are disconnected at render time: the
   `Field` components take no error/`value` props, so re-rendering a _failed_
   submission can't show the message next to the field or preserve what the user
   typed — this example lists errors in a separate `<ul>` and renders an empty
   form beneath. An optional `renderForm(spec, { errors, values })` that threaded
   messages + prior values into each `Field` would make the invalid-submission
   round-trip (the common case) pleasant instead of hand-rolled. → `@lesto/forms`.
2. **`validateSubmission` gives one message per field, as prose.** Good for a
   simple form; a caller wanting machine-branchable codes (or multiple errors per
   field) has only the English string. A coded variant would help API clients. →
   `@lesto/forms` (minor).
