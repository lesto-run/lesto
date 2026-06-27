/**
 * The registration shapes — the contract ADR 0040 designs, encoded as types.
 *
 * SKELETON (ADR 0040): these are the *shapes* the open-MCP-client-registration build
 * (ADR 0029 Phase 3) will produce and consume. They carry no behavior. Three mechanisms
 * — CIMD, DCR (RFC 7591), pre-registration — all resolve to the single
 * {@link RegisteredClient} the AS's `/authorize` consumes, so nothing downstream branches
 * on how a client registered.
 */

/** Which mechanism produced a {@link RegisteredClient}. Ordered by safety: CIMD ≻ DCR ≻ pre-reg. */
export type RegistrationSource = "cimd" | "dcr" | "preregistered";

/**
 * The one client shape `/authorize` consumes — the output of the {@link ResolveClient}
 * seam, regardless of source. `/authorize`, consent, the exact-`redirect_uri` rule, and
 * RFC 8707 `aud` binding (ADR 0029) read this and never learn the mechanism.
 */
export interface RegisteredClient {
  /**
   * The client identity. For CIMD this IS the `https:` URL the metadata was fetched from;
   * for DCR / pre-registration it is an opaque minted id. NEVER the token's `aud` — the
   * audience is the registered *resource* (ADR 0040 D4), kept distinct on purpose so the
   * confused-deputy boundary is not blurred.
   */
  readonly clientId: string;

  /**
   * The exact-match `redirect_uri` allow-list. Matched byte-for-byte at `/authorize` —
   * never a prefix, substring, or wildcard — and NEVER dereferenced at registration.
   */
  readonly redirectUris: readonly string[];

  /** Which mechanism registered this client (audit + posture; not an authorization input). */
  readonly source: RegistrationSource;

  /** A human label for the consent screen ONLY. Display-only — never trusted for routing/identity. */
  readonly clientName?: string;

  /**
   * The maximum scope this client may request — a ceiling the AS intersects with what the
   * resource owner consents to. Optional; absent means "no client-declared ceiling."
   */
  readonly maxScope?: string;
}

/**
 * The client-metadata document a client publishes (CIMD, at its `client_id` URL) or POSTs
 * (DCR, to `/register`). Keyed by RFC 7591 §2 field names — the subset MCP needs. Validated
 * at the boundary (ADR 0005) before it ever becomes a {@link RegisteredClient}.
 */
export interface ClientMetadataDocument {
  /** Present + byte-equal-to-the-fetched-URL for CIMD; ABSENT for a DCR request (the AS mints it). */
  readonly client_id?: string;

  /** Display name (consent screen). */
  readonly client_name?: string;

  /** The client's home page (informational). */
  readonly client_uri?: string;

  /** A logo URL — rendered sandboxed or not at all (anti-phishing). */
  readonly logo_uri?: string;

  /** The exact `redirect_uri` allow-list — absolute `https:` (or an exact loopback for native). */
  readonly redirect_uris: readonly string[];

  /** Public client by default — PKCE `S256` is the proof, so this is `"none"`. */
  readonly token_endpoint_auth_method?: "none" | "client_secret_basic" | "client_secret_post";

  /** Must be a subset of `["authorization_code", "refresh_token"]` — never implicit. */
  readonly grant_types?: readonly string[];

  /** Must be a subset of `["code"]` — the implicit grant is refused. */
  readonly response_types?: readonly string[];

  /** The maximum scope the client may request (a space-delimited ceiling). */
  readonly scope?: string;

  /** An optional signed software statement (RFC 7591 §2.3) — a JWT; turns open DCR into attested DCR. */
  readonly software_statement?: string;
}

/** How a Lesto AS deployment configures the registration surface (the posture levers of ADR 0040 D3/D6). */
export interface RegistrationConfig {
  /**
   * Whether `POST /register` (RFC 7591 DCR) is enabled. **Off by default** — DCR is the
   * only attacker-writable surface, so the owner opts in explicitly. CIMD and
   * pre-registration need no flag.
   */
  readonly dynamicRegistration: boolean;

  /**
   * An optional trust anchor (an issuer URL / JWKS) for software statements. When set,
   * UNSIGNED dynamic registrations are refused — open DCR becomes *attested* DCR. Absent
   * means fully-open, rate-limited DCR (when `dynamicRegistration` is on).
   */
  readonly softwareStatementTrustAnchor?: string;
}

/** The seam `/authorize` uses to learn about a client — the only path, regardless of mechanism. */
export type ResolveClient = (clientId: string) => Promise<RegisteredClient | undefined>;
