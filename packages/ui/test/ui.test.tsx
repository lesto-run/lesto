import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { ReactNode } from "react";

import {
  componentCatalog,
  Registry,
  treeJsonSchema,
  UiError,
  validateProps,
  validateTree,
} from "../src/index";
import { renderTree } from "../src/server";
import type { ComponentDef, PropSpec } from "../src/index";

// ---------------------------------------------------------------------------
// Trivial test components. The package ships ZERO components; these exist only
// to drive the engine under test.
// ---------------------------------------------------------------------------

const Box: ComponentDef = {
  name: "Box",
  description: "A container.",
  props: {},
  children: true,
  render: (_props, children) => createElement("div", { className: "box" }, children),
};

const Text: ComponentDef = {
  name: "Text",
  props: { value: { type: "string", required: true } },
  children: false,
  render: (props, _children) => createElement("span", null, props.value as ReactNode),
};

const Badge: ComponentDef = {
  name: "Badge",
  props: {
    tone: { type: "enum", values: ["info", "warn"] as const, required: true },
  },
  children: false,
  render: (props) => createElement("b", { "data-tone": props.tone as string }, "!"),
};

// A component that always throws when rendered — to exercise containment.
const Boom: ComponentDef = {
  name: "Boom",
  props: {},
  children: false,
  render: () => {
    throw new Error("kaboom");
  },
};

// Throws a NON-Error value (a bare string), so `render_threw`'s detail falls
// through to `String(error)` rather than reading `.message`.
const BoomString: ComponentDef = {
  name: "BoomString",
  props: {},
  children: false,
  render: () => {
    throw "just a string";
  },
};

function registry(): Registry {
  return new Registry().define(Box).define(Text).define(Badge);
}

