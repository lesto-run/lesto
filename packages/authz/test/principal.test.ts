import { describe, expect, it, vi } from "vitest";

import { lesto } from "@lesto/web";

import {
  createGuard,
  createPrincipalResolver,
  definePolicy,
  getPrincipal,
  type Principal,
} from "../src/index";

const policy = definePolicy({
  roles: ["member", "admin"],
  can: { "admin.access": ["admin"], "post.read": ["member", "admin"] },
});

describe("createPrincipalResolver", () => {
  it("resolves the principal from the session and threads roles so guards pass", async () => {
    // verifySession reads off the real Context (the cookie/header seam) — here a header.
    const verifySession = vi.fn((c) =>
      c.header("x-user") === "u1" ? { userId: "u1" } : undefined,
    );
    const rolesOf = vi.fn(async (_actor: string) => ["admin"]);
    const { can } = createGuard(policy);

    const app = lesto()
      .use(createPrincipalResolver({ verifySession, rolesOf }))
      .get("/admin", can("admin.access"), (c) => c.json(getPrincipal(c)));

    const response = await app.handle("GET", "/admin", { headers: { "x-user": "u1" } });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body as string)).toEqual({ actor: "u1", actorRoles: ["admin"] });
    expect(verifySession).toHaveBeenCalledTimes(1);
    expect(rolesOf).toHaveBeenCalledWith("u1");
  });

  it("denies by default and exposes no principal when unauthenticated", async () => {
    const verifySession = vi.fn(async () => undefined);
    const rolesOf = vi.fn(async () => ["admin"]);
    const { can } = createGuard(policy);

    let seen: Principal | undefined = { actor: "sentinel", actorRoles: [] };
    const app = lesto()
      .use(createPrincipalResolver({ verifySession, rolesOf }))
      .get("/admin", can("admin.access"), (c) => c.text("secret"))
      .get("/whoami", (c) => {
        seen = getPrincipal(c);

        return c.text("ok");
      });

    expect((await app.handle("GET", "/admin")).status).toBe(403);

    await app.handle("GET", "/whoami");

    expect(seen).toBeUndefined();
    // An absent session never consults the roles store.
    expect(rolesOf).not.toHaveBeenCalled();
  });

  it("attributes an authenticated user with no roles, but still denies them", async () => {
    const { can } = createGuard(policy);

    let principal: Principal | undefined;
    const app = lesto()
      .use(
        createPrincipalResolver({
          // Sync return (covers awaiting a non-promise) + an arbitrary Iterable.
          verifySession: () => ({ userId: "u2" }),
          rolesOf: () => new Set<string>(),
        }),
      )
      .get("/admin", can("admin.access"), (c) => c.text("secret"))
      .get("/whoami", (c) => {
        principal = getPrincipal(c);

        return c.text("ok");
      });

    expect((await app.handle("GET", "/admin")).status).toBe(403);

    await app.handle("GET", "/whoami");

    expect(principal).toEqual({ actor: "u2", actorRoles: [] });
  });
});
