import { KeelError } from "@keel/errors";

/** Stable codes for every failure declaring a site set can raise. */
export type SitesErrorCode =
  /** A site was declared without a name. */
  | "SITES_EMPTY_NAME"
  /** Two sites share a name. */
  | "SITES_DUPLICATE_NAME"
  /** A site's `basePath` does not start with `/`. */
  | "SITES_INVALID_BASE_PATH"
  /** Two sites are mounted at the same `basePath` — routing would be ambiguous. */
  | "SITES_DUPLICATE_BASE_PATH"
  /** A page would be written outside its output root (path traversal). */
  | "SITES_PATH_ESCAPE"
  /** A static build hit a page the app could not render (a non-2xx status). */
  | "SITES_PAGE_FAILED";

/** The error type for the sites layer, codes drawn from the union above. */
export class SitesError extends KeelError<SitesErrorCode> {}
