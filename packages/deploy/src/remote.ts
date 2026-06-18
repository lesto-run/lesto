/**
 * A remote {@link ReleaseStore} over an S3-compatible object store (R2 / S3).
 *
 * This is the headline-target store: it makes Lesto's versioned release machinery
 * — stage every file under an immutable `releases/<version>/` prefix, run the
 * health gate, then atomically flip a pointer — reach a real CDN instead of only
 * local disk. The release *logic* lives in {@link shipRelease} / {@link rollback}
 * unchanged; this module is purely the five-function backend they drive.
 *
 * It speaks the S3 REST API directly over `fetch`, signed with AWS Signature
 * Version 4 from `@lesto/storage` (the one signing implementation — there is no
 * second copy of the signing math; we import `signRequest`/`hashHex` and the
 * `encodeRfc3986` wire-encoder). No AWS SDK and no Node built-ins on the request
 * path: every R2 operation (`put`, `setCurrent`, `getCurrent`, `listReleases`)
 * uses only `crypto.subtle` and `fetch`, so the store runs unchanged on
 * Cloudflare Workers. Only `read` — pulling a built file off the local build
 * output during a deploy — touches the filesystem, and it is injectable so even
 * that can be supplied by a Workers binding.
 *
 * The atomic-flip primitive on an object store is a single object write: the
 * live pointer is one small object (`current` by default) whose body is the live
 * version string. Writing an object is atomic — a reader sees the old version or
 * the new one, never a torn value — so `setCurrent` is the cutover, exactly as
 * the POSIX symlink rename is for {@link nodeReleaseStore}. A failed health gate
 * never reaches `setCurrent`, so the pointer never moves off the last good
 * release.
 */

import { encodeRfc3986, hashHex, signRequest } from "@lesto/storage";

import { DeployError } from "./errors";
import type { ReleaseStore } from "./release";
import type { ShipDeps } from "./ship";

/** Lowercase-hex SHA-256 of the empty string — the body hash for bodiless verbs. */
const EMPTY_BODY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** The prefix every release's files live under (mirrors `nodeReleaseStore`). */
const RELEASES_PREFIX = "releases/";

/** The default key of the live-pointer object: its body is the live version. */
const DEFAULT_POINTER_KEY = "current";

/** The body shape `fetch` accepts, without depending on the DOM `BodyInit`. */
type FetchBody = NonNullable<NonNullable<Parameters<typeof fetch>[1]>["body"]>;

/**
 * How to address and authenticate against the remote object store.
 *
 * The shape is endpoint-first so it serves Cloudflare R2, AWS S3, and MinIO
 * alike: point `endpoint` at the service origin and name the `bucket`. For R2 the
 * endpoint is `https://<account>.r2.cloudflarestorage.com` and the region is
 * `auto`. Credentials are SigV4 access keys (R2 issues S3-compatible ones).
 */
export interface RemoteReleaseStoreOptions {
  /** Service endpoint origin, e.g. `https://<account>.r2.cloudflarestorage.com`. */
  readonly endpoint: string;

  /** The bucket releases publish into. */
  readonly bucket: string;

  /** The signing region — `auto` for R2, e.g. `us-east-1` for S3. */
  readonly region: string;

  readonly accessKeyId: string;

  readonly secretAccessKey: string;

  /** Optional STS session token for temporary credentials. */
  readonly sessionToken?: string;

  /**
   * The object key holding the live-version pointer. Defaults to `current`; one
   * bucket can host several sites by giving each its own pointer key.
   */
  readonly pointerKey?: string;

  /**
   * Read a built file's raw bytes from the build output. Defaults to a Node
   * filesystem read of `<outRoot>/<file>`; inject to run off a non-Node source
   * (a test, or a Workers binding) so nothing on the wire path needs `node:fs`.
   */
  readonly read?: ShipDeps["read"];

  /** Override `fetch` — for tests, or to inject a Workers binding's fetcher. */
  readonly fetch?: typeof fetch;

  /** Override the clock — for deterministic signing in tests. */
  readonly now?: () => Date;
}

/** Turn a non-2xx object-store response into a coded `DEPLOY_REMOTE_ERROR`. */
async function expectOk(response: Response, operation: string, key: string): Promise<void> {
  if (response.ok) return;

  const detail = await response.text();
  throw new DeployError(
    "DEPLOY_REMOTE_ERROR",
    `Remote release ${operation} of "${key}" failed with ${response.status}.`,
    { key, operation, status: response.status, detail },
  );
}

/**
 * Build a {@link ReleaseStore} backed by an S3-compatible object store (R2 / S3).
 *
 * Drive it with the same {@link shipRelease} / {@link rollback} the local store
 * uses — only the backend changes. `put` lands each staged file as an immutable
 * object under `releases/<version>/…`; `setCurrent` writes the pointer object
 * (the atomic flip); `getCurrent` reads it (absent → `undefined`, before the
 * first release); `listReleases` enumerates the version "directories" so a
 * rollback can refuse a typo. `read` pulls bytes off the local build output.
 */
