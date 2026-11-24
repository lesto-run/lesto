import { describe, expect, it } from "vitest";

import { watchRearming } from "../src/rearming-watch";
import type { WatchFunction, WatchHandle } from "../src/rearming-watch";

/**
 * The re-arming watch behind `lesto dev`'s reload triggers. Bun 1.3.5 on Linux stops reporting
 * a file created after the watch began, so every `rename` must swap in a fresh watch. The real
 * runtime gap is proven end to end by `packages/e2e/page-swap-bun.spec.ts` on CI's Linux runner;
 * what is pinned here is the re-arm itself, against a scripted `fs.watch`.
 */

type ChangeListener = (eventType: string, filename: string | Buffer | null) => void;

interface FakeHandle extends WatchHandle {
  readonly closed: boolean;
  emitChange(eventType: string, filename: string | Buffer | null): void;
  emitError(): void;
}

function fakeHandle(): FakeHandle {
  const changes: ChangeListener[] = [];
  const errors: ((error: Error) => void)[] = [];
  let closed = false;

  return {
    get closed() {
      return closed;
    },

    on(event: "change" | "error", listener: ChangeListener | ((error: Error) => void)) {
      if (event === "change") changes.push(listener as ChangeListener);
      else errors.push(listener as (error: Error) => void);

      return this;
    },

    close() {
      closed = true;
    },

    emitChange(eventType, filename) {
      for (const listener of changes) listener(eventType, filename);
    },

    emitError() {
      for (const listener of errors) listener(new Error("watch lost"));
    },
  };
}

/** A scripted `fs.watch`: each call hands out the next fake, or throws when `failFrom` is reached. */
function fakeWatch(failFrom = Number.POSITIVE_INFINITY): {
  watch: WatchFunction;
  handles: FakeHandle[];
  calls: { dir: string; recursive: boolean }[];
} {
  const handles: FakeHandle[] = [];
  const calls: { dir: string; recursive: boolean }[] = [];

  return {
    handles,
    calls,
    watch: (dir, options) => {
      calls.push({ dir, recursive: options.recursive });

      if (calls.length >= failFrom) throw new Error("ENOENT");

      const handle = fakeHandle();
      handles.push(handle);

      return handle;
    },
  };
}

describe("watchRearming", () => {
  it("reports each change with its filename, as a string", () => {
    const { watch, handles, calls } = fakeWatch();
    const seen: (string | null)[] = [];

    watchRearming(watch, "/app", true, (filename) => seen.push(filename));

    handles[0]?.emitChange("change", "routes/page.tsx");
    handles[0]?.emitChange("change", Buffer.from("greeting.ts"));
    handles[0]?.emitChange("change", null);

    expect(seen).toEqual(["routes/page.tsx", "greeting.ts", null]);
    expect(calls).toEqual([{ dir: "/app", recursive: true }]);
  });

  it("re-arms after a rename, so a file created later keeps reporting", () => {
    const { watch, handles, calls } = fakeWatch();
    const seen: (string | null)[] = [];

    watchRearming(watch, "/app", false, (filename) => seen.push(filename));

    handles[0]?.emitChange("rename", "greeting.ts");

    expect(handles[0]?.closed).toBe(true);
    expect(handles).toHaveLength(2);
    expect(calls[1]).toEqual({ dir: "/app", recursive: false });

    handles[1]?.emitChange("change", "greeting.ts");

    expect(seen).toEqual(["greeting.ts", "greeting.ts"]);
  });

  it("ignores a late event from a watch it already replaced", () => {
    const { watch, handles } = fakeWatch();
    const seen: (string | null)[] = [];

    watchRearming(watch, "/app", true, (filename) => seen.push(filename));

    handles[0]?.emitChange("rename", "greeting.ts");
    handles[0]?.emitChange("change", "stale.ts");

    expect(seen).toEqual(["greeting.ts"]);
    expect(handles).toHaveLength(2);
  });

  it("throws when the first watch cannot start, so the caller decides what a missing root means", () => {
    const { watch } = fakeWatch(1);

    expect(() => watchRearming(watch, "/missing", true, () => undefined)).toThrow("ENOENT");
  });

  it("goes quiet, without throwing, when a re-arm cannot start", () => {
    const { watch, handles } = fakeWatch(2);
    const seen: (string | null)[] = [];

    const stop = watchRearming(watch, "/app", true, (filename) => seen.push(filename));

    expect(() => handles[0]?.emitChange("rename", "app")).not.toThrow();
    expect(handles[0]?.closed).toBe(true);
    expect(seen).toEqual(["app"]);

    expect(() => stop()).not.toThrow();
  });

  it("closes on a watch error and stops reporting", () => {
    const { watch, handles } = fakeWatch();
    const seen: (string | null)[] = [];

    watchRearming(watch, "/app", true, (filename) => seen.push(filename));

    handles[0]?.emitError();
    handles[0]?.emitChange("change", "after-error.ts");

    expect(handles[0]?.closed).toBe(true);
    expect(seen).toEqual([]);
  });

  it("closes an error from a replaced watch without touching the live one", () => {
    const { watch, handles } = fakeWatch();
    const seen: (string | null)[] = [];

    watchRearming(watch, "/app", true, (filename) => seen.push(filename));

    handles[0]?.emitChange("rename", "greeting.ts");
    handles[0]?.emitError();
    handles[1]?.emitChange("change", "greeting.ts");

    expect(handles[1]?.closed).toBe(false);
    expect(seen).toEqual(["greeting.ts", "greeting.ts"]);
  });

  it("stop closes the live watch and silences it", () => {
    const { watch, handles } = fakeWatch();
    const seen: (string | null)[] = [];

    const stop = watchRearming(watch, "/app", true, (filename) => seen.push(filename));

    handles[0]?.emitChange("rename", "greeting.ts");
    stop();
    handles[1]?.emitChange("change", "greeting.ts");

    expect(handles[1]?.closed).toBe(true);
    expect(seen).toEqual(["greeting.ts"]);
  });
});
