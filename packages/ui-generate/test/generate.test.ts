import { Registry } from "@lesto/ui";
import { describe, expect, it } from "vitest";

import { GenerateError } from "../src/errors";
import { generateUi } from "../src/generate";
import type { Complete } from "../src/generate";

// A small but meaningful registry: a container that nests anything, a heading
// with a required text prop, and a button with an enum variant. This makes both
// the generated schema and the validation pass non-trivial.
function buildRegistry(): Registry {
  return new Registry()
    .define({
      name: "Box",
      props: {},
      children: true,
      render: (_p, kids) => ({ type: "div", props: { children: kids }, key: null }),
    })
    .define({
      name: "Heading",
      props: { text: { type: "string", required: true } },
      children: false,
      render: (p) => ({ type: "h1", props: { children: p["text"] }, key: null }),
    })
    .define({
      name: "Button",
      props: {
        label: { type: "string", required: true },
        variant: { type: "enum", values: ["primary", "secondary"] },
      },
      children: false,
      render: (p) => ({ type: "button", props: { children: p["label"] }, key: null }),
    });
}

/** A `Complete` that always resolves to a fixed tree, recording its request. */
function fixedComplete(tree: unknown): { complete: Complete; calls: unknown[] } {
  const calls: unknown[] = [];

  const complete: Complete = async (request) => {
    calls.push(request);

    return tree;
  };

  return { complete, calls };
}

describe("generateUi", () => {
  it("returns a valid result for a tree the registry admits", async () => {
    const registry = buildRegistry();

    const tree = {
      type: "Box",
      children: [
        { type: "Heading", props: { text: "Welcome" } },
        { type: "Button", props: { label: "Go", variant: "primary" } },
      ],
    };

    const { complete, calls } = fixedComplete(tree);

    const result = await generateUi({ registry, prompt: "a welcome screen", complete });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.tree).toBe(tree);

    // The model was handed the forced render_ui tool with the registry schema.
    expect(calls).toHaveLength(1);

    const request = calls[0] as {
      system: string;
      prompt: string;
      tool: { name: string; description: string; inputSchema: object };
    };

    expect(request.tool.name).toBe("render_ui");
    expect(request.tool.description).toContain("registered components");
    expect(request.prompt).toBe("a welcome screen");
    expect(request.system).toContain("ONLY the registered components");

    // The tool schema is the registry's tree schema — it $refs a node def.
    expect(request.tool.inputSchema).toMatchObject({ $ref: "#/$defs/node" });
  });

  it("reports errors for a tree with an unknown component type", async () => {
    const registry = buildRegistry();

    const tree = {
      type: "Box",
      children: [{ type: "Carousel", props: {} }],
    };

    const { complete } = fixedComplete(tree);

    const result = await generateUi({ registry, prompt: "anything", complete });

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);

    // The unknown component surfaces as a located validation error.
    expect(result.errors).toContainEqual(
      expect.objectContaining({ type: "unknown_component", detail: "Carousel" }),
    );
  });

  it("throws GENERATE_NO_OUTPUT when the model resolves to null", async () => {
    const registry = buildRegistry();

    const { complete } = fixedComplete(null);

    await expect(generateUi({ registry, prompt: "anything", complete })).rejects.toMatchObject({
      code: "GENERATE_NO_OUTPUT",
    });
  });

  it("throws GENERATE_NO_OUTPUT when the model resolves to undefined", async () => {
    const registry = buildRegistry();

    const { complete } = fixedComplete(undefined);

    let thrown: unknown;

    try {
      await generateUi({ registry, prompt: "anything", complete });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(GenerateError);
    expect((thrown as GenerateError).code).toBe("GENERATE_NO_OUTPUT");
    expect((thrown as GenerateError).details).toMatchObject({ tool: "render_ui" });
  });
});
