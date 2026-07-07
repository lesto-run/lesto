/**
 * The example's QA gate: drive @lesto/forms through the REAL HTTP routes. It
 * proves what only an end-to-end wiring can — that the SAME spec renders a usable
 * form and validates a submission; that a valid post is recorded and an invalid
 * one comes back with per-field errors; that a real urlencoded body works; and
 * that the Form component drops an unsafe `action` before it can render.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, renderFormMarkup } from "../src/app";

/** Pull the `<li data-error>` messages out of a re-rendered form page. */
function errorsIn(html: string): string[] {
  return [...html.matchAll(/data-error="[^"]*">([^<]*)</g)].map((m) => m[1] ?? "");
}

describe("@lesto/forms example — the signup journey over HTTP", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the schema-driven form on GET", async () => {
    const { app } = buildApp();

    const res = await app.handle("GET", "/signup");
    expect(res.status).toBe(200);

    const html = res.body as string;
    // The spec's shape shows up as real controls.
    expect(html).toContain("<form");
    expect(html).toContain('action="/signup"');
    expect(html).toContain('method="post"');
    expect(html).toContain('type="email"');
    expect(html).toContain("<select"); // the plan field
    expect(html).toContain('value="pro"'); // one of its options
    expect(html).toContain("<textarea"); // the bio field
    expect(html).toContain('type="checkbox"'); // the terms field
    expect(html).toContain("Create account"); // the submit label
  });

  it("records a valid submission and shows a confirmation", async () => {
    const { app, signups } = buildApp();

    const res = await app.handle("POST", "/signup", {
      body: { email: "ada@example.com", age: "36", plan: "pro", terms: "on" },
    });
    expect(res.status).toBe(201);
    expect(res.body as string).toContain("Welcome, ada@example.com");

    expect(signups).toEqual([{ email: "ada@example.com", plan: "pro" }]);

    const list = await app.handle("GET", "/signups");
    expect(JSON.parse(list.body as string)).toEqual([{ email: "ada@example.com", plan: "pro" }]);
  });

  it("re-renders with per-field errors on a missing/blank submission", async () => {
    const { app, signups } = buildApp();

    const res = await app.handle("POST", "/signup", { body: {} });
    expect(res.status).toBe(422);

    const errors = errorsIn(res.body as string);
    // Every required field is reported, and nothing was recorded.
    expect(errors).toContain("email is required");
    expect(errors).toContain("plan is required");
    expect(errors).toContain("terms is required");
    expect(signups).toHaveLength(0);

    // The form itself is still on the page for the user to correct.
    expect(res.body as string).toContain("<form");
  });

  it("reports type errors on present-but-invalid values", async () => {
    const { app } = buildApp();

    const res = await app.handle("POST", "/signup", {
      body: { email: "not-an-email", age: "abc", plan: "enterprise", terms: "on" },
    });
    expect(res.status).toBe(422);

    const errors = errorsIn(res.body as string);
    expect(errors).toContain("email must be a valid email");
    expect(errors).toContain("age must be a number");
    expect(errors).toContain("plan must be one of the allowed options");
  });

  it("accepts a real urlencoded form body", async () => {
    const { app, signups } = buildApp();

    // What a browser actually posts: a urlencoded string, not JSON.
    const res = await app.handle("POST", "/signup", {
      body: "email=grace%40example.com&plan=free&terms=on",
    });
    expect(res.status).toBe(201);
    expect(signups).toEqual([{ email: "grace@example.com", plan: "free" }]);
  });

  it("drops an unsafe form action instead of rendering it (XSS guard)", () => {
    // The Form component reports a refused action through a coded console.warn.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const markup = renderFormMarkup({
      action: "javascript:alert(1)",
      fields: [{ name: "q", type: "text" }],
    });

    // Positive control: a form WAS rendered (so the negatives below aren't
    // vacuously true on empty output) — just without the dangerous action.
    expect(markup).toContain("<form");
    expect(markup).toContain('name="q"');

    // The dangerous scheme never reaches the DOM, and the attribute is dropped so
    // the form posts to the current URL rather than a script-running target.
    expect(markup).not.toContain("javascript:");
    expect(markup).not.toContain("action=");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("FORM_UNSAFE_ACTION"));
  });
});
