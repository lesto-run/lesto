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

## How to deploy / run the hosted leg

```bash
bun run examples/forms/serve.ts
```

Forms has **no database** — `buildApp()` is synchronous and returns a bare
`@lesto/web` app — but `@lesto/kernel`'s `createApp` still requires a `db` handle
to wrap it into a bootable kernel `App`. `serve.ts` opens a THROWAWAY in-memory
SQLite handle purely to satisfy that contract, and passes `durable: false` (no
session/rate-limit tables to install on a handle nothing else touches) and
`secure: false` (no state-changing concern here beyond the form itself). It then
serves the wrapped app behind a real `node:http` server (`@lesto/runtime`'s
`serveWithGracefulShutdown`), so an ACTUAL browser can load `/signup`, submit the
rendered `<form>`, and see the re-render — a real
`application/x-www-form-urlencoded` POST, not a decoded object handed to
`app.handle` directly:

```bash
open http://localhost:3000/signup   # submit it by hand in a browser

# or from the command line (curl's -d defaults to urlencoded):
curl -X POST localhost:3000/signup -d 'plan=enterprise'                          # 422
curl -X POST localhost:3000/signup -d 'email=ada@example.com&plan=pro&terms=on'  # 201
```

**Not run in this sandbox** — starting a server is blocked here. `serve.ts` is
typechecked and oxlint/oxfmt-clean, and its wiring (`buildApp` → `createApp` →
`serveWithGracefulShutdown`) mirrors the pattern every hosted `serve.ts` in the
gallery uses (see `examples/mailing-lists/serve.ts`); running it and submitting
the form by hand is a manual follow-up.

## DX findings

1. **~~Error display is entirely the host's job.~~ RESOLVED.** `@lesto/forms`'
   `renderForm(spec, { errors, values })` now threads a failed submission's
   per-field messages and prior values straight into each `Field` — an error
   renders as a `<span role="alert" data-error="…">` beside its field, and a
   prior value round-trips onto the right control (`value`/`defaultValue` for
   text-ish fields, `checked` for a checkbox, the matching `<option selected>`
   for a select). This example no longer hand-rolls a `<ul data-errors>`
   summary or loses what the user typed on a validation failure — see
   `renderFormMarkup`/`signupPage` in `src/app.ts`.
2. **`validateSubmission` gives one message per field, as prose.** Good for a
   simple form; a caller wanting machine-branchable codes (or multiple errors per
   field) has only the English string. A coded variant would help API clients. →
   `@lesto/forms` (minor).
