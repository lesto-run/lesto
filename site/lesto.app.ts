/**
 * The project entrypoint — the `LestoAppConfig` `@lesto/cli` loads (`lesto dev`)
 * and `lesto build` boots, the same shape every Lesto app default-exports.
 */

import { buildAppConfig } from "./src/app";

export default await buildAppConfig();
