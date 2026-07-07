import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { validateTree } from "@lesto/ui";
import { renderTree } from "@lesto/ui/server";

import {
  createFormRegistry,
  Field,
  Form,
  formComponents,
  FormError,
  renderForm,
  Submit,
  validateSubmission,
} from "../src/index";
import type { FormSpec } from "../src/index";

// ---------------------------------------------------------------------------
// A spec exercising every FieldType, reused across render + validation tests.
// ---------------------------------------------------------------------------

function fullSpec(): FormSpec {
  return {
    action: "/signup",
    method: "patch",
    submitLabel: "Join",
    fields: [
      { name: "username", type: "text", label: "Username", required: true },
      { name: "email", type: "email", required: true },
      { name: "age", type: "number" },
      { name: "agree", type: "checkbox", required: true },
      { name: "bio", type: "textarea", label: "Bio" },
      { name: "plan", type: "select", options: ["free", "pro"], required: true },
    ],
  };
}

// ---------------------------------------------------------------------------
// formComponents / createFormRegistry
// ---------------------------------------------------------------------------

describe("formComponents", () => {
  it("ships exactly Form, Field, and Submit in order", () => {
    expect(formComponents().map((c) => c.name)).toEqual(["Form", "Field", "Submit"]);

    // The same defs are exported individually for direct registration.
    expect(formComponents()).toEqual([Form, Field, Submit]);
  });
});

describe("createFormRegistry", () => {
  it("registers the three form components", () => {
    const registry = createFormRegistry();

    expect(registry.has("Form")).toBe(true);
    expect(registry.has("Field")).toBe(true);
    expect(registry.has("Submit")).toBe(true);
    expect(registry.all().map((c) => c.name)).toEqual(["Form", "Field", "Submit"]);
  });
});

// ---------------------------------------------------------------------------
// renderForm — tree shape
// ---------------------------------------------------------------------------

