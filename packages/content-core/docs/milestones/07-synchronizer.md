# Milestone 7: Synchronizer

## Objective
Implement incremental update handling for watch mode.

## Dependencies
- Milestone 6 (pipeline)

## Deliverables
- [ ] `synchronizer.ts` - Incremental state management
- [ ] Tests for synchronizer

## File to Create

### `packages/core/src/synchronizer.ts` (New File)

```typescript
import path from "node:path";
import picomatch from "picomatch";
import type { AnyCollection, Entry } from "./types";
import type { ResolvedConfig } from "./config";
import { parseOne } from "./parser";
import { transform } from "./transformer";

export interface SyncState {
  entries: Map<string, Entry>;
  pathToId: Map<string, string>;
  byCollection: Map<string, Entry[]>;
}

export interface SyncResult {
  type: "added" | "changed" | "deleted" | "skipped";
  entry?: Entry;
  path: string;
  collection: string;
}

interface CollectionMatcher {
  collection: AnyCollection;
  baseDir: string;
  isMatch: (path: string) => boolean;
}

/**
 * Create a synchronizer for incremental updates.
 */
export function createSynchronizer(config: ResolvedConfig) {
  const state: SyncState = {
    entries: new Map(),
    pathToId: new Map(),
    byCollection: new Map(),
  };

  // Build matchers
  const matchers: CollectionMatcher[] = config.collections.map((collection) => {
    const baseDir = path.isAbsolute(collection.directory)
      ? collection.directory
      : path.join(config.cwd, collection.directory);

    const include = Array.isArray(collection.include)
      ? collection.include
      : [collection.include ?? "**/*.md"];

    const exclude = Array.isArray(collection.exclude)
      ? collection.exclude
      : collection.exclude ? [collection.exclude] : [];

    return {
      collection,
      baseDir,
      isMatch: picomatch(include, { ignore: exclude }),
    };
  });

  function findCollection(absolutePath: string): CollectionMatcher | null {
    for (const matcher of matchers) {
      if (absolutePath.startsWith(matcher.baseDir + path.sep)) {
        const relativePath = path.relative(matcher.baseDir, absolutePath);
        if (matcher.isMatch(relativePath)) {
          return matcher;
        }
      }
    }
    return null;
  }

  function initialize(entries: Entry[], pathMap: Map<string, string>): void {
    state.entries.clear();
    state.pathToId.clear();
    state.byCollection.clear();

    for (const entry of entries) {
      state.entries.set(entry.id, entry);

      let collectionEntries = state.byCollection.get(entry.collection);
      if (!collectionEntries) {
        collectionEntries = [];
        state.byCollection.set(entry.collection, collectionEntries);
      }
      collectionEntries.push(entry);
    }

    for (const [filePath, entryId] of pathMap) {
      state.pathToId.set(filePath, entryId);
    }
  }

  function deleted(absolutePath: string): SyncResult | null {
    const matcher = findCollection(absolutePath);
    if (!matcher) return null;

    const entryId = state.pathToId.get(absolutePath);
    if (!entryId) {
      return { type: "skipped", path: absolutePath, collection: matcher.collection.name };
    }

    const entry = state.entries.get(entryId);
    state.entries.delete(entryId);
    state.pathToId.delete(absolutePath);

    const collectionEntries = state.byCollection.get(matcher.collection.name);
    if (collectionEntries) {
      const idx = collectionEntries.findIndex((e) => e.id === entryId);
      if (idx !== -1) collectionEntries.splice(idx, 1);
    }

    return { type: "deleted", entry, path: absolutePath, collection: matcher.collection.name };
  }

  async function changed(absolutePath: string): Promise<SyncResult | null> {
    const matcher = findCollection(absolutePath);
    if (!matcher) return null;

    const relativePath = path.relative(matcher.baseDir, absolutePath);

    try {
      // Parse
      const parsed = await parseOne({
        absolutePath,
        relativePath,
        collection: matcher.collection,
      });

      // Transform
      const result = await transform([parsed], config);

      if (result.entries.length === 0) {
        // Skipped
        const oldId = state.pathToId.get(absolutePath);
        if (oldId) {
          state.entries.delete(oldId);
          state.pathToId.delete(absolutePath);
        }
        return { type: "skipped", path: absolutePath, collection: matcher.collection.name };
      }

      const entry = result.entries[0];
      const existingId = state.pathToId.get(absolutePath);
      const isNew = !existingId;

      // Handle slug change
      if (existingId && existingId !== entry.id) {
        state.entries.delete(existingId);
        const oldEntries = state.byCollection.get(matcher.collection.name);
        if (oldEntries) {
          const idx = oldEntries.findIndex((e) => e.id === existingId);
          if (idx !== -1) oldEntries.splice(idx, 1);
        }
      }

      // Update state
      state.entries.set(entry.id, entry);
      state.pathToId.set(absolutePath, entry.id);

      let collectionEntries = state.byCollection.get(matcher.collection.name);
      if (!collectionEntries) {
        collectionEntries = [];
        state.byCollection.set(matcher.collection.name, collectionEntries);
      }

      const existingIdx = collectionEntries.findIndex((e) => e.id === entry.id);
      if (existingIdx !== -1) {
        collectionEntries[existingIdx] = entry;
      } else {
        collectionEntries.push(entry);
      }

      return {
        type: isNew ? "added" : "changed",
        entry,
        path: absolutePath,
        collection: matcher.collection.name,
      };
    } catch {
      return { type: "skipped", path: absolutePath, collection: matcher.collection.name };
    }
  }

  return {
    initialize,
    deleted,
    changed,
    getState: () => state,
    getEntries: () => Array.from(state.entries.values()),
    getCollection: (name: string) => state.byCollection.get(name) ?? [],
    getEntry: (collection: string, slug: string) => state.entries.get(`${collection}/${slug}`),
  };
}

export type Synchronizer = ReturnType<typeof createSynchronizer>;
```

