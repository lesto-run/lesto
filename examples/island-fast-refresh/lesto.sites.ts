import type { Site } from "@lesto/sites";

// One dynamic zone over the whole origin — the dev server dispatches every path to the
// app's own handle (the file-routed home page + the Counter island).
const sites: readonly Site[] = [{ name: "app", render: "dynamic", basePath: "/" }];

export default sites;
