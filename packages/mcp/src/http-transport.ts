/**
 * The loopback dev MCP transport's security core (ADR 0032 Phase 1).
 *
 * `lesto dev` stands a DEV-ONLY MCP server up on loopback so an agent can read the
 * live dev state (diagnostics, recent requests, logs). A `127.0.0.1` bind is NOT
 * the control: a malicious page in the developer's own browser — or a DNS-rebinding
 * attack — can POST JSON-RPC to `localhost:<port>`. So every request passes this
 * tested gate before any `dispatch`: a foreign `Origin` or `Host` is refused (the
 * DNS-rebinding guard), and even a same-origin request must present the per-session
 * token the dev command minted (the control a loopback bind lacks — a browser tab
 * can forge a same-origin request but cannot know the minted token).
 *
 * The irreducible socket bind + the SDK-transport driving live in the
 * coverage-excluded `server.ts` (`startMcpHttpServer`); THIS module is the
 * security logic, held to the full 100% bar — putting these branches in the
 * excluded transport would let them escape the gate. The `Origin` allowlist helper
 * (`isOriginAllowed`, `loopbackAllowlist`) is shared with the live-reload WS
 * retrofit (Inc 4c), so there is one validation, not two.
 */

import type { McpErrorCode } from "./errors";
import { isOriginAllowed } from "./http";

/** The loopback origins + hosts a dev server at `port` accepts — `127.0.0.1` and `localhost`. */
export function loopbackAllowlist(port: number): {
  allowedOrigins: string[];
  allowedHosts: string[];
} {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];

  return {
    allowedHosts: hosts,
    allowedOrigins: hosts.flatMap((host) => [`http://${host}`, `https://${host}`]),
  };
}

/**
 * Is this request's `Host` allowed — the other half of the DNS-rebinding guard?
 *
 * Unlike `Origin` (absent for a non-browser client, and allowed then — see
 * {@link isOriginAllowed}), every HTTP request carries a `Host`; an absent or
 * foreign one is refused. The attacker's vector is a forged `Host` pointing a
 * rebinding name at the loopback server.
 */
export function isHostAllowed(host: string | undefined, allowedHosts: readonly string[]): boolean {
  return host !== undefined && allowedHosts.includes(host);
}

/** The per-session token + the loopback allowlists the dev transport gates on. */
export interface DevMcpSecurity {
  /** The per-session token the dev command minted; the client must present it verbatim. */
  token: string;

  /** The loopback origins allowed (the DNS-rebinding `Origin` allowlist). */
  allowedOrigins: readonly string[];

  /** The loopback hosts allowed (the DNS-rebinding `Host` allowlist). */
  allowedHosts: readonly string[];
}

/** The dev transport's verdict on an inbound request, before any dispatch. */
export type DevMcpGateDecision =
  | { kind: "accept" }
  | { kind: "reject"; status: number; code: McpErrorCode; reason: string };

/** Build the coded loopback refusal (HTTP 403 + `MCP_DEV_ORIGIN_REJECTED`). */
function rejectDev(reason: string): DevMcpGateDecision {
  return { kind: "reject", status: 403, code: "MCP_DEV_ORIGIN_REJECTED", reason };
}

/**
 * Gate one inbound dev MCP request: `Origin` guard → `Host` guard → per-session token.
 *
 * Returns `accept` only when all three pass; otherwise a `reject` carrying the HTTP
 * status and the coded `MCP_DEV_ORIGIN_REJECTED` the socket layer renders — refused
 * BEFORE any `dispatch`. The order is cheapest-first; the token is the strong control
 * a `127.0.0.1` bind lacks.
 */
export function gateDevRequest(options: {
  origin: string | undefined;
  host: string | undefined;
  token: string | undefined;
  security: DevMcpSecurity;
}): DevMcpGateDecision {
  if (!isOriginAllowed(options.origin, options.security.allowedOrigins)) {
    return rejectDev("a foreign Origin");
  }

  if (!isHostAllowed(options.host, options.security.allowedHosts)) {
    return rejectDev("a foreign Host");
  }

  if (options.token !== options.security.token) {
    return rejectDev("a missing or wrong session token");
  }

  return { kind: "accept" };
}