## Tests

```typescript
// packages/core/src/__tests__/synchronizer.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createSynchronizer } from "../synchronizer";
import { z } from "zod";

describe("synchronizer", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "docks-test-"));
    await mkdir(path.join(tempDir, "content", "posts"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const createConfig = () => ({
    configPath: null,
    cwd: tempDir,
    collections: [{
      name: "posts",
      directory: "content/posts",
      schema: z.object({ title: z.string() }),
    }],
    mode: "development" as const,
  });

  const createFile = async (name: string, title: string) => {
    const filePath = path.join(tempDir, "content", "posts", `${name}.md`);
    await writeFile(filePath, `---\ntitle: "${title}"\n---\n\nContent`);
    return filePath;
  };

  describe("initialize", () => {
    it("populates state from entries", () => {
      const sync = createSynchronizer(createConfig());
      const entries = [
        { id: "posts/hello", slug: "hello", collection: "posts", data: {}, content: "", _meta: {} as any },
      ] as any;

      sync.initialize(entries, new Map([["/path/to/hello.md", "posts/hello"]]));

      expect(sync.getEntries()).toHaveLength(1);
      expect(sync.getCollection("posts")).toHaveLength(1);
    });
  });

  describe("changed", () => {
    it("adds new files", async () => {
      const sync = createSynchronizer(createConfig());
      sync.initialize([], new Map());

      const filePath = await createFile("new", "New Post");
      const result = await sync.changed(filePath);

      expect(result?.type).toBe("added");
      expect(result?.entry?.slug).toBe("new");
      expect(sync.getEntries()).toHaveLength(1);
    });

    it("updates existing files", async () => {
      const sync = createSynchronizer(createConfig());
      const filePath = await createFile("existing", "Original");

      // First add
      await sync.changed(filePath);

      // Update
      await writeFile(filePath, `---\ntitle: "Updated"\n---\n\nNew content`);
      const result = await sync.changed(filePath);

      expect(result?.type).toBe("changed");
      expect(result?.entry?.data.title).toBe("Updated");
      expect(sync.getEntries()).toHaveLength(1);
    });

    it("handles skipped documents", async () => {
      const config = createConfig();
      config.collections[0].transform = (_: any, ctx: any) => ctx.skip();

      const sync = createSynchronizer(config);
      const filePath = await createFile("skip", "Skip Me");
      const result = await sync.changed(filePath);

      expect(result?.type).toBe("skipped");
      expect(sync.getEntries()).toHaveLength(0);
    });
  });

  describe("deleted", () => {
    it("removes files from state", async () => {
      const sync = createSynchronizer(createConfig());
      const filePath = await createFile("delete", "Delete Me");

      await sync.changed(filePath);
      expect(sync.getEntries()).toHaveLength(1);

      const result = sync.deleted(filePath);

      expect(result?.type).toBe("deleted");
      expect(sync.getEntries()).toHaveLength(0);
    });
  });
});
```

## Acceptance Criteria

- [ ] Initializes state from entries
- [ ] Adds new files correctly
- [ ] Updates existing files
- [ ] Handles slug changes
- [ ] Removes deleted files
- [ ] Handles skipped documents
- [ ] Provides getCollection/getEntry accessors
- [ ] All tests pass

## Notes

- Add `picomatch` as dependency
- Synchronizer is used by engine for watch mode
