import { describe, expect, it, vi } from "vitest";

import { selectAuthorizedTopics } from "../src/authz";

/** Tenant-scope check: a principal may see only its own org's topics. */
const orgScoped = (p: { org: string }, topic: string): boolean => topic.startsWith(`org:${p.org}:`);

/** An async check that authorizes exactly the topic `"ok"`. */
const allowOnlyOk = async (_p: unknown, topic: string): Promise<boolean> =>
  Promise.resolve(topic === "ok");

describe("selectAuthorizedTopics", () => {
  it("partitions topics by the authz check, preserving order", async () => {
    const result = await selectAuthorizedTopics(
      { org: "1" },
      ["org:1:posts", "org:2:secret", "org:1:comments"],
      orgScoped,
      64,
    );

    expect(result.authorized).toEqual(["org:1:posts", "org:1:comments"]);
    expect(result.dropped).toEqual(["org:2:secret"]);
  });

  it("awaits an async authz check", async () => {
    const result = await selectAuthorizedTopics({}, ["ok", "no"], allowOnlyOk, 64);

    expect(result.authorized).toEqual(["ok"]);
    expect(result.dropped).toEqual(["no"]);
  });

  it("drops topics past the cap WITHOUT running an authz check on them", async () => {
    // The check throws if ever called past the cap — proving the cap short-circuits
    // before any (potentially unbounded) authz work.
    const authorize = vi.fn((_p: unknown, topic: string) => {
      if (topic === "third") throw new Error("should not be checked");

      return true;
    });

    const result = await selectAuthorizedTopics({}, ["first", "second", "third"], authorize, 2);

    expect(result.authorized).toEqual(["first", "second"]);
    expect(result.dropped).toEqual(["third"]);
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it("returns empty partitions for no requested topics", async () => {
    const result = await selectAuthorizedTopics({}, [], () => true, 64);

    expect(result).toEqual({ authorized: [], dropped: [] });
  });
});
