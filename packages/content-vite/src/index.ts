// Plugin
export { docks } from "./plugin";
export type { DocksPluginOptions, RawMarkdownOptions, BundleSizeLimit } from "./plugin";

// NOTE: Runtime utilities (getEntry, getCollection) are available from:
//   import { posts, getEntry } from "@keel/content-content"
//
// Config utilities (defineCollection, defineConfig) are available from:
//   import { defineCollection, defineConfig } from "@keel/content-core"
//
// The vite-plugin no longer re-exports these to avoid bundling @keel/content-core
// into the client bundle.
