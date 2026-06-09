import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nodeStaticReader, RuntimeError } from "../src/index";

describe("nodeStaticReader", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "keel-static-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads a prerendered file's contents", async () => {
    await mkdir(join(root, "marketing"), { recursive: true });
    await writeFile(join(root, "marketing", "index.html"), "<h1>Home</h1>", "utf8");

    const read = nodeStaticReader(root);

    expect(await read("marketing/index.html")).toBe("<h1>Home</h1>");
  });

  it("returns undefined for a missing file", async () => {
    const read = nodeStaticReader(root);

    expect(await read("marketing/nope.html")).toBeUndefined();
  });

  it("refuses a path that traverses outside the root", async () => {
    const read = nodeStaticReader(root);

    await expect(read("../../etc/passwd")).rejects.toMatchObject({
      code: "RUNTIME_STATIC_PATH_TRAVERSAL",
    });
  });

  it("does not let a sibling directory masquerade as being under the root", async () => {
    // `root` is `.../keel-static-XXXX`; `keel-static-XXXXevil` shares a prefix
    // but is not a child — the separator check must reject it.
    const read = nodeStaticReader(root);

    await expect(read("../evil/secret.html")).rejects.toBeInstanceOf(RuntimeError);
  });

  it("rethrows a non-missing filesystem error rather than swallowing it", async () => {
    // A directory in the file's place yields EISDIR, not ENOENT: a real fault
    // must surface, never collapse into a 404.
    await mkdir(join(root, "marketing", "about"), { recursive: true });

    const read = nodeStaticReader(root);

    await expect(read("marketing/about")).rejects.toMatchObject({ code: "EISDIR" });
  });
});
