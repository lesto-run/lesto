/**
 * A signed, per-channel capability token — the edge-safe authz primitive for
 * `@lesto/pubsub` fan-out over WebSockets.
 *
 * The demo lets anyone who can reach `/subscribe` or `/publish` read or write any
 * channel. Production needs to answer "*may THIS principal subscribe to `org:42`?*",
 * and a browser cannot set headers on a WebSocket upgrade — so the answer rides the
 * URL. A shared secret in the URL would be a master credential logged by every
 * proxy; this module issues a **scoped capability** instead: the app's authenticated
 * backend mints a short-lived token for exactly one `(channel, mode)`, signed with a
 * server secret; the edge only ever *verifies* it before forwarding. A leaked token
 * grants one channel, one mode, for a short window — not the keys to the bus.
 *
 * Kept dependency-free and edge-shaped, like `packages/storage/src/sigv4.ts`: it
 * signs HMAC-SHA256 over `crypto.subtle` — a global on workerd, Bun, and Node ≥ 20 —
 * and never touches `node:crypto` or `Buffer`, so it runs unchanged on Cloudflare
 * Workers with no `nodejs_compat`. Verification is a constant-time `crypto.subtle.verify`.
 *
 * Wire format: `base64url(utf8(JSON({ channel, mode, exp }))) + "." + base64url(HMAC-SHA256(payload, secret))`.
 * A bad token is DATA, never an exception — {@link verifyChannelToken} returns a
 * tagged failure so a caller answers `401` instead of `500`.
 */

const ENCODER = new TextEncoder();

/** The two things a token can authorize: reading a channel, or writing to it. */
export type ChannelMode = "subscribe" | "publish";

/** What a token grants: one channel, one mode, until `exp`. */
export interface ChannelGrant {
  readonly channel: string;
  readonly mode: ChannelMode;
  /** Expiry as epoch milliseconds; the token is refused once `now >= exp`. */
  readonly exp: number;
}

/** Why a token was refused — each a distinct, non-overlapping cause. */
export type ChannelTokenFailure =
  | "malformed"
  | "bad-signature"
  | "expired"
  | "wrong-channel"
  | "wrong-mode";

/** The result of {@link verifyChannelToken}: the grant when valid, else a reason. */
export type ChannelTokenResult =
  | { readonly ok: true; readonly grant: ChannelGrant }
  | { readonly ok: false; readonly reason: ChannelTokenFailure };

/**
 * Mint a capability token for `grant`, signed with `secret`. Server-side only —
 * the app's issuer (which already holds the session) is the only party with the
 * secret; the browser and the edge never mint, only present and verify.
 */
export async function mintChannelToken(grant: ChannelGrant, secret: string): Promise<string> {
  const payload = base64urlEncode(ENCODER.encode(JSON.stringify(grant)));
  const signature = base64urlEncode(await sign(payload, secret));

  return `${payload}.${signature}`;
}

/**
 * Verify `token` against the REQUESTED `channel` + `mode` + `now` (default
 * `Date.now()`), under `secret`. Never throws — a malformed, forged, expired, or
 * mis-scoped token is a tagged failure, so the caller returns `401` rather than
 * crashing.
 *
 * The signature is checked (constant-time) BEFORE any claim is trusted, so a caller
 * that cannot forge a signature can never reach the channel/mode/exp checks — the
 * distinct `wrong-channel`/`wrong-mode`/`expired` reasons only ever describe a
 * genuinely-signed token. A subscribe token cannot publish; a token for one channel
 * cannot touch another; an expired token is refused.
 */
export async function verifyChannelToken(
  token: string,
  expected: { readonly channel: string; readonly mode: ChannelMode; readonly now?: number },
  secret: string,
): Promise<ChannelTokenResult> {
  // Exactly one dot, with a non-empty payload before it and a non-empty signature
  // after it. `indexOf`/`lastIndexOf` reject zero dots, a leading/trailing dot, and
  // any extra dot without allocating a split array.
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".") || dot === token.length - 1) {
    return { ok: false, reason: "malformed" };
  }

  const payloadPart = token.slice(0, dot);
  const grant = decodeGrant(payloadPart);
  if (grant === undefined) {
    return { ok: false, reason: "malformed" };
  }

  const signature = base64urlDecode(token.slice(dot + 1));
  if (signature === undefined) {
    return { ok: false, reason: "malformed" };
  }

  if (!(await verifySignature(payloadPart, signature, secret))) {
    return { ok: false, reason: "bad-signature" };
  }

  if (grant.channel !== expected.channel) {
    return { ok: false, reason: "wrong-channel" };
  }

  if (grant.mode !== expected.mode) {
    return { ok: false, reason: "wrong-mode" };
  }

  const now = expected.now ?? Date.now();
  if (now >= grant.exp) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, grant };
}

/** Decode a base64url payload into a {@link ChannelGrant}, or `undefined` if it is not one. */
function decodeGrant(payloadPart: string): ChannelGrant | undefined {
  const bytes = base64urlDecode(payloadPart);
  if (bytes === undefined) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  const { channel, mode, exp } = parsed as Record<string, unknown>;

  if (typeof channel !== "string" || channel.length === 0) {
    return undefined;
  }

  if (mode !== "subscribe" && mode !== "publish") {
    return undefined;
  }

  // `exp` must be a FINITE number. `decodeGrant` runs before the signature check, so
  // a forged payload carrying `{"exp":1e400}` (→ Infinity via `JSON.parse`) reaches
  // here; without the finite guard that would decode to a never-expiring grant.
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    return undefined;
  }

  return { channel, mode, exp };
}

/** HMAC-SHA256 of `payload` under `secret`, as raw bytes (mirrors `sigv4.ts`'s `hmac`). */
async function sign(payload: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    // ArrayBuffer-backed (never SharedArrayBuffer): satisfies `BufferSource` under
    // the stricter Workers/DOM libs a consumer may compile against.
    ENCODER.encode(secret) as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    ENCODER.encode(payload) as Uint8Array<ArrayBuffer>,
  );

  return new Uint8Array(signature);
}

/** Constant-time verify of `signature` over `payload` under `secret`, via `crypto.subtle.verify`. */
async function verifySignature(
  payload: string,
  signature: Uint8Array,
  secret: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      ENCODER.encode(secret) as Uint8Array<ArrayBuffer>,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );

    return await crypto.subtle.verify(
      "HMAC",
      key,
      signature as Uint8Array<ArrayBuffer>,
      ENCODER.encode(payload) as Uint8Array<ArrayBuffer>,
    );
  } catch {
    // An empty or otherwise-unusable secret makes `importKey` throw (workerd, Bun,
    // and Node all reject a zero-length HMAC key). Honor the "never throws" contract:
    // a key we cannot verify under is a failed verification (→ `bad-signature`), not
    // a crash the caller must guard against.
    return false;
  }
}

/** base64url (no padding) of a byte array — the URL-safe alphabet, `=` stripped. */
function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * Decode base64url back to bytes; `undefined` if it is not valid base64url. `atob`
 * implements WHATWG forgiving-base64 (no padding required) on workerd, Bun, and
 * Node, and throws on an invalid alphabet — which we treat as malformed, not fatal.
 */
function base64urlDecode(value: string): Uint8Array | undefined {
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");

  let binary: string;
  try {
    binary = atob(standard);
  } catch {
    return undefined;
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}
