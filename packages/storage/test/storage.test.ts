import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileBackend, MemoryBackend, Storage, StorageError } from "../src/index";

describe("MemoryBackend", () => {
  it("round-trips put and get", async () => {
    const backend = new MemoryBackend();
    const bytes = Buffer.from("hello");

    await backend.put("a.txt", bytes);

    expect(await backend.get("a.txt")).toEqual(bytes);
  });

  it("throws STORAGE_NOT_FOUND on a missing key", async () => {
    const backend = new MemoryBackend();

    try {
      await backend.get("missing");
      expect.unreachable("get of a missing key should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(StorageError);
      expect((error as StorageError).code).toBe("STORAGE_NOT_FOUND");
    }
  });

  it("reports existence both ways", async () => {
    const backend = new MemoryBackend();

    await backend.put("here", Buffer.from("x"));

    expect(await backend.exists("here")).toBe(true);
    expect(await backend.exists("gone")).toBe(false);
  });

  it("deletes a key", async () => {
    const backend = new MemoryBackend();

    await backend.put("doomed", Buffer.from("x"));
    await backend.delete("doomed");

    expect(await backend.exists("doomed")).toBe(false);
  });

  it("lists keys with and without a prefix", async () => {
    const backend = new MemoryBackend();

    await backend.put("img/a.png", Buffer.from("a"));
    await backend.put("img/b.png", Buffer.from("b"));
    await backend.put("doc/c.txt", Buffer.from("c"));

    expect((await backend.list()).toSorted()).toEqual(["doc/c.txt", "img/a.png", "img/b.png"]);
    expect((await backend.list("img/")).toSorted()).toEqual(["img/a.png", "img/b.png"]);
  });
});

describe("FileBackend", () => {
  let root: string;

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const makeBackend = async (): Promise<FileBackend> => {
    root = await mkdtemp(join(tmpdir(), "lesto-storage-"));
    return new FileBackend(root);
  };

  it("round-trips put and get, creating directories", async () => {
    const backend = await makeBackend();
    const bytes = Buffer.from("hello disk");

    await backend.put("nested/deep/a.txt", bytes);

    expect(await backend.get("nested/deep/a.txt")).toEqual(bytes);
  });

  it("reports existence both ways", async () => {
    const backend = await makeBackend();

    await backend.put("here.txt", Buffer.from("x"));

    expect(await backend.exists("here.txt")).toBe(true);
    expect(await backend.exists("gone.txt")).toBe(false);
  });

  it("deletes a key, and delete of an absent key is a no-op", async () => {
    const backend = await makeBackend();

    await backend.put("doomed.txt", Buffer.from("x"));
    await backend.delete("doomed.txt");

    expect(await backend.exists("doomed.txt")).toBe(false);

    // Deleting again must not throw.
    await backend.delete("doomed.txt");
  });

  it("lists an empty list when the root directory does not yet exist", async () => {
    root = join(tmpdir(), "lesto-storage-absent-do-not-create");
    const backend = new FileBackend(root);

    expect(await backend.list()).toEqual([]);
  });

  it("lists keys with and without a prefix", async () => {
    const backend = await makeBackend();

    await backend.put("img/a.png", Buffer.from("a"));
    await backend.put("img/b.png", Buffer.from("b"));
    await backend.put("doc/c.txt", Buffer.from("c"));

    expect((await backend.list()).toSorted()).toEqual(["doc/c.txt", "img/a.png", "img/b.png"]);
    expect((await backend.list("img/")).toSorted()).toEqual(["img/a.png", "img/b.png"]);
  });

  it("throws STORAGE_NOT_FOUND on a missing file", async () => {
    const backend = await makeBackend();

    try {
      await backend.get("missing.txt");
      expect.unreachable("get of a missing file should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(StorageError);
      expect((error as StorageError).code).toBe("STORAGE_NOT_FOUND");
    }
  });

  it("rejects a parent-traversal key with STORAGE_INVALID_KEY", async () => {
    const backend = await makeBackend();

    try {
      await backend.put("../escape", Buffer.from("x"));
      expect.unreachable("a traversal key should be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(StorageError);
      expect((error as StorageError).code).toBe("STORAGE_INVALID_KEY");
    }
  });

  it("rejects a leading-slash key with STORAGE_INVALID_KEY", async () => {
    const backend = await makeBackend();

    try {
      await backend.get("/etc/passwd");
      expect.unreachable("an absolute key should be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(StorageError);
      expect((error as StorageError).code).toBe("STORAGE_INVALID_KEY");
    }
  });
});

describe("Storage", () => {
  it("round-trips text through a backend", async () => {
    const storage = new Storage(new MemoryBackend());

    await storage.putText("note.txt", "héllo");

    expect(await storage.getText("note.txt")).toBe("héllo");
  });

  it("delegates the byte operations to the backend", async () => {
    const storage = new Storage(new MemoryBackend());
    const bytes = Buffer.from("raw");

    await storage.put("a", bytes);

    expect(await storage.exists("a")).toBe(true);
    expect(await storage.get("a")).toEqual(bytes);
    expect(await storage.list()).toEqual(["a"]);

    await storage.delete("a");

    expect(await storage.exists("a")).toBe(false);
  });
});
