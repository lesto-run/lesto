/**
 * A directory watch that stays live for files created AFTER it started.
 *
 * Bun 1.3.5 on Linux reports a new file's creation (`rename`) and then NEVER reports a change
 * to that file again — under `fs.watch` both recursive and flat — while a file that existed when
 * the watch began keeps reporting. So in `lesto dev` a developer who added a component or helper
 * and then edited it got no reload at all: the page kept serving the first version and the
 * watcher stayed silent. macOS and Node do not have the gap and Bun 1.4 fixed it, but the
 * repository pins 1.3.5 and an app may run any Bun.
 *
 * A fresh watch DOES see every file that exists when it starts, so the fix is to re-arm: after a
 * `rename` (something was created, deleted or moved), close the watch and open a new one over the
 * same directory. Re-arming on every runtime keeps one code path; the cost is one re-watch per
 * created or deleted entry, small beside the re-load the same event triggers.
 */

/** The slice of `fs.FSWatcher` a re-arming watch uses. */
export interface WatchHandle {
  on(
    event: "change",
    listener: (eventType: string, filename: string | Buffer | null) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  close(): void;
}

/** `fs.watch`, narrowed to the call a re-arming watch makes. */
export type WatchFunction = (dir: string, options: { recursive: boolean }) => WatchHandle;

/** The file an event names, relative to the watched directory, or `null` when the platform gave none. */
export type WatchListener = (filename: string | null) => void;

const CREATED_DELETED_OR_MOVED = "rename";

/**
 * Watch `dir` and call `onEvent` for every reported change, re-arming after each `rename` so a
 * file created later keeps reporting. Returns a stop handle.
 *
 * The FIRST watch throws exactly as `fs.watch` does (a missing directory), so the caller decides
 * what an unwatchable root means. After that the watch never throws: one that errors (the
 * directory is deleted, the OS runs out of handles) or can no longer be re-armed closes and goes
 * quiet, because an unhandled `error` event would take the dev server down over a lost watch.
 */
export function watchRearming(
  watch: WatchFunction,
  dir: string,
  recursive: boolean,
  onEvent: WatchListener,
): () => void {
  let current: WatchHandle | undefined;

  const arm = (): void => {
    const handle = watch(dir, { recursive });

    handle.on("error", () => {
      handle.close();

      if (current === handle) current = undefined;
    });

    handle.on("change", (eventType, filename) => {
      if (current !== handle) return;

      if (eventType === CREATED_DELETED_OR_MOVED) rearm();

      onEvent(filename === null ? null : String(filename));
    });

    current = handle;
  };

  const stop = (): void => {
    current?.close();
    current = undefined;
  };

  const rearm = (): void => {
    stop();

    try {
      arm();
    } catch {
      // The directory is gone or cannot be watched any more: this root goes quiet.
    }
  };

  arm();

  return stop;
}
