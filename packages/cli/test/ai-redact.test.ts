import { describe, expect, it } from "vitest";

import {
  type AiContextPayload,
  redactContext,
  redactString,
  stripAbsolutePaths,
  stripSecretTokens,
  stripSqlBindValues,
} from "../src/ai-redact";

/**
 * The ADR 0033 Phase-1 redaction stage, exercised as the REAL transform the bridge
 * calls before any context payload leaves the process. Each rule is tested in
 * isolation (the four `strip*` helpers) and then through the whole-payload
 * `redactContext` — positive stripping (a path, a secret token, a SQL bind is each
 * removed) plus the optional-field present/absent branches and the console drop.
 */

describe("stripAbsolutePaths", () => {
  it("collapses a POSIX home/machine path to <path> but keeps a trailing line:col", () => {
    expect(stripAbsolutePaths("at /Users/ryan/app/page.tsx:3:7")).toBe("at <path>:3:7");
    expect(stripAbsolutePaths("/home/ci/build/run.ts")).toBe("<path>");
  });

  it("collapses a Windows drive path to <path>", () => {
    expect(stripAbsolutePaths(String.raw`C:\Users\dev\project\page.tsx`)).toBe("<path>");
  });

  it("collapses a Windows UNC path (\\\\server\\share\\…) to <path> — internal topology", () => {
    expect(stripAbsolutePaths(String.raw`\\fileserver\admin$\secrets\db.json`)).toBe("<path>");
  });

  it("leaves a single-segment URL path (e.g. a route) untouched", () => {
    // `/posts` is one segment — a route, not a filesystem path — so it survives.
    expect(stripAbsolutePaths("GET /posts 200")).toBe("GET /posts 200");
  });

  it("returns the input unchanged when it holds no absolute path", () => {
    expect(stripAbsolutePaths("nothing to strip here")).toBe("nothing to strip here");
  });
});

describe("stripSqlBindValues", () => {
  it("reduces a quoted string literal to a ? placeholder", () => {
    expect(stripSqlBindValues("SELECT * FROM users WHERE email = 'a@b.com'")).toBe(
      "SELECT * FROM users WHERE email = ?",
    );
  });

  it("handles an escaped quote inside a string literal", () => {
    expect(stripSqlBindValues("WHERE name = 'O''Hara'")).toBe("WHERE name = ?");
  });

  it("reduces bare numeric literals in value positions to ?", () => {
    expect(stripSqlBindValues("WHERE id = 42 AND age IN (18, 21)")).toBe(
      "WHERE id = ? AND age IN (?, ?)",
    );
  });

  it("reduces a decimal literal in a value position to ?", () => {
    expect(stripSqlBindValues("WHERE price = 9.99")).toBe("WHERE price = ?");
  });

  it("leaves a digit that is part of an identifier untouched", () => {
    // `col2` is a column name, not a value position — no leading =/(/, so it stays.
    expect(stripSqlBindValues("SELECT col2 FROM t")).toBe("SELECT col2 FROM t");
  });

  it("returns the input unchanged when it carries no binds", () => {
    expect(stripSqlBindValues("SELECT id FROM posts")).toBe("SELECT id FROM posts");
  });
});

