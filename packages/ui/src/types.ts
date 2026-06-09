/**
 * The vocabulary an AI uses to describe UI, and the shapes the engine renders.
 *
 * A component is declared once in a `ComponentDef`: what props it accepts, what
 * children it may hold, and how to turn validated props into a React element.
 * The AI never sees React — it emits a plain JSON `UiNode` tree, which the
 * engine validates against the registry and renders.
 */

import type { ReactElement, ReactNode } from "react";

/** The primitive kinds a prop may take. `enum` is a string constrained to `values`. */
export type PropType = "string" | "number" | "boolean" | "enum" | "object" | "array";

/** The contract for a single prop: its type plus optional constraints and defaults. */
export interface PropSpec {
  type: PropType;
  required?: boolean;
  values?: readonly string[];
  default?: unknown;
  description?: string;
}

/**
 * What children a component accepts.
 *   false       — a leaf; no children allowed
 *   true        — any registered component
 *   [names]     — only these component types
 */
export type ChildrenPolicy = boolean | string[];

/** A vetted component: its prop schema, child policy, and render function. */
export interface ComponentDef {
  name: string;
  description?: string;
  props: Record<string, PropSpec>;
  children: ChildrenPolicy;
  render: (props: Record<string, unknown>, children: ReactNode) => ReactElement;
}

/** A node in the AI-emitted UI tree — plain JSON, no React. */
export interface UiNode {
  type: string;
  props?: Record<string, unknown>;
  children?: unknown[];
}
