/**
 * Tests for the workload contract that CAN run without a socket — the realistic
 * catalog page in particular. The full real-server suite (driver/run.ts) is
 * CI/local-only, but the contract's byte-stability is the thing the parity check
 * depends on, so it's pinned here. We also dispatch the realistic route through the
 * REAL Lesto pipeline in-process (no port) to prove the highest-value app actually
 * serves the contract bytes — the same in-process dispatch the compare suite uses.
 */

import { describe, expect, test } from "bun:test";

import {
  REALISTIC_PRODUCTS,
  realisticBody,
  realisticCard,
  realisticProduct,
  simulateDbLatency,
} from "../apps/_contract.mjs";

describe("realisticProduct / realisticCard", () => {
  test("a product is a pure function of its index (byte-stable across calls/runs)", () => {
    expect(realisticProduct(0)).toEqual(realisticProduct(0));
    expect(realisticProduct(3)).toEqual({
      id: 1003,
      name: "Trading Card No. 1003",
      price: "12.49", // 4.99 + 3 * 2.5
      rating: "3.3", // 3 + (3 % 20) / 10
      reviews: 24, // 3 * 7 + 3
    });
  });

  test("a card embeds the product's fields and is whitespace-free between tags", () => {
    const card = realisticCard(realisticProduct(0));
    expect(card).toContain('data-id="1000"');
    expect(card).toContain("$4.99");
    expect(card).toContain("Trading Card No. 1000");
    expect(card).not.toMatch(/>\s+</); // no whitespace between tags
  });
});

describe("realisticBody", () => {
  test("is deterministic — two calls produce identical bytes (the parity oracle)", () => {
    expect(realisticBody()).toBe(realisticBody());
  });

  test("renders exactly REALISTIC_PRODUCTS cards in a single-line document", () => {
    const body = realisticBody();
    const cards = body.match(/<li class="card"/g) ?? [];
    expect(cards).toHaveLength(REALISTIC_PRODUCTS);
    expect(body.startsWith("<!doctype html>")).toBe(true);
    expect(body.endsWith("</html>")).toBe(true);
    expect(body).not.toContain("\n"); // one line, like ssrBody
    // It's a credible page, not a hello-world: meaningfully larger than the 50-row /ssr.
    expect(body.length).toBeGreaterThan(3000);
  });

  test("is substantially richer than the existing /ssr workload", async () => {
    const { ssrBody } = await import("../apps/_contract.mjs");
    expect(realisticBody().length).toBeGreaterThan(ssrBody().length);
  });
});

describe("simulateDbLatency", () => {
  test("resolves after a small (1–5 ms) async wait", async () => {
    const start = performance.now();
    await simulateDbLatency();
    const elapsed = performance.now() - start;
    // It awaited a real timer (≥ ~1 ms) but is bounded — generous ceiling for CI jitter.
    expect(elapsed).toBeGreaterThanOrEqual(0.5);
    expect(elapsed).toBeLessThan(200);
  });
});

describe("Lesto serves /realistic through the real pipeline (in-process)", () => {
  test("the contract bytes come back from a genuine lesto() app dispatch", async () => {
    // Same in-process dispatch the compare suite uses — no socket, no port.
    const { buildBenchApp } = await import("../apps/lesto/server.ts");
    const { app, close } = await buildBenchApp({ secure: false });
    try {
      const res = await app.handle("GET", "/realistic");
      const body = typeof res.body === "string" ? res.body : String(res.body);
      expect(body).toBe(realisticBody());
    } finally {
      close();
    }
  });
});
