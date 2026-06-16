/**
 * AWS Signature Version 4 — a self-contained signer over Web Crypto.
 *
 * This module knows nothing about storage. It is the single signing
 * implementation Keel intends to share between consumers (the S3/R2 storage
 * backend signs requests here; a future remote `ReleaseStore` will presign URLs
 * with the same code). Keep it dependency-free and edge-shaped: it uses only
 * `crypto.subtle` and `fetch`-native types, never `node:crypto` or `Buffer`,
 * so it runs unchanged on Cloudflare Workers.
 *
 * The implementation follows the AWS reference algorithm exactly:
 * https://docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html
 */

const ENCODER = new TextEncoder();

/** The immutable identity + scope a signature is computed against. */
export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Optional STS session token, sent as `x-amz-security-token`. */
  readonly sessionToken?: string;
  readonly region: string;
  /** The AWS service name, e.g. `"s3"`. */
  readonly service: string;
}

/** A request to sign, expressed in terms that do not depend on `fetch`. */
export interface SigV4Request {
  readonly method: string;
  /** A fully-qualified URL — its host, path, and query all feed the signature. */
  readonly url: URL;
  /** Request headers; `host` is added for you when absent. */
  readonly headers: Record<string, string>;
  /**
   * The lowercase-hex SHA-256 of the body. Use `UNSIGNED_PAYLOAD` for streams
   * or presigned URLs, or `hashHex("")` for an empty body.
   */
  readonly payloadHash: string;
}

/** The sentinel S3 accepts in place of a real body hash. */
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

/** Lowercase-hex SHA-256 of a string or bytes — the payload-hash primitive. */
export async function hashHex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? ENCODER.encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return toHex(new Uint8Array(digest));
}

/**
 * Sign a request and return the headers to merge onto it.
 *
 * The returned object always carries `Authorization`, `x-amz-date`, and
 * `x-amz-content-sha256`; it carries `x-amz-security-token` iff a session token
 * was supplied. The caller merges these onto the outgoing request.
 */
export async function signRequest(
  request: SigV4Request,
  credentials: SigV4Credentials,
  now: Date,
): Promise<Record<string, string>> {
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);

  // The signed headers always include host and the two amz headers below; a
  // session token, when present, is signed too so it cannot be tampered with.
  const headers: Record<string, string> = {
    ...request.headers,
    host: request.url.host,
    "x-amz-content-sha256": request.payloadHash,
    "x-amz-date": amzDate,
  };

  if (credentials.sessionToken !== undefined) {
    headers["x-amz-security-token"] = credentials.sessionToken;
  }

  const { canonicalHeaders, signedHeaders } = canonicalizeHeaders(headers);

  const canonicalRequest = [
    request.method,
    canonicalUri(request.url),
    canonicalQuery(request.url),
    canonicalHeaders,
    signedHeaders,
    request.payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${credentials.region}/${credentials.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await hashHex(canonicalRequest)].join(
    "\n",
  );

  const signingKey = await deriveSigningKey(credentials, dateStamp);
  const signature = toHex(await hmac(signingKey, stringToSign));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { ...headers, Authorization: authorization };
}

/**
 * Presign a URL — the signature travels in the query string, not a header.
 *
 * The returned URL grants the bearer `request.method` access to the object for
 * `expiresInSeconds`, with no credentials in the request itself. This is the
 * shape browsers and `<img>` tags can use directly.
 */
export async function presignUrl(
  method: string,
  url: URL,
  credentials: SigV4Credentials,
  expiresInSeconds: number,
  now: Date,
): Promise<string> {
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${credentials.region}/${credentials.service}/aws4_request`;

  // Presigning signs only the host header; everything else rides in the query.
  const signed = new URL(url.toString());
  signed.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  signed.searchParams.set("X-Amz-Credential", `${credentials.accessKeyId}/${scope}`);
  signed.searchParams.set("X-Amz-Date", amzDate);
  signed.searchParams.set("X-Amz-Expires", String(expiresInSeconds));
  if (credentials.sessionToken !== undefined) {
    signed.searchParams.set("X-Amz-Security-Token", credentials.sessionToken);
  }
  signed.searchParams.set("X-Amz-SignedHeaders", "host");

  const canonicalRequest = [
    method,
    canonicalUri(signed),
    canonicalQuery(signed),
    `host:${signed.host}\n`,
    "host",
    UNSIGNED_PAYLOAD,
  ].join("\n");

  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await hashHex(canonicalRequest)].join(
    "\n",
  );

  const signingKey = await deriveSigningKey(credentials, dateStamp);
  const signature = toHex(await hmac(signingKey, stringToSign));

  signed.searchParams.set("X-Amz-Signature", signature);

  return signed.toString();
}

/** Derive the date/region/service-scoped HMAC key chain. */
async function deriveSigningKey(
  credentials: SigV4Credentials,
  dateStamp: string,
): Promise<Uint8Array> {
  const kDate = await hmac(ENCODER.encode(`AWS4${credentials.secretAccessKey}`), dateStamp);
  const kRegion = await hmac(kDate, credentials.region);
  const kService = await hmac(kRegion, credentials.service);

  return hmac(kService, "aws4_request");
}

/** HMAC-SHA256 of `message` under `key`, as raw bytes. */
async function hmac(key: Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, ENCODER.encode(message));

  return new Uint8Array(signature);
}

/** Canonicalize and sort the signed headers into AWS's required form. */
function canonicalizeHeaders(headers: Record<string, string>): {
  canonicalHeaders: string;
  signedHeaders: string;
} {
  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .toSorted();

  const lookup = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    lookup.set(name.toLowerCase(), value.trim().replace(/\s+/g, " "));
  }

  const canonicalHeaders = names.map((name) => `${name}:${lookup.get(name)}\n`).join("");

  return { canonicalHeaders, signedHeaders: names.join(";") };
}

/** The path, percent-encoded per AWS rules (each segment, but not the slashes). */
function canonicalUri(url: URL): string {
  if (url.pathname === "" || url.pathname === "/") return "/";

  return url.pathname
    .split("/")
    .map((segment) => encodeRfc3986(decodeURIComponent(segment)))
    .join("/");
}

/** Query parameters sorted by key, each side percent-encoded per AWS rules. */
function canonicalQuery(url: URL): string {
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of url.searchParams) {
    pairs.push([encodeRfc3986(key), encodeRfc3986(value)]);
  }

  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));

  return pairs.map(([key, value]) => `${key}=${value}`).join("&");
}

/**
 * RFC 3986 percent-encoding — stricter than `encodeURIComponent`, which leaves
 * `!*'()` unescaped. AWS requires those escaped too (but never the slash).
 *
 * Exported because a request must be **sent** under the exact same encoding it
 * is **signed** under: the S3 backend encodes object keys and query values with
 * this so the wire URL matches the canonical URL byte-for-byte (otherwise S3
 * answers `SignatureDoesNotMatch` for any key/prefix containing `!*'()`, a
 * space, `*`, or `~`).
 */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** UTC `YYYYMMDDTHHMMSSZ`, the format `x-amz-date` requires. */
function toAmzDate(now: Date): string {
  return `${now.toISOString().replace(/[:-]|\.\d{3}/g, "")}`;
}

/** Lowercase-hex of a byte array. */
function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }

  return hex;
}
