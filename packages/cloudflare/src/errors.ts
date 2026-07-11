import { LestoError } from "@lesto/errors";

/** Stable codes for the Cloudflare adapter's refusals. */
export type CloudflareErrorCode =
  /** A wrangler config was asked for from a plan with no dynamic zone to run. */
  | "CLOUDFLARE_NO_DYNAMIC_ZONE"
  /** A dispatch ran past the configured `timeoutMs`; the request is freed with a 503. */
  | "CLOUDFLARE_DISPATCH_TIMEOUT"
  /**
   * A caller asked the D1 adapter for an interactive `transaction()`. D1 has no
   * such primitive (only `batch()`), so the adapter REFUSES rather than degrade to
   * a no-op passthrough that silently loses updates — a store that needs
   * cross-statement atomicity (the rate limiter, the queue's batch writes) must
   * fail CLOSED, never open. See `d1.ts`.
   */
  | "CLOUDFLARE_D1_TRANSACTION_UNSUPPORTED";

/** Anything the Cloudflare adapter can refuse to do. */
export class CloudflareError extends LestoError<CloudflareErrorCode> {}
