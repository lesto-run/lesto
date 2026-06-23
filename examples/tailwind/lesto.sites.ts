import type { Site } from "@lesto/sites";

/**
 * One static site at `/`: `lesto build` prerenders the home page to `out/`, where the
 * compiled `out/styles.css` sits beside it — the served HTML links the stylesheet.
 */
const sites: Site[] = [{ name: "site", render: "static", basePath: "/", pages: ["/"] }];

export default sites;