describe("renderForm", () => {
  it("builds a Form tree with one Field per field plus a trailing Submit", () => {
    const tree = renderForm(fullSpec());

    expect(tree.type).toBe("Form");
    expect(tree.props).toEqual({ action: "/signup", method: "patch" });

    const children = tree.children ?? [];

    // Six fields then one submit.
    expect(children).toHaveLength(7);

    const types = children.map((child) => (child as { type: string }).type);

    expect(types).toEqual(["Field", "Field", "Field", "Field", "Field", "Field", "Submit"]);

    // The first Field carries every prop the spec set.
    expect(children[0]).toEqual({
      type: "Field",
      props: { name: "username", type: "text", label: "Username", required: true },
    });

    // A field with no label/required/options omits them entirely.
    expect(children[2]).toEqual({
      type: "Field",
      props: { name: "age", type: "number" },
    });

    // The select field carries its options.
    expect(children[5]).toEqual({
      type: "Field",
      props: { name: "plan", type: "select", options: ["free", "pro"], required: true },
    });

    // The Submit carries the spec's label.
    expect(children[6]).toEqual({ type: "Submit", props: { label: "Join" } });
  });

  it("omits method and submit label when the spec leaves them out", () => {
    const tree = renderForm({
      action: "/contact",
      fields: [{ name: "note", type: "textarea" }],
    });

    expect(tree.props).toEqual({ action: "/contact" });

    const children = tree.children ?? [];

    expect(children[0]).toEqual({ type: "Field", props: { name: "note", type: "textarea" } });
    expect(children[1]).toEqual({ type: "Submit", props: {} });
  });

  it("validates against the form registry", () => {
    const result = validateTree(createFormRegistry(), renderForm(fullSpec()));

    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("renders to HTML containing every field name", () => {
    const { element, errors } = renderTree(createFormRegistry(), renderForm(fullSpec()));

    expect(errors).toEqual([]);

    const html = renderToStaticMarkup(element);

    // The <form> wrapper carries action + method.
    expect(html).toContain('<form action="/signup" method="patch">');

    // Every field name surfaces as a control.
    expect(html).toContain('data-field="username"');
    expect(html).toContain('data-field="email"');
    expect(html).toContain('data-field="age"');
    expect(html).toContain('data-field="agree"');
    expect(html).toContain('data-field="bio"');
    expect(html).toContain('data-field="plan"');

    // Each FieldType renders its expected control.
    expect(html).toContain('<input type="text" required="" name="username"');
    expect(html).toContain('<input type="email" required="" name="email"');
    expect(html).toContain('<input type="number" name="age"');
    expect(html).toContain('<input type="checkbox" required="" name="agree"');
    expect(html).toContain('<textarea name="bio">');
    expect(html).toContain('<select name="plan" required="">');
    expect(html).toContain('<option value="free">free</option>');
    expect(html).toContain('<option value="pro">pro</option>');

    // The submit button carries its label.
    expect(html).toContain('<button type="submit">Join</button>');

    // A labelled field shows its caption; an unlabelled one does not.
    expect(html).toContain("Username");
    expect(html).toContain("Bio");
  });

  it("defaults the submit label and method when the registry fills them in", () => {
    const tree = renderForm({ action: "/x", fields: [] });

    const { element } = renderTree(createFormRegistry(), tree);

    const html = renderToStaticMarkup(element);

    // The Submit prop default ("Submit") and Form method default ("post").
    expect(html).toContain('<form action="/x" method="post">');
    expect(html).toContain('<button type="submit">Submit</button>');
  });
});

// ---------------------------------------------------------------------------
// renderForm(spec, { errors, values }) — the failed-submission re-render
// ---------------------------------------------------------------------------

describe("renderForm — errors and values (options)", () => {
  it("renderForm(spec) and renderForm(spec, {}) render identical HTML (no accidental attrs)", () => {
    const noArg = renderToStaticMarkup(
      renderTree(createFormRegistry(), renderForm(fullSpec())).element,
    );
    const emptyOptions = renderToStaticMarkup(
      renderTree(createFormRegistry(), renderForm(fullSpec(), {})).element,
    );

    expect(emptyOptions).toBe(noArg);
    expect(noArg).not.toContain("data-error");
    expect(noArg).not.toContain("checked=");
  });

  it("threads a per-field error into its Field, as the last child, without touching values", () => {
    const { element, errors } = renderTree(
      createFormRegistry(),
      renderForm(fullSpec(), { errors: { email: "email must be a valid email" } }),
    );

    expect(errors).toEqual([]);

    const html = renderToStaticMarkup(element);

    expect(html).toContain(
      '<span role="alert" data-error="email">email must be a valid email</span>',
    );

    // Exactly one field got an error span.
    expect(html.match(/data-error/g)).toHaveLength(1);

    // No prior value was given, so nothing is preserved on any field.
    expect(html).not.toContain("checked=");
    expect(html).not.toContain('name="username" value');
  });

  it("threads prior values into their Fields, routed by field type, without an error", () => {
    const { element, errors } = renderTree(
      createFormRegistry(),
      renderForm(fullSpec(), {
        values: {
          username: "ada",
          email: "ada@example.com",
          age: 36,
          agree: true,
          bio: "hello",
          plan: "pro",
        },
      }),
    );

    expect(errors).toEqual([]);

    const html = renderToStaticMarkup(element);

    expect(html).not.toContain("data-error");

    // Text-ish fields (text/email/number) carry the value as an attribute.
    expect(html).toContain('<input type="text" required="" name="username" value="ada"/>');
    expect(html).toContain(
      '<input type="email" required="" name="email" value="ada@example.com"/>',
    );
    expect(html).toContain('<input type="number" name="age" value="36"/>');

    // A checkbox carries `checked`, never a `value` attribute.
    expect(html).toContain('<input type="checkbox" required="" name="agree" checked=""/>');
    expect(html).not.toContain('name="agree" value');

    // A textarea's prior value is its text content, not an attribute.
    expect(html).toContain('<textarea name="bio">hello</textarea>');

    // A select's prior value marks the matching <option> selected; the other isn't.
    expect(html).toContain('<option value="free">free</option>');
    expect(html).toContain('<option value="pro" selected="">pro</option>');
  });

  it("threads both an error and a prior value onto the same field (the round-trip case)", () => {
    const { element } = renderTree(
      createFormRegistry(),
      renderForm(
        { action: "/x", fields: [{ name: "email", type: "email", required: true }] },
        { errors: { email: "email must be a valid email" }, values: { email: "not-an-email" } },
      ),
    );

    const html = renderToStaticMarkup(element);

    expect(html).toContain('<input type="email" required="" name="email" value="not-an-email"/>');
    expect(html).toContain(
      '<span role="alert" data-error="email">email must be a valid email</span>',
    );
  });

  it("routes a checkbox's prior value through JS truthiness (Boolean), not string coercion", () => {
    // "false" is a non-empty string — truthy in JS — so a naive `checked: value`
    // (skipping the `Boolean()` wrap) would land on the OPPOSITE boolean once the
    // Field schema's own string->boolean coercion ran ("false" -> false).
    const { element } = renderTree(
      createFormRegistry(),
      renderForm(
        { action: "/x", fields: [{ name: "agree", type: "checkbox" }] },
        { values: { agree: "false" } },
      ),
    );

    const html = renderToStaticMarkup(element);

    expect(html).toContain('<input type="checkbox" name="agree" checked=""/>');
  });

  it("escapes an error message that carries HTML-significant characters", () => {
    const { element } = renderTree(
      createFormRegistry(),
      renderForm(
        { action: "/x", fields: [{ name: "note", type: "text" }] },
        { errors: { note: `<script>&"'</script>` } },
      ),
    );

    const html = renderToStaticMarkup(element);

    expect(html).toContain(
      '<span role="alert" data-error="note">&lt;script&gt;&amp;&quot;&#x27;&lt;/script&gt;</span>',
    );
    expect(html).not.toContain("<script>");
  });
});

// ---------------------------------------------------------------------------
// Form action scheme guard (XSS in the AI tree)
// ---------------------------------------------------------------------------

describe("Form action scheme guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps a safe action (https/http/relative)", () => {
    for (const action of ["https://lesto.dev/submit", "http://example.com", "/relative", "?q=1"]) {
      const html = renderToStaticMarkup(Form.render({ action, method: "post" }, null));
      expect(html).toContain(`action="${action}"`);
    }
  });

  it("drops an unsafe action and reports the refusal", () => {
    for (const action of [
      "javascript:alert(1)",
      "JavaScript:alert(1)", // case-insensitive
      "\tjavascript:alert(1)", // leading control char
      "  javascript:alert(1)", // leading whitespace
      "java\tscript:alert(1)", // EMBEDDED tab — browsers strip it mid-URL
      "java\nscript:alert(1)", // EMBEDDED newline
      "java\rscript:alert(1)", // EMBEDDED carriage return
      "/\t/evil.example.com", // embedded-control protocol-relative bypass
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "//evil.example.com", // protocol-relative off-origin
    ]) {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const html = renderToStaticMarkup(Form.render({ action, method: "post" }, null));

      // The attribute is dropped — the form posts to the current URL, not the
      // attacker's target — and the method survives.
      expect(html).not.toContain("action=");
      expect(html).toContain('method="post"');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("FORM_UNSAFE_ACTION"));

      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Component render edge cases (cover every prop branch directly)
// ---------------------------------------------------------------------------

describe("form components", () => {
  it("renders a Field with no label as a bare control", () => {
    const html = renderToStaticMarkup(Field.render({ name: "x", type: "text" }, null));

    expect(html).toBe('<label data-field="x"><input type="text" name="x"/></label>');
  });

  it("renders a Field with a label as a captioned control", () => {
    const html = renderToStaticMarkup(Field.render({ name: "x", type: "text", label: "X" }, null));

    expect(html).toContain("X");
    expect(html).toContain('<input type="text" name="x"');
  });

  it("renders a required textarea field", () => {
    const html = renderToStaticMarkup(
      Field.render({ name: "bio", type: "textarea", required: true }, null),
    );

    expect(html).toContain("<textarea");
    expect(html).toContain('name="bio"');
  });

  it("renders a select with no options as an empty select", () => {
    const html = renderToStaticMarkup(Field.render({ name: "s", type: "select" }, null));

    expect(html).toContain("<select");
    expect(html).not.toContain("<option");
  });

  it("coerces absent/odd props to safe defaults", () => {
    // No props at all: name -> "", type -> "", required -> false, options -> [].
    const html = renderToStaticMarkup(Field.render({}, null));

    expect(html).toContain('<label data-field="">');
    // An unknown type falls through to a native input of that (empty) type.
    expect(html).toContain("<input");

    // A non-array options value is treated as no options.
    const select = renderToStaticMarkup(
      Field.render({ name: "s", type: "select", options: "nope" }, null),
    );

    expect(select).not.toContain("<option");

    // A non-string option inside the array is filtered out.
    const mixed = renderToStaticMarkup(
      Field.render({ name: "s", type: "select", options: ["ok", 7] }, null),
    );

    expect(mixed).toContain('<option value="ok">ok</option>');
    expect(mixed.match(/<option/g)).toHaveLength(1);
  });

  it("renders a labelled Field's error as the LAST child, data-error as the LAST attribute", () => {
    const html = renderToStaticMarkup(
      Field.render({ name: "x", type: "text", label: "X", error: "X is required" }, null),
    );

    expect(html).toBe(
      '<label data-field="x">X<input type="text" name="x"/>' +
        '<span role="alert" data-error="x">X is required</span></label>',
    );
  });

  it("renders no error span when `error` is absent or not a string", () => {
    expect(renderToStaticMarkup(Field.render({ name: "x", type: "text" }, null))).not.toContain(
      "data-error",
    );

    expect(
      renderToStaticMarkup(Field.render({ name: "x", type: "text", error: 7 }, null)),
    ).not.toContain("data-error");
  });

  it("ignores a non-string `value` as though no prior value existed", () => {
    const html = renderToStaticMarkup(Field.render({ name: "x", type: "text", value: 7 }, null));

    expect(html).toBe('<label data-field="x"><input type="text" name="x"/></label>');
  });

  it("renders the Form wrapper from raw props", () => {
    const html = renderToStaticMarkup(Form.render({ action: "/a", method: "post" }, null));

    expect(html).toBe('<form action="/a" method="post"></form>');
  });

  it("renders the Submit button from raw props", () => {
    expect(renderToStaticMarkup(Submit.render({ label: "Go" }, null))).toBe(
      '<button type="submit">Go</button>',
    );

    // A non-string label coerces to an empty caption.
    expect(renderToStaticMarkup(Submit.render({ label: 5 }, null))).toBe(
      '<button type="submit"></button>',
    );
  });
});

// ---------------------------------------------------------------------------
// validateSubmission
// ---------------------------------------------------------------------------

describe("validateSubmission", () => {
  it("accepts a fully valid submission covering every field type", () => {
    const result = validateSubmission(fullSpec(), {
      username: "ada",
      email: "ada@example.com",
      age: "42",
      agree: true,
      bio: "hello",
      plan: "pro",
    });

    expect(result).toEqual({ valid: true, errors: {} });
  });

  it("flags a missing required field", () => {
    const result = validateSubmission(fullSpec(), {
      email: "ada@example.com",
      agree: true,
      plan: "pro",
    });

    expect(result.valid).toBe(false);
    expect(result.errors.username).toBe("username is required");
  });

  it("flags a blank (whitespace-only) required field", () => {
    const result = validateSubmission(
      { action: "/x", fields: [{ name: "n", type: "text", required: true }] },
      { n: "   " },
    );

    expect(result.valid).toBe(false);
    expect(result.errors.n).toBe("n is required");
  });

  it("flags an invalid email", () => {
    const result = validateSubmission(fullSpec(), {
      username: "ada",
      email: "not-an-email",
      agree: true,
      plan: "pro",
    });

    expect(result.valid).toBe(false);
    expect(result.errors.email).toBe("email must be a valid email");
  });

  it("flags a non-string email value", () => {
    const result = validateSubmission(
      { action: "/x", fields: [{ name: "e", type: "email" }] },
      { e: 123 },
    );

    expect(result.errors.e).toBe("e must be a valid email");
  });

  it("flags a non-numeric number", () => {
    const result = validateSubmission(fullSpec(), {
      username: "ada",
      email: "ada@example.com",
      age: "abc",
      agree: true,
      plan: "pro",
    });

    expect(result.valid).toBe(false);
    expect(result.errors.age).toBe("age must be a number");
  });

  it("accepts a real numeric value and rejects NaN / blank-string numbers", () => {
    const spec: FormSpec = { action: "/x", fields: [{ name: "n", type: "number" }] };

    expect(validateSubmission(spec, { n: 7 }).valid).toBe(true);
    expect(validateSubmission(spec, { n: Number.NaN }).errors.n).toBe("n must be a number");

    // A blank-string number is absent-of-value, not an error.
    expect(validateSubmission(spec, { n: "   " }).valid).toBe(true);

    // A non-string, non-number value is not numeric.
    expect(validateSubmission(spec, { n: true }).errors.n).toBe("n must be a number");
  });

  it("flags a select value not in options", () => {
    const result = validateSubmission(fullSpec(), {
      username: "ada",
      email: "ada@example.com",
      agree: true,
      plan: "enterprise",
    });

    expect(result.valid).toBe(false);
    expect(result.errors.plan).toBe("plan must be one of the allowed options");
  });

  it("flags a non-string select value", () => {
    const result = validateSubmission(
      { action: "/x", fields: [{ name: "s", type: "select", options: ["a"] }] },
      { s: 1 },
    );

    expect(result.errors.s).toBe("s must be one of the allowed options");
  });

  it("treats a select with no options array as rejecting any present value", () => {
    const result = validateSubmission(
      { action: "/x", fields: [{ name: "s", type: "select" }] },
      { s: "x" },
    );

    expect(result.errors.s).toBe("s must be one of the allowed options");
  });

  it("accepts a checkbox with any present value (boolean coercion never errors)", () => {
    const spec: FormSpec = { action: "/x", fields: [{ name: "c", type: "checkbox" }] };

    expect(validateSubmission(spec, { c: true }).valid).toBe(true);
    expect(validateSubmission(spec, { c: false }).valid).toBe(true);
    expect(validateSubmission(spec, { c: "on" }).valid).toBe(true);
  });

  it("leaves an optional, omitted field alone", () => {
    const spec: FormSpec = {
      action: "/x",
      fields: [{ name: "note", type: "text" }],
    };

    expect(validateSubmission(spec, {})).toEqual({ valid: true, errors: {} });
  });

  it("skips type rules for a present-but-null value on a non-required field", () => {
    const spec: FormSpec = {
      action: "/x",
      fields: [{ name: "e", type: "email" }],
    };

    // null is blank-ish; with no `required`, nothing is flagged.
    expect(validateSubmission(spec, { e: null }).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FormError
// ---------------------------------------------------------------------------

describe("FormError", () => {
  it("carries a stable code and a frozen details bag", () => {
    const error = new FormError("FORM_INVALID", "bad submission", { field: "email" });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("FormError");
    expect(error.code).toBe("FORM_INVALID");
    expect(error.details).toEqual({ field: "email" });
    expect(Object.isFrozen(error.details)).toBe(true);
  });

  it("defaults its details to an empty frozen bag", () => {
    const error = new FormError("FORM_INVALID", "bad");

    expect(error.details).toEqual({});
    expect(Object.isFrozen(error.details)).toBe(true);
  });
});
