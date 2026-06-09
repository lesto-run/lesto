import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Engine, installWorkflowSchema, WorkflowError } from "../src/index";

import type { Sleep, SqlDatabase } from "../src/index";

// A ~6-line better-sqlite3 adapter: array-positional params spread into the driver.
const adapt = (database: Database.Database): SqlDatabase => ({
  exec: (sql) => database.exec(sql),
  prepare: (sql) => {
    const stmt = database.prepare(sql);
    return {
      run: (params = []) => stmt.run(...params),
      get: (params = []) => stmt.get(...params),
    };
  },
});

let database: Database.Database;
let db: SqlDatabase;

beforeEach(() => {
  database = new Database(":memory:");
  db = adapt(database);
  installWorkflowSchema(db);
});

afterEach(() => {
  database.close();
});

describe("Engine", () => {
  it("runs every step once, persists results, and resumes without re-executing", async () => {
    let charges = 0;
    let receipts = 0;

    const engine = new Engine({ db }).define<{ amount: number }, { id: string; total: number }>(
      "checkout",
      async (input, ctx) => {
        const charge = await ctx.step("charge", () => {
          charges += 1;
          return { id: "ch_1", total: input.amount };
        });

        const receipt = await ctx.step("receipt", () => {
          receipts += 1;
          return { id: charge.id, total: charge.total };
        });

        return receipt;
      },
    );

    const first = await engine.run("checkout", "order-42", { amount: 99 });

    // Both step fns ran exactly once, and the object round-tripped through JSON.
    expect(first).toEqual({ id: "ch_1", total: 99 });
    expect(charges).toBe(1);
    expect(receipts).toBe(1);

    // Re-running the SAME run id replays persisted results: no fn re-executes.
    const second = await engine.run("checkout", "order-42", { amount: 99 });

    expect(second).toEqual({ id: "ch_1", total: 99 });
    expect(charges).toBe(1);
    expect(receipts).toBe(1);
  });

  it("persists a void step so it is not re-executed on resume", async () => {
    let sends = 0;

    const engine = new Engine({ db }).define<void, void>("notify", async (_input, ctx) => {
      // A void step: returns undefined. JSON.stringify(undefined) is undefined,
      // which would never persist — so a naive engine re-runs this on resume.
      await ctx.step("send-email", () => {
        sends += 1;
      });
    });

    await engine.run("notify", "run-1", undefined);
    expect(sends).toBe(1);

    // The completed void step persisted a durable row whose result is JSON null.
    const row = database
      .prepare("SELECT result FROM keel_workflow_steps WHERE run_id = ? AND step_key = ?")
      .get("run-1", "send-email") as { result: string } | undefined;

    expect(row).toEqual({ result: "null" });

    // Resume: the void step replays from the row instead of re-running its fn.
    await engine.run("notify", "run-1", undefined);
    expect(sends).toBe(1);
  });

  it("awaits the injected sleep", async () => {
    const sleep = vi.fn<Sleep>(async () => {});

    const engine = new Engine({ db, sleep }).define<void, void>("nap", async (_input, ctx) => {
      await ctx.sleep(500);
    });

    await engine.run("nap", "run-1", undefined);

    expect(sleep).toHaveBeenCalledWith(500);
  });

  it("uses the default real-timer sleep when none is injected", async () => {
    const engine = new Engine({ db }).define<void, void>("nap", async (_input, ctx) => {
      // Tiny ms; honor the macrotask-yield rule so vitest never hangs.
      await ctx.sleep(1);
    });

    await engine.run("nap", "run-1", undefined);

    // Reaching here proves the default setTimeout-backed sleep resolved.
    expect(true).toBe(true);
  });

  it("throws WORKFLOW_UNKNOWN for an unregistered name", async () => {
    const engine = new Engine({ db });

    await expect(engine.run("ghost", "run-1", undefined)).rejects.toMatchObject({
      code: "WORKFLOW_UNKNOWN",
    });

    await expect(engine.run("ghost", "run-1", undefined)).rejects.toBeInstanceOf(WorkflowError);
  });
});
