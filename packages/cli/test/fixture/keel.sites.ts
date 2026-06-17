/**
 * The fixture project's sites — what `keel` loads alongside `keel.app.ts`.
 *
 * One static site mounted at the root, prerendering the app's `/posts` route.
 * The spawned-process CLI e2e (`bin.e2e.test.ts`) loads this to exercise the real
 * `deploy --release` → `rollback` loop end to end: a static site is the only kind
 * `deploy --release` actually ships into a versioned `releases/<version>/` tree, so
 * a static site here is what gives `rollback` a published release to flip back to.
 *
 * `/posts` answers JSON, which the prerenderer captures verbatim — a static build
 * does not require an HTML body, only a route that renders.
 */

import { defineSites } from "@keel/sites";

export default defineSites([{ name: "app", render: "static", basePath: "/", pages: ["/posts"] }]);
