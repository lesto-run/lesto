import { KeelError } from "@keel/errors";

/** Stable codes for the Cloudflare adapter's refusals. */
export type CloudflareErrorCode =
  /** A wrangler config was asked for from a plan with no dynamic zone to run. */
  "CLOUDFLARE_NO_DYNAMIC_ZONE";

/** Anything the Cloudflare adapter can refuse to do. */
export class CloudflareError extends KeelError<CloudflareErrorCode> {}
