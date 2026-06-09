import { KeelError } from "@keel/errors";

/** Stable codes for every failure declaring a site set can raise. */
export type SitesErrorCode =
  /** A site was declared without a name. */
  | "SITES_EMPTY_NAME"
  /** Two sites share a name. */
  | "SITES_DUPLICATE_NAME"
  /** A site's `basePath` does not start with `/`. */
  | "SITES_INVALID_BASE_PATH"
  /** A page would be written outside its output root (path traversal). */
  | "SITES_PATH_ESCAPE";

/** The error type for the sites layer, codes drawn from the union above. */
export class SitesError extends KeelError<SitesErrorCode> {}
