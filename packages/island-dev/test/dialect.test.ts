/**
 * The matched-pair selection (ADR 0008): react and preact map to their own
 * Fast-Refresh plugin, and anything else fails by code rather than standing up a dev
 * server with no module HMR.
 */

import { describe, expect, it } from "vitest";

import { dialectPluginSpec } from "../src/dialect";
import { IslandDevError } from "../src/errors";

describe("dialectPluginSpec", () => {
  it("maps react to @vitejs/plugin-react", () => {
    expect(dialectPluginSpec("react")).toEqual({
      dialect: "react",
      module: "@vitejs/plugin-react",
    });
  });

  it("maps preact to @prefresh/vite", () => {
    expect(dialectPluginSpec("preact")).toEqual({
      dialect: "preact",
      module: "@prefresh/vite",
    });
  });

  it("refuses an unknown dialect with a coded error carrying the dialect", () => {
    let caught: unknown;

    try {
      dialectPluginSpec("svelte");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(IslandDevError);
    expect((caught as IslandDevError).code).toBe("ISLAND_DEV_UNKNOWN_DIALECT");
    expect((caught as IslandDevError).details).toEqual({ dialect: "svelte" });
  });
});
