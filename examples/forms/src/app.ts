/**
 * examples/forms — @lesto/forms schema-driven forms behind real HTTP routes.
 *
 * A signup form defined as plain DATA (a `FormSpec`), rendered to HTML on GET and
 * validated on POST — the same spec drives both, so the form and its rules can
 * never drift apart. The journey shows every piece of the battery:
 *
 *   GET  /signup    render the spec to an HTML `<form>` (via @lesto/ui/server)
 *   POST /signup    validate the submission; on success record it and show a
 *                   confirmation, on failure RE-RENDER the form with an error list
 *   GET  /signups   read the accepted signups
 *
 * The form's `action` is guarded by `@lesto/forms` itself: a `javascript:` (or
 * off-origin) action is dropped rather than rendered as a script-running submit
 * target — see `renderFormMarkup` and the XSS test.
 *
 * `@lesto/forms` is used for the whole form lifecycle (`renderForm`,
 * `createFormRegistry`, `validateSubmission`, and the `FormSpec` type); the tree
 * is serialized to HTML with `@lesto/ui/server`; the routes are `@lesto/web`.
 * There is no database — a form is render + validate, nothing more.
 */

import { createFormRegistry, renderForm, validateSubmission } from "@lesto/forms";
import type { FormSpec, RenderFormOptions } from "@lesto/forms";
import { renderPage, renderPageMarkup } from "@lesto/ui/server";
import { lesto } from "@lesto/web";
import type { Lesto } from "@lesto/web";

/** The signup form, as data. The one source of truth for both render and validate. */
export const signupSpec: FormSpec = {
  action: "/signup",
  method: "post",
  submitLabel: "Create account",
  fields: [
    { name: "email", type: "email", label: "Email", required: true },
    { name: "age", type: "number", label: "Age" },
    { name: "plan", type: "select", label: "Plan", options: ["free", "pro"], required: true },
    { name: "bio", type: "textarea", label: "Bio" },
    { name: "terms", type: "checkbox", label: "I accept the terms", required: true },
  ],
};

/** The registry of vetted form components (Form / Field / Submit). Immutable. */
const formRegistry = createFormRegistry();

/** Minimal HTML-escape for the few places we reflect user/spec text into a page. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Render a `FormSpec` to its `<form>` HTML.
 *
 * `renderForm` turns the spec into a `@lesto/ui` tree; `renderPage` +
 * `renderPageMarkup` (from `@lesto/ui/server`) serialize it. The Form component's
 * own `action` guard runs here, so an unsafe action never reaches the markup.
 *
 * `options` is optional and threads a failed submission's errors + prior values
 * into the fields that need them (see `signupPage`) — omit it for a plain render.
 */
export function renderFormMarkup(spec: FormSpec, options?: RenderFormOptions): string {
  return renderPageMarkup(renderPage(formRegistry, renderForm(spec, options)));
}

/** Wrap body HTML in a minimal document. */
function page(bodyHtml: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<title>Sign up</title></head><body>${bodyHtml}</body></html>`
  );
}

/**
 * The signup page: the schema-driven form, with any failed submission's errors
 * shown beside their field and prior values preserved — `renderForm`'s `options`
 * does both, so there is no more hand-rolled `<ul data-errors>` summary above an
 * emptied form.
 */
function signupPage(errors?: Record<string, string>, values?: Record<string, unknown>): string {
  return page(
    renderFormMarkup(signupSpec, {
      // exactOptionalPropertyTypes: only attach a key when its value is set.
      ...(errors === undefined ? {} : { errors }),
      ...(values === undefined ? {} : { values }),
    }),
  );
}

/**
 * Read a submission into a values map.
 *
 * A real browser posts `application/x-www-form-urlencoded` (a string), which we
 * parse; a JSON client (or the test) posts a decoded object, which we use as-is.
 * An absent/other body is an empty submission — `validateSubmission` then reports
 * the required fields.
 */
function submittedValues(body: unknown): Record<string, unknown> {
  if (typeof body === "string") {
    const values: Record<string, unknown> = {};
    for (const [key, value] of new URLSearchParams(body)) values[key] = value;

    return values;
  }

  if (body !== null && typeof body === "object") return body as Record<string, unknown>;

  return {};
}

/** One accepted signup — only the fields the app keeps. */
export interface Signup {
  readonly email: string;
  readonly plan: string;
}

/** The routes, closing over the store of accepted signups. */
export function buildFormsApp(deps: { signups: Signup[] }): Lesto {
  const { signups } = deps;

  return lesto()
    .get("/signup", (c) => c.html(signupPage()))
    .post("/signup", (c) => {
      const values = submittedValues(c.req.body);

      const { valid, errors } = validateSubmission(signupSpec, values);

      // Invalid: re-render the SAME form with per-field errors beside their
      // fields AND the submitted values preserved, so the user doesn't retype
      // everything. 422, so a client can tell a validation refusal from a
      // success without scraping HTML.
      if (!valid) return c.html(signupPage(errors, values), 422);

      const signup: Signup = { email: String(values.email), plan: String(values.plan) };
      signups.push(signup);

      return c.html(page(`<h1 data-success>Welcome, ${escapeHtml(signup.email)} 🎉</h1>`), 201);
    })
    .get("/signups", (c) => c.json(signups));
}

/** What `buildApp` returns: the app and the in-memory store the test inspects. */
export interface Booted {
  readonly app: Lesto;
  readonly signups: Signup[];
}

/** Boot the forms app. No database — a form is render + validate. */
export function buildApp(): Booted {
  const signups: Signup[] = [];

  return { app: buildFormsApp({ signups }), signups };
}
