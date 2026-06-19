/**
 * @lesto/client — a typed, browser-safe fetch client for a Lesto app's routes.
 *
 *   import { createApi } from "@lesto/client";
 *
 *   interface Api {
 *     "GET /mls/saved": { response: { saved: Listing[] } };
 *   }
 *
 *   const api = createApi<Api>();
 *   const { saved } = await api.get("/mls/saved");   // typed, native fetch
 *
 * Types cross the network by inference over the contract you declare — no
 * codegen, no GraphQL, no generated client bundle.
 */

export { createApi } from "./client";
export type { Api, ApiContract, ApiMethod, ApiOptions, RouteSpec, TraceContext } from "./client";

export { createMutationClient, MUTATION_ROUTE_PREFIX } from "./mutations";
export type {
  MutationClient,
  MutationClientOptions,
  MutationContract,
  MutationResult,
  MutationSpec,
} from "./mutations";

export { ClientError, LestoError } from "./errors";
export type { ClientErrorCode } from "./errors";
