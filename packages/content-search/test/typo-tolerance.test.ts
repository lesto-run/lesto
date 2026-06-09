/**
 * Regression: typo tolerance is only live once the processor has a vocabulary.
 *
 * The useSearch hook created a QueryProcessor with maxTypoDistance but never
 * called buildVocabulary, so correctWord always early-returned (bkTree null) —
 * typoTolerance was a no-op. These tests pin the invariant the hook now relies
 * on: with a vocabulary, a near-miss term is corrected; without one, it is not.
 */

import { describe, expect, it } from "vitest";
import { createQueryProcessor } from "../src/query-intelligence";

const VOCAB = [
  { title: "Authentication Guide", content: "configure login and session tokens" },
  { title: "Database Setup", content: "connect postgres and run migrations" },
];

describe("typo tolerance requires a vocabulary", () => {
  it("does NOT correct typos before buildVocabulary (the original no-op)", () => {
    const processor = createQueryProcessor({ maxTypoDistance: 2, enableStemming: false });

    const result = processor.process("authentcation");

    expect(result.wasTypoCorrected).toBe(false);
    expect(result.terms).toContain("authentcation");
  });

  it("corrects a typo once the vocabulary is seeded", () => {
    const processor = createQueryProcessor({ maxTypoDistance: 2, enableStemming: false });
    processor.buildVocabulary(VOCAB);

    const result = processor.process("authentcation");

    expect(result.wasTypoCorrected).toBe(true);
    expect(result.terms).toContain("authentication");
  });

  it("does not correct when typoTolerance is off (maxTypoDistance 0)", () => {
    const processor = createQueryProcessor({ maxTypoDistance: 0, enableStemming: false });
    processor.buildVocabulary(VOCAB);

    const result = processor.process("authentcation");

    expect(result.wasTypoCorrected).toBe(false);
  });
});
