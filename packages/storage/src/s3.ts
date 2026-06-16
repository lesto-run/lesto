import { StorageError } from "./errors";
import { encodeRfc3986, hashHex, presignUrl, signRequest } from "./sigv4";

import type { SigV4Credentials } from "./sigv4";
import type { StorageBackend, UrlOptions } from "./types";

/** The body shape `fetch` accepts, without depending on the DOM `BodyInit`. */
type FetchBody = NonNullable<NonNullable<Parameters<typeof fetch>[1]>["body"]>;

/** Lowercase-hex SHA-256 of the empty string — the body hash for bodiless verbs. */
const EMPTY_BODY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * The configuration an S3-compatible backend needs to address a bucket.
 *
 * The shape is deliberately endpoint-first so it serves AWS S3, Cloudflare R2,
 * MinIO, and anything else that speaks the S3 REST API: point `endpoint` at the
 * service host and name the `bucket`. For R2 the endpoint is
 * `https://<account>.r2.cloudflarestorage.com` and the region is `auto`.
 */
export interface S3BackendOptions {
  /** Service endpoint origin, e.g. `https://s3.us-east-1.amazonaws.com`. */
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Optional STS session token for temporary credentials. */
  readonly sessionToken?: string;
  /**
   * The base for public, unsigned URLs (a CDN or `*.r2.dev` domain). When set,
   * `url()` without an expiry returns `${publicBaseUrl}/${key}`. When unset,
   * a non-presigned `url()` falls back to the path-style object URL.
   */
  readonly publicBaseUrl?: string;
  /** Override `fetch` — for tests, or to inject a Workers binding's fetcher. */
  readonly fetch?: typeof fetch;
  /** Override the clock — for deterministic signing in tests. */
  readonly now?: () => Date;
}

/**
 * An S3/R2 backend that speaks the S3 REST API directly over `fetch`.
 *
 * No AWS SDK and no Node built-ins: requests are signed with AWS Signature
 * Version 4 via Web Crypto (`crypto.subtle`), so this backend runs unchanged on
 * Cloudflare Workers as well as Node. It is the only production-grade backend —
 * `MemoryBackend` and `FileBackend` are local/dev only.
 */