export function remoteReleaseStore(options: RemoteReleaseStoreOptions): ReleaseStore {
  // Normalize away a trailing slash so path joins never double up.
  const endpoint = options.endpoint.replace(/\/$/, "");
  const pointerKey = options.pointerKey ?? DEFAULT_POINTER_KEY;
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? ((): Date => new Date());

  const read =
    options.read ??
    (async (outRoot: string, file: string): Promise<Uint8Array> => {
      // The build-output read is the one filesystem touch; keep `node:fs` off the
      // module's top level (and off the request path) by importing it lazily, so
      // the wire operations stay Workers-clean.
      const { readFile } = await import("node:fs/promises");
      const { resolve } = await import("node:path");

      return readFile(resolve(outRoot, file));
    });

  /** The path-style URL for an object: `${endpoint}/${bucket}/${key}`. */
  function objectUrl(key: string): URL {
    const url = new URL(endpoint);

    // Encode the bucket and each key segment with the signer's strict RFC-3986
    // rules (not `encodeURIComponent`, which leaves `!*'()` literal) so the path
    // we send on the wire is byte-identical to the one we sign — a release file
    // named `photo (1).jpg` must not desync the signature.
    url.pathname = `/${encodeRfc3986(options.bucket)}/${key
      .split("/")
      .map((segment) => encodeRfc3986(segment))
      .join("/")}`;

    return url;
  }

  /** Sign `method url` with SigV4 over the given body hash, then fetch it. */
  async function signedFetch(
    method: string,
    url: URL,
    body?: Uint8Array,
    payloadHash?: string,
  ): Promise<Response> {
    const headers = await signRequest(
      {
        method,
        url,
        headers: {},
        payloadHash: payloadHash ?? EMPTY_BODY_HASH,
      },
      {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        // Spread the token only when set — `exactOptionalPropertyTypes` forbids
        // assigning `undefined` to an optional property.
        ...(options.sessionToken !== undefined ? { sessionToken: options.sessionToken } : {}),
        region: options.region,
        service: "s3",
      },
      now(),
    );

    // Attach a body only when there is one — `exactOptionalPropertyTypes`
    // refuses an explicit `body: undefined` on `RequestInit`.
    const init: Parameters<typeof fetch>[1] = { method, headers };
    if (body !== undefined) init.body = body as FetchBody;

    return fetchImpl(url.toString(), init);
  }

  return {
    read,

    // `put` is the byte-canonical arm of the ship seam plus a string convenience
    // arm; both reduce to a single signed PUT of the encoded payload bytes.
    put: (key: string, contents: Uint8Array | string): Promise<void> => {
      const body = typeof contents === "string" ? new TextEncoder().encode(contents) : contents;

      return hashHex(body)
        .then((payloadHash) => signedFetch("PUT", objectUrl(key), body, payloadHash))
        .then((response) => expectOk(response, "put", key));
    },

    setCurrent: async (version) => {
      // The flip is a single atomic object write: overwrite the pointer object
      // with the new live version. A reader of the pointer sees the old version
      // or the new one, never a torn value.
      const body = new TextEncoder().encode(version);
      const response = await signedFetch("PUT", objectUrl(pointerKey), body, await hashHex(body));

      await expectOk(response, "setCurrent", pointerKey);
    },

    getCurrent: async () => {
      const response = await signedFetch("GET", objectUrl(pointerKey));

      // No pointer object yet means no release is live — the pre-first-release
      // state, identical to the local store's missing `current` symlink.
      if (response.status === 404) return undefined;

      await expectOk(response, "getCurrent", pointerKey);

      return (await response.text()).trim();
    },

    listReleases: async () => {
      // List the immutable version "directories" under `releases/` with a
      // delimiter, so the store returns CommonPrefixes (one per version) rather
      // than every file. Strict-encode the query to match the signature.
      const url = new URL(endpoint);
      url.pathname = `/${encodeRfc3986(options.bucket)}`;
      url.search = `list-type=2&delimiter=%2F&prefix=${encodeRfc3986(RELEASES_PREFIX)}`;

      const response = await signedFetch("GET", url);

      await expectOk(response, "listReleases", RELEASES_PREFIX);

      return parseReleaseVersions(await response.text());
    },
  };
}

/**
 * Pull release version names out of an S3 `ListObjectsV2` XML response.
 *
 * With a `/` delimiter the store groups each version's files into one
 * `<CommonPrefixes><Prefix>releases/<version>/</Prefix></CommonPrefixes>`; we
 * strip the `releases/` head and the trailing `/` to recover the bare version.
 */
function parseReleaseVersions(xml: string): readonly string[] {
  const versions: string[] = [];
  const pattern = /<Prefix>([^<]*)<\/Prefix>/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    // Group 1 always participates when the pattern matches, so it is defined.
    const prefix = decodeXmlEntities(match[1]!);

    // A list response echoes the request `prefix` in its own top-level
    // `<Prefix>` element too; keep only the per-version CommonPrefixes, which
    // extend `releases/` with a version segment.
    if (prefix.length > RELEASES_PREFIX.length && prefix.startsWith(RELEASES_PREFIX)) {
      versions.push(prefix.slice(RELEASES_PREFIX.length).replace(/\/$/, ""));
    }
  }

  return versions;
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
