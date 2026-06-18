/**
 * @volo/ui-kit — the vetted starter component library for @volo/ui.
 *
 * The engine ships zero components by design; this is the default design system
 * the app and the AI compose with.
 *
 *   const registry = createKit();            // a fresh Registry, fully stocked
 *   const { element } = renderTree(registry, tree);
 *
 * Individual `ComponentDef`s and the shared design `tokens` are exported too,
 * so an app can cherry-pick, extend, or restyle from the same source of truth.
 */

export { createKit } from "./kit";

export {
  Badge,
  Button,
  Card,
  Divider,
  Grid,
  Heading,
  Page,
  Section,
  Stack,
  Text,
} from "./components";

export { tokens } from "./tokens";
export type { Tokens } from "./tokens";
