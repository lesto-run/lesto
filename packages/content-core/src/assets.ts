import * as path from "node:path";
import type { AnyCollection, EngineConfig } from "./types";

/**
 * Resolved assets configuration with all defaults applied
 */
export interface ResolvedAssetsConfig {
  /** Absolute path to assets directory */
  directory: string;
  /** Allowed file extensions for uploads */
  allowedExtensions: string[];
  /** Maximum file size in bytes */
  maxFileSize: number;
}

/** Default allowed file extensions for media uploads */
const DEFAULT_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "svg",
  "mp4",
  "webm",
];

/** Default maximum file size: 50MB */
const DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024;

/**
 * Resolve assets configuration for a collection.
 * Priority: collection override > global config > defaults
 */
export function resolveAssetsConfig(
  config: Pick<EngineConfig, "assets">,
  collection: AnyCollection,
  cwd: string
): ResolvedAssetsConfig {
  const globalAssets = config.assets ?? {};
  const collectionAssets = collection.assets;

  // Determine directory: collection override > global > default
  let directory: string;
  if (typeof collectionAssets === "string") {
    directory = collectionAssets;
  } else if (typeof collectionAssets === "object" && collectionAssets?.directory) {
    directory = collectionAssets.directory;
  } else if (globalAssets.directory) {
    directory = globalAssets.directory;
  } else {
    // Default: collection-relative _assets
    directory = path.join(collection.directory, "_assets");
  }

  // Get collection-level overrides
  const collectionConfig =
    typeof collectionAssets === "object" ? collectionAssets : {};

  return {
    directory: path.resolve(cwd, directory),
    allowedExtensions:
      collectionConfig.allowedExtensions ??
      globalAssets.allowedExtensions ??
      DEFAULT_EXTENSIONS,
    maxFileSize:
      collectionConfig.maxFileSize ??
      globalAssets.maxFileSize ??
      DEFAULT_MAX_FILE_SIZE,
  };
}

/**
 * Resolve an asset path to a full URL for use in the browser.
 * Handles both relative paths and absolute URLs.
 * Assets are served from public/assets/{collection}/ as static files.
 */
export function resolveAssetPath(
  assetPath: string,
  collection: string
): string {
  // Already absolute URL
  if (assetPath.startsWith("http://") || assetPath.startsWith("https://")) {
    return assetPath;
  }

  // Remove _assets/ prefix and build static asset path
  const cleanPath = assetPath.replace(/^_assets\//, "");
  return `/assets/${collection}/${cleanPath}`;
}

/**
 * Get the relative path for storing in markdown (e.g., "_assets/image.jpg")
 */
export function getAssetRelativePath(filename: string): string {
  return `_assets/${filename}`;
}

/**
 * Allowed MIME types for uploads
 */
export const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "video/mp4",
  "video/webm",
] as const;

/**
 * Map of file extensions to MIME types
 */
export const EXTENSION_TO_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/**
 * Check if a file type is an image
 */
export function isImageType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

/**
 * Check if a file type is a video
 */
export function isVideoType(mimeType: string): boolean {
  return mimeType.startsWith("video/");
}
