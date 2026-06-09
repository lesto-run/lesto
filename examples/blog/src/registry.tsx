/**
 * The app's component registry — the vetted vocabulary this blog can render.
 *
 * `@keel/ui` ships no components on purpose: the registry is the trust boundary,
 * and an app declares exactly the components an AI (or a controller) is allowed
 * to compose into a tree. Here we define two:
 *
 *   - `Page`  — a layout shell with a heading and arbitrary children.
 *   - `PostCard` — a leaf that renders one post's title and body.
 *
 * A controller builds a plain JSON `UiNode` tree from ORM rows; the engine
 * validates props against these specs and SSRs the result to HTML.
 */

import { Registry } from "@keel/ui";

export const registry = new Registry()
  .define({
    name: "Page",
    description: "The page shell: a titled section wrapping its children.",
    props: {
      title: { type: "string", required: true },
    },
    children: ["PostCard"],
    render: (props, children) => (
      <main>
        <h1>{String(props["title"])}</h1>

        <section>{children}</section>
      </main>
    ),
  })
  .define({
    name: "PostCard",
    description: "One post: its title and body.",
    props: {
      title: { type: "string", required: true },
      body: { type: "string", required: true },
    },
    children: false,
    render: (props) => (
      <article>
        <h2>{String(props["title"])}</h2>

        <p>{String(props["body"])}</p>
      </article>
    ),
  });
