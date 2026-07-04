import { afterEach, describe, expect, it, vi } from "vitest";

import type { App } from "@lesto/kernel";

import {
  onShutdownSignals,
  realSignalDeps,
  serveWithGracefulShutdown,
} from "../src/graceful-shutdown";
import type { ServeShutdownDeps } from "../src/graceful-shutdown";
import type { Server } from "../src/server";

/** Let all pending microtasks (the teardown `.then` chain) drain before we assert. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A stable no-op callback reference — asserted on by identity in the seam tests. */
const noop = (): void => {};

/** A trivial app: enough to stand a real socket up for the default-deps path. */
const trivialApp: App = {
  migrationsApplied: [],
  handle: async () => ({ status: 200, headers: {}, body: "ok" }),
};

/**
 * A fake process/timer/server rig so every branch is driven without a real
 * signal, a real exit, or a real socket. Each captured piece is asserted on.
 */
function harness(config?: {
  readonly closeResult?: () => Promise<void>;
  readonly serveResult?: Server;
}) {
  const events: string[] = [];
  const exits: number[] = [];
  const errors: Array<{ message: string; error?: unknown }> = [];
  const handlers = new Map<string, () => void>();

  const state: { forceExitCb?: () => void; forceExitMs?: number; closeCalls: number } = {
    closeCalls: 0,
  };

  const server: Server = config?.serveResult ?? {
    port: 4321,
    close: () => {
      state.closeCalls += 1;
      events.push("close");

      return config?.closeResult?.() ?? Promise.resolve();
    },
  };

  const deps: ServeShutdownDeps = {
    serve: async () => {
      events.push("serve");

      return server;
    },
    on: (signal, handler) => {
      handlers.set(signal, handler);
    },
    exit: (code) => {
      exits.push(code);
    },
    setForceExitTimer: (callback, ms) => {
      state.forceExitCb = callback;
      state.forceExitMs = ms;
    },
    logError: (message, error) => {
      errors.push({ message, error });
    },
  };

  return {
    deps,
    server,
    events,
    exits,
    errors,
    state,
    fire: (signal: "SIGINT" | "SIGTERM"): void => handlers.get(signal)?.(),
    fireForceExit: (): void => state.forceExitCb?.(),
    signalCount: (): number => handlers.size,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("onShutdownSignals", () => {
  it("registers SIGINT + SIGTERM and runs teardown once, exiting 0", async () => {
    const h = harness();
    const order: string[] = [];

    onShutdownSignals(
      async () => {
        order.push("teardown");
      },
      {},
      h.deps,
    );

    expect(h.signalCount()).toBe(2); // both signals wired

    h.fire("SIGINT");
    await tick();

    expect(order).toEqual(["teardown"]);
    expect(h.exits).toEqual([0]);
  });

  it("guards a double signal: a second signal while tearing down is a no-op", async () => {
    let teardownRuns = 0;

    // A slow teardown so the second signal lands mid-flight, before the first resolves.
    const h = harness({ closeResult: () => new Promise<void>(() => {}) });

    onShutdownSignals(
      async () => {
        teardownRuns += 1;

        await new Promise<void>(() => {}); // never settles — hold teardown open
      },
      {},
      h.deps,
    );

    h.fire("SIGINT");
    h.fire("SIGTERM"); // re-entry attempt
    await tick();

    expect(teardownRuns).toBe(1); // the guard held — only one run
    expect(h.exits).toEqual([]); // teardown still in flight, no exit yet
  });

  it("does not arm a force-exit timer when no timeout is given (the CLI's shape)", async () => {
    const h = harness();

    onShutdownSignals(async () => {}, {}, h.deps);

    h.fire("SIGINT");
    await tick();

    expect(h.state.forceExitCb).toBeUndefined(); // never scheduled
    expect(h.exits).toEqual([0]);
  });

  it("arms a force-exit timer and force-exits 1 when teardown wedges past it", async () => {
    // Teardown that never settles: the only way out is the force-exit backstop.
    const h = harness({ closeResult: () => new Promise<void>(() => {}) });

    onShutdownSignals(() => new Promise<void>(() => {}), { forceExitTimeoutMs: 250 }, h.deps);

    h.fire("SIGINT");
    await tick();

    expect(h.state.forceExitMs).toBe(250); // armed with the given deadline
    expect(h.exits).toEqual([]); // nothing resolved yet

    h.fireForceExit(); // the deadline fires

    expect(h.errors).toEqual([{ message: "graceful shutdown exceeded 250ms — forcing exit" }]);
    expect(h.exits).toEqual([1]);
  });

  it("logs and exits 1 when teardown rejects (never an unhandled rejection)", async () => {
    const h = harness();
    const boom = new Error("close threw");

    onShutdownSignals(() => Promise.reject(boom), { forceExitTimeoutMs: 100 }, h.deps);

    h.fire("SIGTERM");
    await tick();

    expect(h.errors).toEqual([{ message: "graceful shutdown failed", error: boom }]);
    expect(h.exits).toEqual([1]);
  });

  it("defaults to the real process seams when none are injected", async () => {
    const registered = new Map<string, () => void>();

    const onSpy = vi
      .spyOn(process, "on")
      .mockImplementation((signal: string | symbol, handler: (...args: never[]) => void) => {
        registered.set(String(signal), handler as () => void);

        return process;
      });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    let ran = false;

    onShutdownSignals(async () => {
      ran = true;
    });

    expect(onSpy).toHaveBeenCalledTimes(2); // real process.on wired both signals

    registered.get("SIGINT")?.();
    await tick();

    expect(ran).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(0); // real process.exit reached
  });
});

describe("serveWithGracefulShutdown", () => {
  it("boots the server, defaults the host to loopback, and returns it listening", async () => {
    const h = harness();
    let boundHost: string | undefined;

    const deps: ServeShutdownDeps = {
      ...h.deps,
      serve: async (_app, options) => {
        boundHost = options.host;

        return h.server;
      },
    };

    const server = await serveWithGracefulShutdown(trivialApp, { port: 3000 }, deps);

    expect(boundHost).toBe("127.0.0.1"); // loopback by default
    expect(server.port).toBe(4321);
    expect(h.signalCount()).toBe(2); // handlers installed before returning
  });

  it("passes an overridden host straight through (the container case)", async () => {
    const h = harness();
    let boundHost: string | undefined;

    const deps: ServeShutdownDeps = {
      ...h.deps,
      serve: async (_app, options) => {
        boundHost = options.host;

        return h.server;
      },
    };

    await serveWithGracefulShutdown(trivialApp, { port: 3000, host: "0.0.0.0" }, deps);

    expect(boundHost).toBe("0.0.0.0");
  });

  it("runs teardown in order on a signal: onShutdown → drain → onClosed → exit 0", async () => {
    const h = harness();
    const order: string[] = [];

    await serveWithGracefulShutdown(
      trivialApp,
      {
        port: 3000,
        onShutdown: () => {
          order.push("onShutdown");
        },
        onClosed: () => {
          order.push("onClosed");
        },
      },
      h.deps,
    );

    h.fire("SIGINT");
    await tick();

    // "serve" is pushed at boot; the signal drives the rest in the contract order.
    expect(order).toEqual(["onShutdown", "onClosed"]);
    expect(h.events).toEqual(["serve", "close"]); // drain sits between the two hooks
    expect(h.exits).toEqual([0]);
  });

  it("skips the optional hooks cleanly when neither is given", async () => {
    const h = harness();

    await serveWithGracefulShutdown(trivialApp, { port: 3000 }, h.deps);

    h.fire("SIGTERM");
    await tick();

    expect(h.events).toEqual(["serve", "close"]); // just the drain, no hooks
    expect(h.exits).toEqual([0]);
  });

  it("sizes the force-exit deadline off the effective drainTimeoutMs by default", async () => {
    const h = harness();

    // No drainTimeoutMs, no forceExitTimeoutMs → default drain (10s) + 5s grace.
    await serveWithGracefulShutdown(trivialApp, { port: 3000 }, h.deps);

    h.fire("SIGINT");
    await tick();

    expect(h.state.forceExitMs).toBe(15_000);
  });

  it("derives the force-exit deadline from a custom drainTimeoutMs", async () => {
    const h = harness();

    await serveWithGracefulShutdown(trivialApp, { port: 3000, drainTimeoutMs: 30_000 }, h.deps);

    h.fire("SIGINT");
    await tick();

    expect(h.state.forceExitMs).toBe(35_000); // 30s drain + 5s grace
  });

  it("honours an explicit forceExitTimeoutMs over the derived default", async () => {
    const h = harness();

    await serveWithGracefulShutdown(
      trivialApp,
      { port: 3000, drainTimeoutMs: 30_000, forceExitTimeoutMs: 2_000 },
      h.deps,
    );

    h.fire("SIGINT");
    await tick();

    expect(h.state.forceExitMs).toBe(2_000); // explicit wins
  });

  it("wires the real serve + process seams when none are injected", async () => {
    vi.spyOn(process, "on").mockImplementation(() => process);
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    // Defaults for BOTH options and deps: a real ephemeral-port socket, real signal wiring.
    const server = await serveWithGracefulShutdown(trivialApp);

    expect(server.port).toBeGreaterThan(0);

    await server.close(); // tear the real socket down
  });
});

describe("realSignalDeps", () => {
  it("logs a bare message when no error is attached", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    realSignalDeps.logError("just a message");

    expect(errSpy).toHaveBeenCalledWith("just a message");
  });

  it("logs the message and the error when one is attached", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("boom");

    realSignalDeps.logError("with context", boom);

    expect(errSpy).toHaveBeenCalledWith("with context", boom);
  });

  it("schedules an unref'd force-exit timer", () => {
    const unref = vi.fn();
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue({ unref } as unknown as ReturnType<typeof setTimeout>);

    realSignalDeps.setForceExitTimer(noop, 500);

    expect(setTimeoutSpy).toHaveBeenCalledWith(noop, 500);
    expect(unref).toHaveBeenCalledTimes(1); // never keeps the process alive on its own
  });

  it("exposes an exit seam over process.exit", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    realSignalDeps.exit(3);

    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it("exposes an on seam over process.on", () => {
    const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);

    realSignalDeps.on("SIGINT", noop);

    expect(onSpy).toHaveBeenCalledWith("SIGINT", noop);
  });
});
