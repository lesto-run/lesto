/**
 * @keel/storage — object storage with a pluggable backend.
 *
 *   const storage = new Storage(new MemoryBackend());
 *   await storage.putText("greeting.txt", "hello");
 *   await storage.getText("greeting.txt"); // "hello"
 *
 *   const disk = new Storage(new FileBackend("/var/data"));
 *
 * The S3 adapter is a future backend behind the same `StorageBackend` contract.
 */

export { Storage } from "./storage";

export { MemoryBackend } from "./memory";
export { FileBackend } from "./file";

export { KeelError, StorageError } from "./errors";
export type { StorageErrorCode } from "./errors";

export type { StorageBackend } from "./types";
