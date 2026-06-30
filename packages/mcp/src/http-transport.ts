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

import { timingSafeEqual } from "node:crypto";

import { McpError } from "./errors";
import type { McpErrorCode } from "./errors";
import { isOriginAllowed } from "./http";

/**
 * The shortest per-session dev token the loopback transport will stand up with.
 *
 * The token — not the `127.0.0.1` bind — is the real access control: a same-origin
 * browser tab passes the Origin/Host guard but cannot know a minted token, so a blank
 * or guessable token is the one hole left open. 32 characters is the floor a real minted
 * token (e.g. 32 random bytes, hex-encoded) clears many times over.
 */
export const MIN_DEV_TOKEN_LENGTH = 32;

/**
 * Reject an empty or too-short per-session dev token at construction.
 *
 * The dev command mints the token; this is the loud, up-front guard that a
 * misconfiguration (an empty string, a truncated value) can never quietly weaken the
 * gate at request time — mirroring {@link createBearerAuthenticator}'s empty-`resource`
 * guard, which refuses a vacuous audience check rather than honoring it. Lives in the
 * covered core (not the excluded socket bind) so the guard itself is tested.
 */
export function assertDevToken(token: string): void {
  if (token.length < MIN_DEV_TOKEN_LENGTH) {
    throw new McpError(
      "MCP_DEV_TOKEN_REQUIRED",
      `The loopback dev MCP server needs a per-session token of at least ${MIN_DEV_TOKEN_LENGTH} characters; the loopback bind is not the control.`,
      { minLength: MIN_DEV_TOKEN_LENGTH },
    );
  }
}

/**
 * Does the presented token match the session token, in constant time?
 *
 * A naive `!==` leaks the token's length-of-common-prefix through timing. The risk is
 * low on loopback, but {@link timingSafeEqual} is a cheap drop-in. It throws on a length
 * mismatch, so guard length first — a length difference is already a non-match, and the
 * token's length is not the secret. An absent token never matches.
 */
function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (provided === undefined) return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);

  return a.length === b.length && timingSafeEqual(a, b);
}

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

/**
 * The first value of a possibly-repeated request header (node delivers a header as
 * `string | string[]`). Pure request-shaping, here in the covered core rather than
 * the excluded socket layer.
 */
export function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Adapt node-style request headers into a Web `Headers` for the SDK transport. */
export function nodeHeadersToWeb(headers: Record<string, string | string[] | undefined>): Headers {
  const web = new Headers();

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;

    for (const single of Array.isArray(value) ? value : [value]) web.append(key, single);
  }

  return web;
}

/**
 * Parse a dev-request body: an empty body or malformed JSON yields `undefined`, which
 * the SDK transport turns into a clean JSON-RPC error rather than a crash.
 */
export function parseDevBody(raw: string): unknown {
  if (raw === "") return undefined;

  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
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

  if (!tokenMatches(options.token, options.security.token)) {
    return rejectDev("a missing or wrong session token");
  }

  return { kind: "accept" };
}

/** The loopback hostnames the dev servers bind — `127.0.0.1` / `localhost` (the dev servers bind v4 loopback, not `::1`). */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);

/**
 * Is this `Origin` a loopback page on ANY port (`http://127.0.0.1:5173`,
 * `http://localhost:8080`)?
 *
 * Unlike the dev MCP transport's same-port allowlist, the live-reload WS's legitimate
 * client is the dev app PAGE — served from the dev SERVER's (dynamic) port, not the reload
 * port — so its `Origin` is a loopback host on an arbitrary port and must be matched on the
 * HOSTNAME, port-agnostically. A foreign origin (including a DNS-rebinding name pointed at
 * loopback, whose `Origin` stays the foreign name) or one that does not parse is refused.
 */
function isLoopbackOrigin(origin: string): boolean {
  let hostname: string;

  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }

  return LOOPBACK_HOSTNAMES.has(hostname);
}

/**
 * May this WebSocket upgrade onto the live-reload socket proceed — the DNS-rebinding /
 * browser-tab CSRF guard retrofitted onto the reload WS (ADR 0032 Inc 4c)?
 *
 * The reload WS leaks reload + error-overlay payloads (local source paths, stack frames) to
 * any tab that connects, and (unlike the dev MCP transport) carries no token — so this
 * Origin/Host allowlist is its only control. Its legitimate client is the dev app served
 * from the dev server's (dynamic) port, so the `Origin` is matched on the loopback HOSTNAME
 * ({@link isLoopbackOrigin}, any port) while the `Host` is matched on the reload server's own
 * loopback authority (port-specific, via {@link loopbackAllowlist} + the covered
 * {@link isHostAllowed}). An absent `Origin` is a non-browser client (no rebinding risk) and
 * passes; a foreign `Origin`, or a foreign/absent `Host`, is refused. Shares the Inc 4a
 * Host-allowlist logic — there is one validation, not a second copy in the bin.
 */
export function isLiveReloadUpgradeAllowed(options: {
  origin: string | undefined;
  host: string | undefined;
  port: number;
}): boolean {
  const originOk = options.origin === undefined || isLoopbackOrigin(options.origin);

  const hostOk = isHostAllowed(options.host, loopbackAllowlist(options.port).allowedHosts);

  return originOk && hostOk;
}
