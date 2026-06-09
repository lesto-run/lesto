import { describe, expect, it } from "vitest";

import { Hooks } from "../src/index";

import type { ActionListener, FilterListener } from "../src/index";

// Hoisted because they capture nothing; defining them per-test trips
// unicorn/consistent-function-scoping and re-creates them needlessly.
const noopAction: ActionListener = () => {};

const identityFilter: FilterListener = (value) => value;

const shout: FilterListener = (value) => String(value).toUpperCase();

const bang: FilterListener = (value) => `${String(value)}!`;

describe("Hooks — actions", () => {
  it("runs listeners in ascending priority order, then insertion order on ties", async () => {
    const hooks = new Hooks();

    const order: string[] = [];

    // Registered out of priority order; a priority-5 listener must run before the default-10.
    hooks.addAction("boot", () => void order.push("default"));
    hooks.addAction("boot", () => void order.push("early"), 5);

    // Two at the same priority preserve insertion order.
    hooks.addAction("boot", () => void order.push("tie-a"), 5);
    hooks.addAction("boot", () => void order.push("tie-b"), 5);

    await hooks.doAction("boot");

    expect(order).toEqual(["early", "tie-a", "tie-b", "default"]);
  });

  it("awaits async action listeners before moving on", async () => {
    const hooks = new Hooks();

    const order: string[] = [];

    hooks.addAction("boot", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));

      order.push("slow");
    });

    hooks.addAction("boot", () => void order.push("fast"));

    await hooks.doAction("boot");

    expect(order).toEqual(["slow", "fast"]);
  });

  it("doAction with no registered listeners is a no-op", async () => {
    const hooks = new Hooks();

    await expect(hooks.doAction("nobody_listening")).resolves.toBeUndefined();
  });

  it("passes extra args through to action listeners", async () => {
    const hooks = new Hooks();

    let seen: unknown[] = [];

    hooks.addAction("greet", (...args) => void (seen = args));

    await hooks.doAction("greet", "ada", 42);

    expect(seen).toEqual(["ada", 42]);
  });

  it("removeAction prevents the listener from being called", async () => {
    const hooks = new Hooks();

    let calls = 0;
    const listener: ActionListener = () => void (calls += 1);

    hooks.addAction("boot", listener);
    hooks.removeAction("boot", listener);

    await hooks.doAction("boot");

    expect(calls).toBe(0);
  });

  it("removeAction keeps other listeners when more than one is registered", async () => {
    const hooks = new Hooks();

    const order: string[] = [];
    const doomed: ActionListener = () => void order.push("doomed");
    const survivor: ActionListener = () => void order.push("survivor");

    hooks.addAction("boot", doomed);
    hooks.addAction("boot", survivor);
    hooks.removeAction("boot", doomed);

    await hooks.doAction("boot");

    expect(order).toEqual(["survivor"]);
    expect(hooks.hasAction("boot")).toBe(true);
  });

  it("removeAction on an unknown name is a no-op", () => {
    const hooks = new Hooks();

    expect(hooks.removeAction("ghost", () => {})).toBe(hooks);
    expect(hooks.hasAction("ghost")).toBe(false);
  });

  it("hasAction reflects registration state", () => {
    const hooks = new Hooks();

    expect(hooks.hasAction("boot")).toBe(false);

    hooks.addAction("boot", noopAction);

    expect(hooks.hasAction("boot")).toBe(true);

    hooks.removeAction("boot", noopAction);

    expect(hooks.hasAction("boot")).toBe(false);
  });

  it("addAction and removeAction are chainable", () => {
    const hooks = new Hooks();

    expect(hooks.addAction("boot", noopAction)).toBe(hooks);
  });
});

describe("Hooks — filters", () => {
  it("threads the value through filters in priority order", async () => {
    const hooks = new Hooks();

    // Default-priority filter appends "!"; the priority-5 filter uppercases first.
    hooks.addFilter("title", (value) => `${String(value)}!`);
    hooks.addFilter("title", (value) => String(value).toUpperCase(), 5);

    const result = await hooks.applyFilters("title", "hello");

    expect(result).toBe("HELLO!");
  });

  it("applyFilters with no filters returns the input unchanged", async () => {
    const hooks = new Hooks();

    const result = await hooks.applyFilters("title", "untouched");

    expect(result).toBe("untouched");
  });

  it("awaits async filter listeners", async () => {
    const hooks = new Hooks();

    hooks.addFilter("n", async (value) => {
      await new Promise((resolve) => setTimeout(resolve, 1));

      return Number(value) + 1;
    });

    hooks.addFilter("n", (value) => Number(value) * 2);

    expect(await hooks.applyFilters("n", 10)).toBe(22);
  });

  it("passes extra args through to filter listeners", async () => {
    const hooks = new Hooks();

    hooks.addFilter("scale", (value, factor) => Number(value) * Number(factor));

    expect(await hooks.applyFilters("scale", 3, 4)).toBe(12);
  });

  it("removeFilter prevents the listener from transforming", async () => {
    const hooks = new Hooks();

    hooks.addFilter("title", shout);
    hooks.removeFilter("title", shout);

    expect(await hooks.applyFilters("title", "quiet")).toBe("quiet");
  });

  it("removeFilter keeps other listeners when more than one is registered", async () => {
    const hooks = new Hooks();

    hooks.addFilter("title", bang);
    hooks.addFilter("title", shout);
    hooks.removeFilter("title", bang);

    expect(await hooks.applyFilters("title", "hi")).toBe("HI");
    expect(hooks.hasFilter("title")).toBe(true);
  });

  it("removeFilter on an unknown name is a no-op", () => {
    const hooks = new Hooks();

    expect(hooks.removeFilter("ghost", identityFilter)).toBe(hooks);
    expect(hooks.hasFilter("ghost")).toBe(false);
  });

  it("hasFilter reflects registration state", () => {
    const hooks = new Hooks();

    expect(hooks.hasFilter("title")).toBe(false);

    hooks.addFilter("title", identityFilter);

    expect(hooks.hasFilter("title")).toBe(true);

    hooks.removeFilter("title", identityFilter);

    expect(hooks.hasFilter("title")).toBe(false);
  });

  it("addFilter is chainable", () => {
    const hooks = new Hooks();

    expect(hooks.addFilter("title", identityFilter)).toBe(hooks);
  });
});
