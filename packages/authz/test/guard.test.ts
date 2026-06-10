import { describe, expect, it } from "vitest";

import { keel } from "@keel/web";

import { createGuard, definePolicy } from "../src/index";

const policy = definePolicy({
  roles: ["member", "admin"],
  can: { "admin.access": ["admin"], "post.read": ["member", "admin"] },
});

describe("createGuard.can middleware", () => {
  it("lets a permitted subject through to the handler", async () => {
    const { can } = createGuard(policy);

    const app = keel()
      .use((c, next) => {
        c.set("roles", ["admin"]);
        return next();
      })
      .get("/admin", can("admin.access"), (c) => c.text("ok"));

    const response = await app.handle("GET", "/admin");

    expect(response.status).toBe(200);
    expect(response.body).toBe("ok");
  });

  it("answers 403 when the subject lacks the permission", async () => {
    const { can } = createGuard(policy);

    const app = keel()
      .use((c, next) => {
        c.set("roles", ["member"]);
        return next();
      })
      .get("/admin", can("admin.access"), (c) => c.text("secret"));

    const response = await app.handle("GET", "/admin");

    expect(response.status).toBe(403);
    expect(response.body).toBe("Forbidden");
  });

  it("denies when no roles were set on the context", async () => {
    const { can } = createGuard(policy);
    const app = keel().get("/admin", can("admin.access"), (c) => c.text("secret"));

    expect((await app.handle("GET", "/admin")).status).toBe(403);
  });

  it("guards an entire subtree via .use", async () => {
    const { can } = createGuard(policy);

    const admin = keel()
      .use(can("admin.access"))
      .get("/users", (c) => c.text("users"))
      .page("/dash", { component: () => null });

    const app = keel()
      .use((c, next) => {
        c.set("roles", ["member"]);
        return next();
      })
      .route("/admin", admin);

    expect((await app.handle("GET", "/admin/users")).status).toBe(403);
    expect((await app.handle("GET", "/admin/dash")).status).toBe(403);
  });
});

describe("createGuard options", () => {
  it("honors a custom rolesOf resolver", async () => {
    const { can } = createGuard(policy, {
      rolesOf: (c) => c.get<{ roles: string[] }>("user")?.roles,
    });

    const app = keel()
      .use((c, next) => {
        c.set("user", { roles: ["admin"] });
        return next();
      })
      .get("/a", can("admin.access"), (c) => c.text("ok"));

    expect((await app.handle("GET", "/a")).status).toBe(200);
  });

  it("honors a custom onDeny response", async () => {
    const { can } = createGuard(policy, {
      onDeny: (c) => c.redirect("/login", 303),
    });

    const app = keel().get("/a", can("admin.access"), (c) => c.text("ok"));

    const response = await app.handle("GET", "/a");

    expect(response.status).toBe(303);
    expect(response.headers["Location"]).toBe("/login");
  });
});

describe("createGuard.ensure (imperative)", () => {
  it("returns the policy decision for a row-level check", async () => {
    const { ensure } = createGuard(policy);

    const app = keel()
      .use((c, next) => {
        c.set("roles", ["member"]);
        return next();
      })
      .get("/p", (c) =>
        c.json({ canRead: ensure(c, "post.read"), canAdmin: ensure(c, "admin.access") }),
      );

    expect(JSON.parse((await app.handle("GET", "/p")).body)).toEqual({
      canRead: true,
      canAdmin: false,
    });
  });
});
