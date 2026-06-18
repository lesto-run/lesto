// Plugin
export { docks } from "./plugin";
export type { DocksPluginOptions, RawMarkdownOptions, BundleSizeLimit } from "./plugin";

// NOTE: Runtime utilities (getEntry, getCollection) are available from:
//   import { posts, getEntry } from "@lesto/content-content"
//
// Config utilities (defineCollection, defineConfig) are available from:
//   import { defineCollection, defineConfig } from "@lesto/content-core"
//
// The vite-plugin no longer re-exports these to avoid bundling @lesto/content-core
// into the client bundle.
