/**
 * Custom oxlint rule: forbid `instanceof LestoError` on the BASE class.
 *
 * oxlint (unlike ESLint) ships no generic `no-restricted-syntax` rule, so this
 * hand-rolls the one AST shape that matters: a `BinaryExpression` whose
 * operator is `instanceof` and whose right-hand side is the bare identifier
 * `LestoError`.
 *
 * Why this matters: a monorepo install can end up with two copies of
 * `@lesto/errors` (a version mispin, a transitive-dep dedupe miss). An error
 * built by copy A is not `instanceof` copy B's `LestoError` class, so a coded
 * refusal thrown across that seam silently falls through the `instanceof`
 * gate and gets downgraded (a 400 becomes a 500) or loses its `code`
 * entirely. `isLestoError` (see `../src/errors.ts`) recognizes the SAME error
 * by a process-global `Symbol.for("lesto.error")` brand instead, which
 * survives the class-identity split. This rule keeps a new base-class
 * `instanceof LestoError` from silently reintroducing that bug at any of the
 * 40+ call sites across the monorepo.
 *
 * Deliberately narrow: `instanceof FooError` for any `LestoError` SUBCLASS
 * (`QueueError`, `MailError`, `DbError`, ...) is a different AST shape (the
 * identifier on the right is `FooError`, not `LestoError`) and is untouched —
 * those ~30 sites correctly discriminate on a specific subclass's shape and
 * must keep working exactly as they do today.
 *
 * Test files that construct a foreign-copy `LestoError`-shaped object and
 * assert `instanceof LestoError` is `false` (proving the brand check exists
 * for a real reason) are exempted via the `overrides` block in the root
 * `.oxlintrc.json`, not here — this rule stays a pure, unconditional AST
 * match so it never has to guess intent from surrounding code.
 */
import type { Rule } from "oxlint/plugins-dev";

const noBaseInstanceofLestoError: Rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "disallow `instanceof LestoError` on the base class; recognize a LestoError (base or subclass, same-copy or cross-copy) via `isLestoError` instead",
    },
  },
  create(context) {
    return {
      BinaryExpression(node) {
        if (
          node.operator !== "instanceof" ||
          node.right.type !== "Identifier" ||
          node.right.name !== "LestoError"
        ) {
          return;
        }

        context.report({
          node,
          message:
            "Do not use `instanceof LestoError` on the base class — a duplicate `@lesto/errors` copy breaks class identity and silently downgrades or drops the coded error. Use `isLestoError(value)` from `@lesto/errors` instead. (Subclass checks like `instanceof FooError` are unaffected and must stay.)",
        });
      },
    };
  },
};

export default {
  meta: { name: "lesto-errors" },
  rules: {
    "no-base-instanceof-lesto-error": noBaseInstanceofLestoError,
  },
};
