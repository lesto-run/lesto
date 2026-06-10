/**
 * Trust-proxy: deciding whom to believe about the client's IP and protocol.
 *
 * THE HAZARD, stated plainly: `X-Forwarded-For` and `X-Forwarded-Proto` are
 * just request headers, so *any* client can forge them. A direct caller can
 * claim to be `1.2.3.4` on `https` simply by setting the headers. Believing them
 * unconditionally would let an attacker spoof the IP every rate-limit and audit
 * log keys on. So these headers are trusted ONLY when the immediate peer — the
 * socket we actually accepted the connection from — is a proxy we put there.
 *
 * Default: trust nothing. The client IP is the socket's own remote address and
 * the protocol is plain `http` (a TLS terminator in front is exactly the proxy
 * case you must opt into). An app deployed behind a known load balancer sets
 * `trustProxy` so the forwarded client identity is believed — and only then.
 *
 * Pure and transport-free: a plain function of the peer address, the headers,
 * and the policy, so every branch is unit-testable without a socket.
 */

/**
 * How much to trust forwarding headers.
 *
 *   - `false` (default) — trust nothing; use the socket peer and `http`.
 *   - `true` — the immediate peer is always a trusted proxy; believe the
 *     left-most `X-Forwarded-For` entry as the originating client.
 *   - a number `n` — trust `n` proxy hops; the client is the entry `n` from the
 *     right of the `X-Forwarded-For` list (the last `n` were added by your own
 *     trusted hops).
 *   - a predicate — trust the peer iff it returns `true` for the peer's address
 *     (e.g. an allow-list of load-balancer IPs / a private-subnet test).
 */
export type TrustProxy = boolean | number | ((peerAddress: string) => boolean);

/** The forwarding headers we read, as the transport flattens them (lowercased). */
export interface ForwardHeaders {
  readonly "x-forwarded-for"?: string;

  readonly "x-forwarded-proto"?: string;
}

/** The resolved client identity to put on the request context. */
export interface ResolvedClient {
  /** The client IP we believe, or `undefined` when even the socket address is unknown. */
  readonly ip: string | undefined;

  /** The request protocol: `"https"` when a trusted proxy says so, else `"http"`. */
  readonly protocol: string;
}

/** Split an `X-Forwarded-For` value into trimmed, non-empty hop addresses. */
function forwardedChain(value: string | undefined): string[] {
  if (value === undefined) return [];

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Decide whether the immediate peer is a trusted proxy under the policy.
 *
 * `true` trusts every peer; a number trusts a peer iff at least one hop is
 * configured (the count gates *how many* forwarded hops to peel, not *whether*
 * to trust the peer — a zero-hop policy trusts no forwarding); a predicate is
 * consulted with the peer's address; `false` trusts nobody.
 */
function peerIsTrusted(policy: TrustProxy, peerAddress: string | undefined): boolean {
  if (policy === false) return false;

  if (policy === true) return true;

  if (typeof policy === "number") return policy > 0;

  // A predicate needs an address to judge; an unknown peer is never trusted.
  if (peerAddress === undefined) return false;

  return policy(peerAddress);
}

/**
 * Resolve the client IP from the forwarding chain under a hop-aware policy.
 *
 *   - `true` — the originating client is the left-most entry (the first proxy
 *     wrote the real client, and every hop appended itself to the right).
 *   - a number `n` — the chain reads `client, proxy1, …` left to right, each hop
 *     appending the address that connected to it. The right-most `n` entries are
 *     our own trusted hops; the client is the entry just left of them, at index
 *     `length - 1 - n`. Out of range (a chain shorter than the hop count) clamps
 *     to the left-most entry we have.
 *
 * Returns `undefined` when the chain is empty (a trusted peer that sent no
 * `X-Forwarded-For`), so the caller falls back to the socket address.
 */
function clientFromChain(policy: true | number, chain: string[]): string | undefined {
  if (chain.length === 0) return undefined;

  if (policy === true) return chain[0];

  // `policy` is the hop count: strip the right-most `policy` trusted hops and
  // take the entry before them, clamped into the chain's bounds.
  const index = Math.max(0, chain.length - 1 - policy);

  return chain[index];
}

/**
 * Resolve the client IP and protocol for a request under the trust policy.
 *
 * When the peer is trusted we believe the forwarding headers — the
 * `X-Forwarded-For` client (hop-aware) and the first `X-Forwarded-Proto` value;
 * otherwise we use the socket's own remote address and plain `http`. A trusted
 * peer that omitted the headers still falls back to the socket / `http`, so a
 * missing header never produces a bogus identity.
 */
export function resolveClient(
  policy: TrustProxy,
  peerAddress: string | undefined,
  headers: ForwardHeaders,
): ResolvedClient {
  if (!peerIsTrusted(policy, peerAddress)) {
    return { ip: peerAddress, protocol: "http" };
  }

  // Trusted, so the policy is `true`, a positive hop count, or a predicate that
  // accepted this peer. A numeric policy peels that many hops; `true` and a
  // predicate both lack a hop count, so they take the left-most (originating)
  // client — the predicate having already vouched for the peer.
  const chainPolicy = typeof policy === "number" ? policy : true;

  const forwardedIp = clientFromChain(chainPolicy, forwardedChain(headers["x-forwarded-for"]));

  // The first proto entry is the client-facing scheme; later entries are hops.
  const forwardedProto = forwardedChain(headers["x-forwarded-proto"])[0];

  return {
    ip: forwardedIp ?? peerAddress,
    protocol: forwardedProto ?? "http",
  };
}