describe("stripSecretTokens", () => {
  it("redacts a KEY=/SECRET=/TOKEN=/PASSWORD= assignment but keeps the key name", () => {
    expect(stripSecretTokens("API_KEY=sk-abc env set")).toBe("API_KEY=<redacted> env set");
    expect(stripSecretTokens("DB_SECRET: hunter2")).toBe("DB_SECRET=<redacted>");
    expect(stripSecretTokens("PASSWORD=p")).toBe("PASSWORD=<redacted>");
  });

  it("redacts a Bearer/Basic authorization token", () => {
    expect(stripSecretTokens("Authorization: Bearer abc.def.ghi")).toBe(
      "Authorization: Bearer <redacted>",
    );
    expect(stripSecretTokens("Basic dXNlcjpwYXNz")).toBe("Basic <redacted>");
  });

  it("redacts connection-string credentials, keeping the scheme and host", () => {
    expect(stripSecretTokens("postgres://app:s3cr3t@db.internal/main")).toBe(
      "postgres://<redacted>@db.internal/main",
    );
  });

  it("redacts userinfo even when the password itself contains an @ (no truncation leak)", () => {
    // The password `p@ss` carries an `@`; a first-`@`-anchored match would leak
    // `ss@hostname`. The greedy-to-last-`@` class strips the whole userinfo.
    expect(stripSecretTokens("postgresql://user:p@ss@hostname:5432/db")).toBe(
      "postgresql://<redacted>@hostname:5432/db",
    );
  });

  it("does NOT mistake a path-@ (no userinfo colon) for credentials", () => {
    // `https://host/a@b` has no `:password@`, so the userinfo rule must not fire.
    expect(stripSecretTokens("https://host.example/a@b")).toBe("https://host.example/a@b");
  });

  it("redacts an AWS access-key id that sits below the high-entropy floor", () => {
    // `AKIAIOSFODNN7EXAMPLE` is 20 chars — under the 24-char entropy sweep — but its
    // prefix is unambiguous, so it is redacted by the explicit AWS pattern.
    expect(stripSecretTokens("config error for AKIAIOSFODNN7EXAMPLE")).toBe(
      "config error for <redacted>",
    );
    expect(stripSecretTokens("temp creds ASIAY34FZKBOKMUTVV7A here")).toBe(
      "temp creds <redacted> here",
    );
  });

  it("redacts a long high-entropy hex/base64 run", () => {
    const token = "deadbeefdeadbeefdeadbeef0123";

    expect(stripSecretTokens(`signed with ${token}`)).toBe("signed with <redacted>");
  });

  it("leaves a short ordinary identifier untouched", () => {
    expect(stripSecretTokens("requestId abc123")).toBe("requestId abc123");
  });
});

describe("redactString", () => {
  it("applies every rule in one pass: path, SQL bind, and secret all stripped", () => {
    const input = "at /home/app/db.ts ran SELECT id WHERE k = 'tok' with TOKEN=xyz";

    expect(redactString(input)).toBe("at <path> ran SELECT id WHERE k = ? with TOKEN=<redacted>");
  });

  it("is a no-op on a clean string", () => {
    expect(redactString("a plain diagnostic")).toBe("a plain diagnostic");
  });
});

describe("redactContext", () => {
  const base: AiContextPayload = { route: "/posts" };

  it("always carries (and redacts) the route", () => {
    const out = redactContext({ route: "GET /Users/ryan/app/api 200" });

    expect(out.route).toBe("GET <path> 200");
  });

  it("redacts every present optional field and drops console lines", () => {
    const out = redactContext({
      route: "/posts/edit",
      handlerLocation: "/Users/ryan/app/posts/[id].tsx:12:4",
      traceId: "trace-7f3a",
      collections: ["posts", "with TOKEN=leak"],
      devError: {
        source: "app-reload",
        message: "boom at /Users/ryan/app/page.tsx with Bearer abc.def.ghi",
        stack: "at /Users/ryan/app/db.ts SELECT * WHERE id = 7",
      },
      sql: ["SELECT * FROM users WHERE email = 'a@b.com'"],
      consoleLines: ["console.log leaked a /Users/ryan/secret"],
    });

    expect(out.handlerLocation).toBe("<path>:12:4");
    expect(out.traceId).toBe("trace-7f3a");
    expect(out.collections).toEqual(["posts", "with TOKEN=<redacted>"]);
    expect(out.devError).toEqual({
      source: "app-reload",
      message: "boom at <path> with Bearer <redacted>",
      stack: "at <path> SELECT * WHERE id = ?",
    });
    expect(out.sql).toEqual(["SELECT * FROM users WHERE email = ?"]);
    // Phase 1 drops raw console output entirely — it is never present in the output.
    expect(out).not.toHaveProperty("consoleLines");
  });

  it("omits absent optional fields rather than stamping them undefined", () => {
    const out = redactContext(base);

    expect(out).toEqual({ route: "/posts" });
    expect(out).not.toHaveProperty("handlerLocation");
    expect(out).not.toHaveProperty("traceId");
    expect(out).not.toHaveProperty("collections");
    expect(out).not.toHaveProperty("devError");
    expect(out).not.toHaveProperty("sql");
  });

  it("redacts a DevError that carries no stack, keeping stack absent", () => {
    const out = redactContext({
      ...base,
      devError: { source: "client-rebuild", message: "esbuild at /home/ci/x.ts failed" },
    });

    expect(out.devError).toEqual({ source: "client-rebuild", message: "esbuild at <path> failed" });
    expect(out.devError).not.toHaveProperty("stack");
  });
});
