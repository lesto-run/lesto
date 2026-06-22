/**
 * React-free aggregator for the drop-in stylesheets this package ships.
 *
 * Imports nothing but sibling string constants, so a no-React consumer (a static
 * edge Worker, an inline `<style>`) can pull the look for callouts and
 * package-manager tabs without dragging the markdown renderer into its bundle.
 */
export { calloutStyles } from "./callout-styles";
export { packageCommandStyles } from "./package-commands-styles";
