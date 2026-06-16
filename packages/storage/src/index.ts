/**
 * @keel/storage — object storage with a pluggable backend.
 *
 *   const storage = new Storage(new MemoryBackend());
 *   await storage.putText("greeting.txt", "hello");
 *   await storage.getText("greeting.txt"); // "hello"
 *
 *   const disk = new Storage(new FileBackend("/var/data"));
 *
 *   const cloud = new Storage(
 *     new S3Backend({
 *       endpoint: "https://s3.us-east-1.amazonaws.com",
 *       bucket: "my-bucket",
 *       region: "us-east-1",
 *       accessKeyId: "...",
 *       secretAccessKey: "...",
 *     }),
 *   );
 *   await storage.url("avatars/me.png", { expiresInSeconds: 300 }); // presigned
 *
 * ## Backend maturity
 *
 * - `S3Backend` is the production backend: it speaks the S3 REST API over
 *   `fetch` with AWS SigV4 (Web Crypto), so it works on AWS S3, Cloudflare R2,
 *   and MinIO, and runs unchanged on Cloudflare Workers.
 * - `MemoryBackend` and `FileBackend` are **local/dev only**. Memory holds bytes
 *   in a process `Map` (nothing survives a restart, nothing shares across
 *   instances). File maps keys to local disk (single-host, uses `node:fs`, no
 *   URLs). Neither is safe for a multi-instance or edge deployment — use
 *   `S3Backend` there.
 */

export { Storage } from "./storage";

export { MemoryBackend } from "./memory";
export { FileBackend } from "./file";
export { S3Backend } from "./s3";
export type { S3BackendOptions } from "./s3";

export { hashHex, presignUrl, signRequest, UNSIGNED_PAYLOAD } from "./sigv4";
export type { SigV4Credentials, SigV4Request } from "./sigv4";

export { KeelError, StorageError } from "./errors";
export type { StorageErrorCode } from "./errors";

export type { StorageBackend, UrlOptions } from "./types";
