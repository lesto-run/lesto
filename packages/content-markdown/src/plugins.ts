import { visit, SKIP } from "unist-util-visit";
import type { Root, Element } from "hast";
import type { Root as MdastRoot, Html } from "mdast";

/**
 * Rehype plugin to remove the first H1 heading from the document.
 * This prevents duplicate titles when frontmatter title is already rendered.
 */
export function rehypeStripFirstHeading() {
  return (tree: Root) => {
    let found = false;
    visit(tree, "element", (node: Element, index, parent) => {
      if (!found && node.tagName === "h1" && parent && typeof index === "number") {
        parent.children.splice(index, 1);
        found = true;
        return SKIP;
      }
      return undefined;
    });
  };
}

/**
 * Remark plugin to remove lumen disable comments from the markdown.
 * Matches: <!-- lumen-disable -->, <!-- lumen-enable -->, <!-- lumen-disable-next-line [rule] -->
 */
export function remarkStripLumenComments() {
  return (tree: MdastRoot) => {
    visit(tree, "html", (node: Html, index, parent) => {
      if (parent && typeof index === "number") {
        if (/^<!--\s*lumen-(?:disable|enable)/.test(node.value)) {
          parent.children.splice(index, 1);
          return index;
        }
      }
      return undefined;
    });
  };
}
