---
title: "Object storage"
description: "Put files behind one small API with pluggable backends — in-memory and local disk for dev, S3/R2 in production — built on a single StorageBackend interface and an SDK-free AWS SigV4 signer that runs unchanged on Cloudflare Workers."
section: Batteries
order: 15
---

# Object storage

`@lesto/storage` puts files behind one small API. You construct a `Storage`
facade over a backend, then call `put`/`get`/`delete`/`exists`/`list`/`url`
against it — and the bytes live wherever the backend says: a process `Map`, the
local disk, or an S3-compatible bucket. The facade depends on a `StorageBackend`
interface alone, so swapping `MemoryBackend` for `S3Backend` is a one-line
change at the construction site and nothing downstream knows the difference.

The one idea: the storage substrate is an interface, not a driver. Dev runs on
memory or disk; production runs on S3 or Cloudflare R2 — the same calls, the
same code path.

## The facade and a backend

`Storage` takes a backend in its constructor and delegates the raw byte
operations to it. The text helpers (`putText`/`getText`) sit on top, encoding
and decoding utf8 for you:

```ts
import { Storage, MemoryBackend } from "@lesto/storage";

const storage = new Storage(new MemoryBackend());

await storage.putText("greeting.txt", "hello");
await storage.getText("greeting.txt"); // "hello"

await storage.put("logo.png", pngBytes); // Buffer in, Buffer out
const bytes = await storage.get("logo.png");

await storage.exists("logo.png"); // true
await storage.list("avatars/"); // string[] of keys under the prefix
await storage.delete("logo.png"); // no-op if already gone
```

`get` throws `STORAGE_NOT_FOUND` when the key is absent; `delete` is idempotent
(deleting a missing key is a no-op). `list(prefix?)` returns every key, narrowed
to those starting with `prefix` when you pass one.

## Dev backends: memory and file

Two backends exist for local work and tests. Both are **dev-only** — neither is
safe for a multi-instance or edge deployment, and neither can mint a URL.

```ts
import { Storage, MemoryBackend, FileBackend } from "@lesto/storage";

// Bytes in a process Map. Nothing survives a restart, nothing is shared.
const ephemeral = new Storage(new MemoryBackend());

// Keys mapped to files under one root directory (uses node:fs).
const disk = new Storage(new FileBackend("/var/data"));
```

`FileBackend` creates parent directories on `put`, and its keys are
root-relative, forward-slashed paths regardless of OS. It refuses any key
containing `..` or starting with `/` (path-traversal guard), throwing
`STORAGE_INVALID_KEY`. `S3Backend` applies the same guard, so an unsafe key
fails the same way on every backend.

## Production: S3 and R2

`S3Backend` is the production backend. It speaks the S3 REST API directly over
`fetch`, signing each request with AWS Signature Version 4 via Web Crypto — no
AWS SDK and no `node:crypto`, so it runs unchanged on Cloudflare Workers as well
as Node. The same backend serves AWS S3, Cloudflare R2, and MinIO; it's
endpoint-first, so you point it at the host and name the bucket:

```ts
import { Storage, S3Backend } from "@lesto/storage";

const storage = new Storage(
  new S3Backend({
    endpoint: "https://s3.us-east-1.amazonaws.com",
    bucket: "my-bucket",
    region: "us-east-1",
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  }),
);
```

For Cloudflare R2 the only change is the endpoint and region:

```ts
new S3Backend({
  endpoint: "https://<account>.r2.cloudflarestorage.com",
  bucket: "my-bucket",
  region: "auto",
  accessKeyId: process.env.R2_ACCESS_KEY_ID!,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  publicBaseUrl: "https://cdn.example.com", // optional CDN/public domain
});
```

`S3BackendOptions` also accepts a `sessionToken` (for STS temporary
credentials), a `fetch` override (to inject a Workers binding's fetcher or a
test double), and a `now` override (for deterministic signing in tests). Reach
for [`@lesto/env`](/batteries/env) to validate the credentials at boot rather
than reading `process.env` raw.