export class S3Backend implements StorageBackend {
  private readonly endpoint: string;
  private readonly publicBaseUrl: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: S3BackendOptions) {
    // Normalize away a trailing slash so path joins never double up.
    this.endpoint = options.endpoint.replace(/\/$/, "");
    this.publicBaseUrl = options.publicBaseUrl?.replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async put(key: string, data: Buffer): Promise<void> {
    const body = new Uint8Array(data);
    const response = await this.send("PUT", key, body, await hashHex(body));

    await this.expectOk(response, "put", key);
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.send("GET", key);

    if (response.status === 404) {
      throw new StorageError("STORAGE_NOT_FOUND", `No object at key "${key}".`, { key });
    }

    await this.expectOk(response, "get", key);

    return Buffer.from(await response.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const response = await this.send("DELETE", key);

    // S3 returns 204 whether or not the key existed, so delete is idempotent.
    // A 404 is treated the same way — the contract says delete is a no-op.
    if (response.status === 404) return;

    await this.expectOk(response, "delete", key);
  }

  async exists(key: string): Promise<boolean> {
    const response = await this.send("HEAD", key);

    if (response.status === 404) return false;

    await this.expectOk(response, "exists", key);

    return true;
  }

  async list(prefix?: string): Promise<string[]> {
    const url = new URL(this.endpoint);
    url.pathname = `/${encodeRfc3986(this.options.bucket)}`;

    // Build the query with the SAME strict encoding the signer canonicalizes
    // under — `URLSearchParams` would serialize a space as `+` and leave `*`/`~`
    // alone, diverging from the signature and tripping `SignatureDoesNotMatch`.
    const query = ["list-type=2"];
    if (prefix !== undefined) query.push(`prefix=${encodeRfc3986(prefix)}`);
    url.search = query.join("&");

    const response = await this.signedFetch("GET", url);

    await this.expectOk(response, "list", prefix ?? "");

    return parseListKeys(await response.text());
  }

  async url(key: string, options?: UrlOptions): Promise<string> {
    this.guard(key);

    const expiresInSeconds = options?.expiresInSeconds ?? 0;

    if (expiresInSeconds > 0) {
      return presignUrl(
        "GET",
        this.objectUrl(key),
        this.credentials(),
        expiresInSeconds,
        this.now(),
      );
    }

    // A public URL prefers the configured CDN/public domain; otherwise it is the
    // plain path-style object URL (which only resolves if the object is public).
    // Encode each key segment so a key with a space or reserved char yields a
    // valid URL (slashes stay path separators).
    if (this.publicBaseUrl !== undefined) {
      const encoded = key
        .split("/")
        .map((segment) => encodeRfc3986(segment))
        .join("/");

      return `${this.publicBaseUrl}/${encoded}`;
    }

    return this.objectUrl(key).toString();
  }

  /** Sign and dispatch a request against the object addressed by `key`. */
  private async send(
    method: string,
    key: string,
    body?: Uint8Array,
    payloadHash?: string,
  ): Promise<Response> {
    this.guard(key);

    return this.signedFetch(method, this.objectUrl(key), body, payloadHash);
  }

  /**
   * Sign `url` with SigV4 and fetch it.
   *
   * Only `put` carries a body, and it always supplies the matching
   * `payloadHash`; every other verb signs the empty-body hash.
   */
  private async signedFetch(
    method: string,
    url: URL,
    body?: Uint8Array,
    payloadHash?: string,
  ): Promise<Response> {
    const headers = await signRequest(
      { method, url, headers: {}, payloadHash: payloadHash ?? EMPTY_BODY_HASH },
      this.credentials(),
      this.now(),
    );

    // Attach a body only when there is one — `exactOptionalPropertyTypes`
    // refuses an explicit `body: undefined` on `RequestInit`.
    const init: Parameters<typeof fetch>[1] = { method, headers };
    if (body !== undefined) init.body = body as FetchBody;

    return this.fetchImpl(url.toString(), init);
  }

  /** The path-style URL for an object: `${endpoint}/${bucket}/${key}`. */
  private objectUrl(key: string): URL {
    const url = new URL(this.endpoint);
    // Encode each path segment with the signer's strict RFC-3986 rules (not
    // `encodeURIComponent`, which leaves `!*'()` literal) so the path we PUT/GET
    // on the wire is byte-identical to the one we sign — keys like
    // `photo (1).jpg` must not desync the signature.
    url.pathname = `/${encodeRfc3986(this.options.bucket)}/${key
      .split("/")
      .map((segment) => encodeRfc3986(segment))
      .join("/")}`;

    return url;
  }

  /** The SigV4 credentials this backend signs with. */
  private credentials(): SigV4Credentials {
    return {
      accessKeyId: this.options.accessKeyId,
      secretAccessKey: this.options.secretAccessKey,
      // Spread the token only when set — `exactOptionalPropertyTypes` forbids
      // assigning `undefined` to an optional property.
      ...(this.options.sessionToken !== undefined
        ? { sessionToken: this.options.sessionToken }
        : {}),
      region: this.options.region,
      service: "s3",
    };
  }

  /** Refuse any key that could escape the bucket, mirroring `FileBackend`. */
  private guard(key: string): void {
    if (key.includes("..") || key.startsWith("/")) {
      throw new StorageError("STORAGE_INVALID_KEY", `Unsafe storage key "${key}".`, { key });
    }
  }

  /** Turn a non-2xx S3 response into a coded `STORAGE_BACKEND_ERROR`. */
  private async expectOk(response: Response, operation: string, key: string): Promise<void> {
    if (response.ok) return;

    const detail = await response.text();
    throw new StorageError(
      "STORAGE_BACKEND_ERROR",
      `S3 ${operation} of "${key}" failed with ${response.status}.`,
      { key, operation, status: response.status, detail },
    );
  }
}

/** Pull `<Key>` values out of an S3 `ListObjectsV2` XML response. */
function parseListKeys(xml: string): string[] {
  const keys: string[] = [];
  const pattern = /<Key>([^<]*)<\/Key>/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    // Group 1 always participates when the pattern matches, so it is defined.
    keys.push(decodeXmlEntities(match[1]!));
  }

  return keys;
}

/** Decode the five XML predefined entities S3 escapes keys with. */
function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}
