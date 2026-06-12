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
 *   - `true` — the immediate peer is your proxy and exactly ONE trusted hop sits
 *     in front: the client is the RIGHT-most `X-Forwarded-For` entry (the address
 *     your single proxy observed and appended). This is the safe default for the
 *     `LB -> app` topology: an attacker who *prepends* a forged entry
 *     (`X-Forwarded-For: 1.2.3.4`, to which the LB appends the real peer) cannot
 *     move the right-most slot, so the spoof is ignored.
 *   - a number `n` — trust `n` proxy hops; the client is the entry `n` from the
 *     right of the `X-Forwarded-For` list (the last `n` were added by your own
 *     trusted hops). `true` is `1` with a different empty-chain fallback.
 *   - `"all"` — trust the ENTIRE client-supplied chain and take the LEFT-most
 *     entry as the originating client. This is the legacy "trust everything"
 *     behavior; it is forgeable by any client (the left-most entry is whatever
 *     the first hop was told) and exists only as an explicit, named escape hatch
 *     for topologies that genuinely cannot count their hops.
 *   - a predicate — trust the immediate peer iff it returns `true` for the peer's
 *     address, then peel trusted hops RIGHT-TO-LEFT for as long as the predicate
 *     keeps accepting each appended address (an allow-list of load-balancer IPs /
 *     a private-subnet test): the client is the first entry the predicate
 *     rejects, i.e. the address that entered your trusted perimeter.
 */
export type TrustProxy = boolean | number | "all" | ((peerAddress: string) => boolean);

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
 * `true` and `"all"` trust every peer; a number trusts a peer iff at least one
 * hop is configured (the count gates *how many* forwarded hops to peel, not
 * *whether* to trust the peer — a zero-hop policy trusts no forwarding); a
 * predicate is consulted with the peer's address; `false` trusts nobody.
 */
function peerIsTrusted(policy: TrustProxy, peerAddress: string | undefined): boolean {
  if (policy === false) return false;

  if (policy === true || policy === "all") return true;

  if (typeof policy === "number") return policy > 0;

  // A predicate needs an address to judge; an unknown peer is never trusted.
  if (peerAddress === undefined) return false;

  return policy(peerAddress);
}

/**
 * Resolve the client IP from the forwarding chain under a hop-aware policy.
 *
 * The chain reads `client, proxy1, …` left to right, each hop appending the
 * address that connected to it; the RIGHT-most entry is the address our own
 * immediate proxy observed and is the only one no external client can position.
 *
 *   - `true` — exactly one trusted hop in front, so the client is the RIGHT-most
 *     entry (`chain[length - 1]`). A prepended forgery cannot reach that slot.
 *   - a number `n` — the right-most `n` entries are our own trusted hops; the
 *     client is the entry just left of them, at index `length - 1 - n`. Out of
 *     range (a chain shorter than the hop count) clamps to the left-most entry.
 *   - `"all"` — trust the whole chain and take the LEFT-most entry (the legacy,
 *     forgeable behavior; an explicit escape hatch).
 *   - a predicate — peel trusted hops from the right for as long as the predicate
 *     accepts each entry; the client is the first entry (scanning right-to-left)
 *     the predicate rejects, i.e. the address that entered the trusted perimeter.
 *     If the predicate accepts every entry, the left-most stands.
 *
 * Returns `undefined` when the chain is empty (a trusted peer that sent no
 * `X-Forwarded-For`), so the caller falls back to the socket address.
 */
function clientFromChain(policy: Exclude<TrustProxy, false>, chain: string[]): string | undefined {
  if (chain.length === 0) return undefined;

  if (policy === "all") return chain[0];

  if (policy === true) return chain[chain.length - 1];

  if (typeof policy === "function") {
    // Walk right-to-left, peeling each entry the predicate vouches for. The first
    // rejected entry is the client (it entered our trusted perimeter); if all are
    // accepted, index lands at 0 and the left-most entry stands.
    let index = chain.length - 1;

    while (index > 0 && policy(chain[index] as string)) index -= 1;

    return chain[index];
  }

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

  // Trusted, so the policy is `true`, `"all"`, a positive hop count, or a
  // predicate that accepted this peer — never `false` (the untrusted branch above
  // already returned for it), which the cast records. Each policy carries its own
  // chain rule (right-most for `true`, hop-count for a number, left-most for
  // `"all"`, right-to-left peel for a predicate); `clientFromChain` dispatches.
  const chainPolicy = policy as Exclude<TrustProxy, false>;

  const forwardedIp = clientFromChain(chainPolicy, forwardedChain(headers["x-forwarded-for"]));

  // The first proto entry is the client-facing scheme; later entries are hops.
  const forwardedProto = forwardedChain(headers["x-forwarded-proto"])[0];

  return {
    ip: forwardedIp ?? peerAddress,
    protocol: forwardedProto ?? "http",
  };
}
