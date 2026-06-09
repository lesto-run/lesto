/**
 * @keel/ui — the AI-native UI rendering engine core.
 *
 *   const registry = new Registry()
 *     .define({ name: "Box", props: {}, children: true, render: (_p, kids) => <div>{kids}</div> });
 *
 *   const schema  = treeJsonSchema(registry);   // constrain the model's output
 *   const catalog = componentCatalog(registry); // describe it in the prompt
 *
 *   const tree = { type: "Box", children: ["hello"] };   // the AI emits plain JSON
 *
 *   const { valid, errors } = validateTree(registry, tree);   // pure, React-free
 *   const { element }       = renderTree(registry, tree);     // tree -> React, safe
 */

export { Registry } from "./registry";

export { validateProps } from "./props";

export { componentCatalog, treeJsonSchema } from "./schema";

export { validateTree } from "./validate";
export type { TreeError } from "./validate";

export { renderPage, renderTree } from "./render";
export type { Page, RenderError } from "./render";

export { island, ISLAND_ATTR } from "./island";
export type { ClientComponentDef, IslandMount } from "./island";

// The hydration runtime is browser-only (it touches `document`), so it lives
// behind the `@keel/ui/client` subpath — server-side importers of `@keel/ui`
// never pull DOM code into a build without the DOM lib. Mirrors react-dom's
// server/client split.

export { KeelError, UiError } from "./errors";
export type { UiErrorCode } from "./errors";

export type { ChildrenPolicy, ComponentDef, PropSpec, PropType, UiNode } from "./types";
