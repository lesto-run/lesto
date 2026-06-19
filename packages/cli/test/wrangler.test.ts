import { describe, it, expect } from "vitest";

import {
  WRANGLER_DEPLOY_ARGS,
  WRANGLER_ROLLBACK_MESSAGE,
  wranglerRollbackArgs,
} from "../src/wrangler";

// The deploy driver (bin.ts) is coverage-excluded wiring that only runs against a
// live Cloudflare account, so these pin the exact flags it spawns. A change to the
// subcommands fails THIS gate on a PR rather than surfacing at a real deploy.
describe("wrangler invocation args (flag-drift guard)", () => {
  it("deploys with exactly `wrangler deploy`", () => {
    expect(WRANGLER_DEPLOY_ARGS).toEqual(["deploy"]);
  });

  it("rolls back with `wrangler rollback --message <reason>`", () => {
    expect(wranglerRollbackArgs(WRANGLER_ROLLBACK_MESSAGE)).toEqual([
      "rollback",
      "--message",
      "lesto deploy: post-deploy health check failed",
    ]);
  });
});