/** The `type.const` of a schema variant, or undefined for the string leaf. */
function constOf(variant: Record<string, unknown>): string | undefined {
  const properties = variant.properties as { type?: { const?: string } } | undefined;

  return properties?.type?.const;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("Registry", () => {
  it("define is chainable and get/has/all reflect registration", () => {
    const r = new Registry().define(Box).define(Text);

    expect(r).toBeInstanceOf(Registry);
    expect(r.get("Box")).toBe(Box);
    expect(r.get("Missing")).toBeUndefined();
    expect(r.has("Text")).toBe(true);
    expect(r.has("Nope")).toBe(false);
    expect(r.all()).toEqual([Box, Text]);
  });
});

// ---------------------------------------------------------------------------
// validateProps
// ---------------------------------------------------------------------------

describe("validateProps", () => {
  it("passes a valid string and drops unknown props", () => {
    const specs: Record<string, PropSpec> = { value: { type: "string" } };

    const { props, errors } = validateProps(specs, { value: "hi", extra: 1 });

    expect(props).toEqual({ value: "hi" });
    expect(errors).toEqual([]);
  });

  it("coerces numeric strings to numbers but leaves non-numeric alone", () => {
    const specs: Record<string, PropSpec> = { n: { type: "number" }, m: { type: "number" } };

    const { props } = validateProps(specs, { n: "42", m: "abc" });

    expect(props.n).toBe(42);
    expect(props.m).toBe("abc");
  });

  it("leaves an existing number, blank string, and non-stringy value untouched", () => {
    const specs: Record<string, PropSpec> = {
      n: { type: "number" },
      b: { type: "number" },
      c: { type: "number" },
    };

    const { props } = validateProps(specs, { n: 7, b: "  ", c: true });

    expect(props.n).toBe(7);
    expect(props.b).toBe("  ");
    expect(props.c).toBe(true);
  });

  it("coerces boolean strings and passes through real booleans / other values", () => {
    const specs: Record<string, PropSpec> = {
      a: { type: "boolean" },
      b: { type: "boolean" },
      c: { type: "boolean" },
      d: { type: "boolean" },
    };

    const { props } = validateProps(specs, { a: "true", b: "false", c: true, d: "maybe" });

    expect(props).toEqual({ a: true, b: false, c: true, d: "maybe" });
  });

  it("passes object and array values through unchanged", () => {
    const specs: Record<string, PropSpec> = { o: { type: "object" }, a: { type: "array" } };

    const obj = { x: 1 };
    const arr = [1, 2];

    const { props } = validateProps(specs, { o: obj, a: arr });

    expect(props.o).toBe(obj);
    expect(props.a).toBe(arr);
  });

  it("accepts a valid enum and rejects one outside the allowed values", () => {
    const specs: Record<string, PropSpec> = {
      tone: { type: "enum", values: ["info", "warn"] },
    };

    expect(validateProps(specs, { tone: "info" }).errors).toEqual([]);

    const bad = validateProps(specs, { tone: "danger" });

    expect(bad.errors).toEqual(['prop "tone" must be one of [info, warn]']);
    expect(bad.props).toEqual({});

    // A non-string value is never a member of the enum.
    const nonString = validateProps(specs, { tone: 3 });

    expect(nonString.errors).toEqual(['prop "tone" must be one of [info, warn]']);
  });

  it("treats an enum spec without values as unconstrained", () => {
    const specs: Record<string, PropSpec> = { tone: { type: "enum" } };

    const { props, errors } = validateProps(specs, { tone: "anything" });

    expect(props).toEqual({ tone: "anything" });
    expect(errors).toEqual([]);
  });

  it("reports a missing required prop", () => {
    const specs: Record<string, PropSpec> = { value: { type: "string", required: true } };

    const { errors } = validateProps(specs, {});

    expect(errors).toEqual(['missing required prop "value"']);
  });

  it("applies a default when the prop is absent", () => {
    const specs: Record<string, PropSpec> = {
      size: { type: "string", default: "md", required: true },
    };

    const { props, errors } = validateProps(specs, {});

    expect(props).toEqual({ size: "md" });
    expect(errors).toEqual([]);
  });

  it("omits an absent, non-required, default-less prop entirely", () => {
    const specs: Record<string, PropSpec> = { note: { type: "string" } };

    const { props, errors } = validateProps(specs, {});

    expect(props).toEqual({});
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// treeJsonSchema
// ---------------------------------------------------------------------------

describe("treeJsonSchema", () => {
  it("emits a recursive oneOf covering the string leaf and every component", () => {
    const r = new Registry()
      .define(Box)
      .define(Text)
      .define(Badge)
      .define({
        name: "Meta",
        props: {
          count: { type: "number", description: "how many" },
          flag: { type: "boolean" },
          payload: { type: "object" },
          items: { type: "array" },
        },
        children: true,
        render: () => createElement("div"),
      });

    const schema = treeJsonSchema(r) as {
      $defs: { node: { oneOf: Array<Record<string, unknown>> } };
    };

    const variants = schema.$defs.node.oneOf;

    // The first variant is the bare string leaf.
    expect(variants[0]).toEqual({ type: "string" });

    // One variant per registered component plus the string leaf.
    expect(variants).toHaveLength(5);

    const text = variants.find((v) => constOf(v) === "Text") as {
      properties: { props: { required?: string[] } } & Record<string, unknown>;
    };

    expect(text.properties.props.required).toEqual(["value"]);

    const meta = variants.find((v) => constOf(v) === "Meta") as {
      properties: { props: { properties: Record<string, Record<string, unknown>> } };
    };

    expect(meta.properties.props.properties.count).toEqual({
      type: "number",
      description: "how many",
    });
    expect(meta.properties.props.properties.payload).toEqual({ type: "object" });
    expect(meta.properties.props.properties.items).toEqual({ type: "array" });
    expect(meta.properties.props.properties.flag).toEqual({ type: "boolean" });

    // A children-accepting component recurses back to the node definition.
    const box = variants.find((v) => constOf(v) === "Box") as {
      properties: { children?: { items: { $ref: string } } };
    };

    expect(box.properties.children?.items.$ref).toBe("#/$defs/node");

    // A leaf (children: false) omits `children` entirely — the schema is as
    // strict as the runtime policy, which forbids any child.
    expect(text.properties).not.toHaveProperty("children");
  });

  it("includes children for an allow-list and omits it for an empty list", () => {
    const r = new Registry()
      .define({
        name: "List",
        props: {},
        children: ["Text"],
        render: () => createElement("ul"),
      })
      .define({
        name: "Empty",
        props: {},
        // A degenerate empty allow-list permits no children — a leaf in disguise.
        children: [],
        render: () => createElement("hr"),
      });

    const schema = treeJsonSchema(r) as {
      $defs: { node: { oneOf: Array<Record<string, unknown>> } };
    };

    const variants = schema.$defs.node.oneOf;

    const list = variants.find((v) => constOf(v) === "List") as {
      properties: { children?: { items: { $ref: string } } };
    };

    expect(list.properties.children?.items.$ref).toBe("#/$defs/node");

    const empty = variants.find((v) => constOf(v) === "Empty") as {
      properties: Record<string, unknown>;
    };

    expect(empty.properties).not.toHaveProperty("children");
  });

  it("encodes enum props as a string with an enum list", () => {
    const schema = treeJsonSchema(registry()) as {
      $defs: { node: { oneOf: Array<Record<string, unknown>> } };
    };

    const badge = schema.$defs.node.oneOf.find((v) => constOf(v) === "Badge") as {
      properties: { props: { properties: { tone: Record<string, unknown> } } };
    };

    expect(badge.properties.props.properties.tone).toEqual({
      type: "string",
      enum: ["info", "warn"],
    });
  });

  it("requires the `props` object for a component with a required prop, so the schema agrees with validateTree", () => {
    const r = registry();

    const schema = treeJsonSchema(r) as {
      $defs: { node: { oneOf: Array<Record<string, unknown>> } };
    };

    const variants = schema.$defs.node.oneOf;

    // Text has a required prop -> the variant must require `props` itself; if it
    // only required `type`, a model could omit `props` and pass the schema while
    // failing validateTree's missing-required-prop check (a looser schema).
    const text = variants.find((v) => constOf(v) === "Text") as { required: string[] };

    expect(text.required).toEqual(["type", "props"]);

    // A `{ type: "Text" }` node (no props) is now rejected by the schema's
    // required list AND by validateTree — the two constraints agree.
    expect(text.required).toContain("props");

    const { valid } = validateTree(r, { type: "Text" });

    expect(valid).toBe(false);
  });

  it("requires only `type` for a component with no required props", () => {
    const schema = treeJsonSchema(registry()) as {
      $defs: { node: { oneOf: Array<Record<string, unknown>> } };
    };

    // Box has no required props, so the model is free to omit `props` — the
    // variant requires only `type`, matching validateTree, which accepts it.
    const box = schema.$defs.node.oneOf.find((v) => constOf(v) === "Box") as {
      required: string[];
    };

    expect(box.required).toEqual(["type"]);
    expect(validateTree(registry(), { type: "Box" }).valid).toBe(true);
  });

  it("throws UI_INVALID_ENUM_SPEC when an enum spec lacks values", () => {
    const r = new Registry().define({
      name: "Bad",
      props: { tone: { type: "enum" } },
      children: false,
      render: () => createElement("span"),
    });

    try {
      treeJsonSchema(r);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UiError);
      expect((error as UiError).code).toBe("UI_INVALID_ENUM_SPEC");
      expect(Object.isFrozen((error as UiError).details)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// componentCatalog
// ---------------------------------------------------------------------------

describe("componentCatalog", () => {
  it("summarizes each component with only the fields that carry information", () => {
    const r = new Registry()
      .define(Box)
      .define(Text)
      .define(Badge)
      .define({
        name: "Sized",
        props: { size: { type: "string", default: "md", description: "t-shirt size" } },
        children: ["Text"],
        render: () => createElement("div"),
      });

    const catalog = componentCatalog(r) as Array<Record<string, unknown>>;

    expect(catalog[0]).toEqual({
      name: "Box",
      children: true,
      props: {},
      description: "A container.",
    });

    expect(catalog[1]).toEqual({
      name: "Text",
      children: false,
      props: { value: { type: "string", required: true } },
    });

    expect(catalog[2]).toEqual({
      name: "Badge",
      children: false,
      props: { tone: { type: "enum", required: true, values: ["info", "warn"] } },
    });

    expect(catalog[3]).toEqual({
      name: "Sized",
      children: ["Text"],
      props: { size: { type: "string", default: "md", description: "t-shirt size" } },
    });
  });
});

// ---------------------------------------------------------------------------
// validateTree
// ---------------------------------------------------------------------------

describe("validateTree", () => {
  it("accepts a well-formed tree", () => {
    const tree = {
      type: "Box",
      children: ["hello", { type: "Text", props: { value: "hi" } }],
    };

    expect(validateTree(registry(), tree)).toEqual({ valid: true, errors: [] });
  });

  it("flags an unknown component", () => {
    const { valid, errors } = validateTree(registry(), { type: "Mystery" });

    expect(valid).toBe(false);
    expect(errors).toEqual([{ path: "$", type: "unknown_component", detail: "Mystery" }]);
  });

  it("flags a malformed (non-string, non-object) node", () => {
    const { errors } = validateTree(registry(), { type: "Box", children: [42] });

    expect(errors).toEqual([
      {
        path: "$.children[0]",
        type: "invalid_node",
        detail: "node must be a string or an object",
      },
    ]);
  });

  it("flags a missing required prop", () => {
    const { valid, errors } = validateTree(registry(), { type: "Text" });

    expect(valid).toBe(false);
    expect(errors).toEqual([
      { path: "$", type: "invalid_props", detail: 'missing required prop "value"' },
    ]);
  });

  it("flags a disallowed child under children:false", () => {
    const tree = {
      type: "Text",
      props: { value: "hi" },
      children: [{ type: "Box" }],
    };

    const { errors } = validateTree(registry(), tree);

    expect(errors).toContainEqual({
      path: "$.children[0]",
      type: "disallowed_child",
      detail: "Box",
    });
  });

  it("flags a disallowed child under a children allow-list", () => {
    const r = registry().define({
      name: "List",
      props: {},
      children: ["Text"],
      render: () => createElement("ul"),
    });

    const ok = validateTree(r, {
      type: "List",
      children: [{ type: "Text", props: { value: "x" } }],
    });

    expect(ok.valid).toBe(true);

    const bad = validateTree(r, { type: "List", children: [{ type: "Box" }] });

    expect(bad.errors).toContainEqual({
      path: "$.children[0]",
      type: "disallowed_child",
      detail: "Box",
    });
  });
});

// ---------------------------------------------------------------------------
// renderTree
// ---------------------------------------------------------------------------

describe("renderTree", () => {
  it("renders a valid tree to HTML", () => {
    const tree = {
      type: "Box",
      children: [
        "hi ",
        { type: "Text", props: { value: "Ada" } },
        { type: "Badge", props: { tone: "info" } },
      ],
    };

    const { element, errors } = renderTree(registry(), tree);

    expect(errors).toEqual([]);
    expect(element).not.toBeNull();

    const html = renderToStaticMarkup(element);

    expect(html).toContain('<div class="box">');
    expect(html).toContain("hi ");
    expect(html).toContain("<span>Ada</span>");
    expect(html).toContain('<b data-tone="info">!</b>');
  });

  it("renders a bare string root", () => {
    const { element, errors } = renderTree(registry(), "just text");

    expect(errors).toEqual([]);
    expect(renderToStaticMarkup(element)).toBe("just text");
  });

  it("degrades an unknown component safely without throwing", () => {
    const { element, errors } = renderTree(registry(), {
      type: "Box",
      children: [{ type: "Ghost" }],
    });

    // The diagnostic names the offending component as `detail` (ui#7).
    expect(errors).toEqual([{ path: "$.children[0]", type: "unknown_component", detail: "Ghost" }]);

    const html = renderToStaticMarkup(element);

    expect(html).toBe('<div class="box"></div>');
  });

  it("degrades a malformed node safely", () => {
    const { element, errors } = renderTree(registry(), { type: "Box", children: [true] });

    expect(errors).toEqual([
      { path: "$.children[0]", type: "invalid_node", detail: "node must be a string or an object" },
    ]);
    expect(renderToStaticMarkup(element)).toBe('<div class="box"></div>');
  });

  it("degrades a malformed root to null", () => {
    const { element, errors } = renderTree(registry(), 99);

    expect(element).toBeNull();
    expect(errors).toEqual([
      { path: "$", type: "invalid_node", detail: "node must be a string or an object" },
    ]);
  });

  it("contains a component whose render throws, carrying the error as cause + detail", () => {
    const r = registry().define(Boom);

    const { element, errors } = renderTree(r, {
      type: "Box",
      children: [{ type: "Boom" }, { type: "Text", props: { value: "still here" } }],
    });

    // ui#7: the thrown Error rides along as `cause` (the real stack) and its
    // message as `detail`, instead of a bare `render_threw`.
    const thrown = errors.find((error) => error.path === "$.children[0]");
    expect(thrown).toBeDefined();
    expect(thrown?.type).toBe("render_threw");
    expect(thrown?.detail).toBe("kaboom");
    expect(thrown?.cause).toBeInstanceOf(Error);
    expect((thrown?.cause as Error | undefined)?.message).toBe("kaboom");

    // The throw is contained — the rest of the tree still renders.
    const html = renderToStaticMarkup(element);

    expect(html).toContain('<div class="box">');
    expect(html).toContain("<span>still here</span>");
  });

  it("surfaces a missing required prop as invalid_props in the render walk (ui#7)", () => {
    // `Text.value` is required. The render walk previously DROPPED the prop error
    // on the floor (only the parallel validateTree reported it); now it surfaces
    // here too, and the render still proceeds (the component renders empty).
    const { element, errors } = renderTree(registry(), {
      type: "Box",
      children: [{ type: "Text" }],
    });

    expect(errors).toContainEqual({
      path: "$.children[0]",
      type: "invalid_props",
      detail: 'missing required prop "value"',
    });

    // The render is not aborted — the bad component renders with the empty bag.
    expect(renderToStaticMarkup(element)).toContain('<div class="box">');
  });

  it("stringifies a non-Error throw into render_threw detail (ui#7)", () => {
    const r = registry().define(BoomString);

    const { errors } = renderTree(r, { type: "BoomString" });

    const thrown = errors.find((error) => error.type === "render_threw");
    // A thrown string has no `.message`, so detail is its String() form, and the
    // raw value still rides as cause.
    expect(thrown?.detail).toBe("just a string");
    expect(thrown?.cause).toBe("just a string");
  });

  it("surfaces an out-of-enum prop as invalid_props (ui#7)", () => {
    const { errors } = renderTree(registry(), {
      type: "Badge",
      props: { tone: "loud" },
    });

    expect(errors).toContainEqual({
      path: "$",
      type: "invalid_props",
      detail: 'prop "tone" must be one of [info, warn]',
    });
  });
});
