/**
 * The react-email dogfood: estate's transactional templates render to real,
 * cross-client HTML, and the identity flow runs them.
 *
 * No jsdom — `@react-email/render` renders via react-dom/server in plain Node,
 * the same way a deployed app would mint the HTML it hands a transport.
 */

import { render } from "@react-email/render";
import { describe, expect, it } from "vitest";

import { createDemoMailer } from "../src/emails/mailer";
import { ResetPasswordEmail, VerifyEmail } from "../src/emails/templates";
import { buildIdentity } from "../src/identity";

describe("react-email templates", () => {
  it("renders the verification email to HTML with its action link", async () => {
    const html = await render(<VerifyEmail url="https://estate.test/verify?token=abc" />);

    expect(html.toLowerCase()).toContain("<html");
    expect(html).toContain("Confirm your email");
    expect(html).toContain("Verify email");
    // Both the button href and the spelled-out fallback carry the link.
    expect(html).toContain("https://estate.test/verify?token=abc");
  });

  it("renders the password-reset email to HTML with its action link", async () => {
    const html = await render(<ResetPasswordEmail url="https://estate.test/reset?token=xyz" />);

    expect(html).toContain("Reset your password");
    expect(html).toContain("https://estate.test/reset?token=xyz");
  });
});

describe("the demo identity mailer", () => {
  it("records one rendered message per send", async () => {
    const mailer = createDemoMailer();

    await mailer.sendVerificationEmail({
      to: "ada@example.com",
      url: "https://estate.test/v?token=1",
      token: "1",
    });

    expect(mailer.outbox).toHaveLength(1);
    expect(mailer.outbox[0]!.to).toBe("ada@example.com");
    expect(mailer.outbox[0]!.subject).toBe("Confirm your email");
    expect(mailer.outbox[0]!.html).toContain("https://estate.test/v?token=1");
  });

  it("renders a real verification email when a new account registers", async () => {
    const { identity, outbox, close } = await buildIdentity();

    try {
      // A fresh (non-seeded) email goes through the real register → verify path.
      await identity.register("newcomer@example.com", "a sufficiently long password");

      expect(outbox).toHaveLength(1);
      expect(outbox[0]!.to).toBe("newcomer@example.com");
      // The verification URL estate configured, rendered into real react-email HTML.
      expect(outbox[0]!.html).toContain("/mls/api/verify?token=");
    } finally {
      close();
    }
  });
});
