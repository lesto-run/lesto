import { describe, expect, it } from "vitest";

import { keel } from "@keel/web";

import { defineFlags } from "../src/index";

describe("defineFlags.enabled", () => {
  it("reads a static default", async () => {
    const flags = defineFlags({ defaults: { a: true, b: false } });
    const app = keel().get("/", (c) =>
      c.json({ a: flags.enabled("a", c), b: flags.enabled("b", c) }),
    );

    expect(JSON.parse((await app.handle("GET", "/")).body)).toEqual({ a: true, b: false });
  });

  it("treats an unknown flag with no default as off", async () => {
    const flags = defineFlags();
    const app = keel().get("/", (c) => c.json({ x: flags.enabled("x", c) }));

    expect(JSON.parse((await app.handle("GET", "/")).body)).toEqual({ x: false });
  });

  it("treats a flag named after an inherited Object member as off", async () => {
    // "toString"/"constructor"/"__proto__" resolve to truthy prototype members on
    // a plain object — off-by-default must not be defeated by an own-property miss.
    const flags = defineFlags();
    const app = keel().get("/", (c) =>
      c.json({
        toString: flags.enabled("toString", c),
        constructor: flags.enabled("constructor", c),
        proto: flags.enabled("__proto__", c),
      }),
    );

    expect(JSON.parse((await app.handle("GET", "/")).body)).toEqual({
      toString: false,
      constructor: false,
      proto: false,
    });
  });

  it("lets a dynamic resolver win over the default", async () => {
    const flags = defineFlags({
      defaults: { preview: false },
      resolve: (_flag, c) => (c.query("preview") === "1" ? true : undefined),
    });
    const app = keel().get("/", (c) => c.json({ on: flags.enabled("preview", c) }));

    expect(JSON.parse((await app.handle("GET", "/", { query: { preview: "1" } })).body)).toEqual({
      on: true,
    });
    expect(JSON.parse((await app.handle("GET", "/")).body)).toEqual({ on: false });
  });
});

describe("defineFlags.gate middleware", () => {
  it("passes through when the flag is on", async () => {
    const flags = defineFlags({ defaults: { go: true } });
    const app = keel().get("/x", flags.gate("go"), (c) => c.text("reached"));

    expect((await app.handle("GET", "/x")).body).toBe("reached");
  });

  it("404s when a flag is off", async () => {
    const flags = defineFlags({ defaults: { go: false } });
    const app = keel().get("/x", flags.gate("go"), (c) => c.text("hidden"));

    const response = await app.handle("GET", "/x");

    expect(response.status).toBe(404);
    expect(response.body).toBe("Not Found");
  });

  it("requires every named flag to be on", async () => {
    const flags = defineFlags({ defaults: { a: true, b: false } });
    const app = keel().get("/x", flags.gate("a", "b"), (c) => c.text("reached"));

    expect((await app.handle("GET", "/x")).status).toBe(404);
  });

  it("gates a whole subtree via .use", async () => {
    const flags = defineFlags({ defaults: { beta: false } });
    const beta = keel()
      .use(flags.gate("beta"))
      .get("/feature", (c) => c.text("beta"));
    const app = keel().route("/beta", beta);

    expect((await app.handle("GET", "/beta/feature")).status).toBe(404);
  });

  it("honors a custom onDisabled response", async () => {
    const flags = defineFlags({
      defaults: { go: false },
      onDisabled: (c) => c.redirect("/waitlist", 303),
    });
    const app = keel().get("/x", flags.gate("go"), (c) => c.text("reached"));

    const response = await app.handle("GET", "/x");

    expect(response.status).toBe(303);
    expect(response.headers["Location"]).toBe("/waitlist");
  });
});