## URLs

`storage.url(key)` returns a URL that resolves to the object. With
`{ expiresInSeconds }` it's a time-limited presigned URL; without it, a public
URL that only resolves if the object is publicly readable:

```ts
// Time-limited presigned link, good for 5 minutes.
const link = await storage.url("avatars/me.png", { expiresInSeconds: 300 });

// Public URL — uses publicBaseUrl when configured, else the path-style URL.
const pub = await storage.url("avatars/me.png");
```

Only object-store backends implement `url()`. On `MemoryBackend` and
`FileBackend` the facade throws `STORAGE_URL_UNSUPPORTED` — bytes that live only
in a process or behind the local disk have no addressable URL.

## Errors

Every failure is a `StorageError` carrying a stable `StorageErrorCode`, so logs,
tests, and API responses branch on the code rather than a message string:

```ts
import { Storage, MemoryBackend, StorageError } from "@lesto/storage";
import type { StorageErrorCode } from "@lesto/storage";

const storage = new Storage(new MemoryBackend());

try {
  await storage.get("missing.txt");
} catch (err) {
  if (err instanceof StorageError && err.code === "STORAGE_NOT_FOUND") {
    // handle the absent object
  }
}
```

The codes are `STORAGE_NOT_FOUND`, `STORAGE_INVALID_KEY`,
`STORAGE_BACKEND_ERROR`, and `STORAGE_URL_UNSUPPORTED`. `StorageError` extends
the shared `LestoError`, the same base every Lesto battery raises — see
[Validation & errors](/guides/validation).

## The SigV4 signer

The AWS SigV4 implementation is exported on its own — `signRequest`,
`presignUrl`, `hashHex`, `encodeRfc3986`, and the `UNSIGNED_PAYLOAD` sentinel,
plus the `SigV4Credentials` and `SigV4Request` types. It depends on nothing in
storage and uses only `crypto.subtle` and `fetch`-native types, so you can sign
requests to any S3-compatible service directly:

```ts
import { signRequest, hashHex } from "@lesto/storage";

const headers = await signRequest(
  {
    method: "GET",
    url: new URL("https://s3.us-east-1.amazonaws.com/my-bucket/key"),
    headers: {},
    payloadHash: await hashHex(""),
  },
  { accessKeyId, secretAccessKey, region: "us-east-1", service: "s3" },
  new Date(),
);
```

## Notes and gotchas

- **Memory and file are dev-only.** `MemoryBackend` loses everything on restart
  and shares nothing across instances; `FileBackend` is single-host and uses
  `node:fs`, so it can't run on an edge runtime. Use `S3Backend` for any
  multi-instance or Cloudflare deployment.
- **`url()` is backend-dependent.** Only `S3Backend` mints URLs. Calling
  `storage.url(...)` on a memory or file backend throws
  `STORAGE_URL_UNSUPPORTED` — design around it, don't assume every backend can
  produce a link.
- **Keys are guarded, not arbitrary paths.** A key with `..` or a leading `/` is
  rejected with `STORAGE_INVALID_KEY` on both `FileBackend` and `S3Backend`. Keep
  keys as plain relative paths.
- **Public URLs aren't automatically public.** A non-presigned `url()` returns a
  link that only resolves if the bucket/object is actually publicly readable, or
  if you've fronted it with a `publicBaseUrl` CDN. For private objects, presign
  with `{ expiresInSeconds }`.
- **`delete` and missing keys never throw.** Deleting an absent key is a no-op
  across every backend (S3 treats a `404` the same as a `204`); only `get`
  surfaces absence, as `STORAGE_NOT_FOUND`.
- **No streaming yet.** `put`/`get` move whole `Buffer`s, so the object is held
  in memory. There's no streaming or multipart-upload surface in this package
  today — mind large files.

For where storage fits in the larger picture, see [Concepts](/concepts) and the
[Quickstart](/quickstart). Related batteries: [Background jobs](/batteries/queue)
for processing uploaded files, and [Typed env](/batteries/env) for loading
credentials safely.
