# @lesto/content-prose

Writing style analysis and prose linting for content.

## Installation

```bash
npm install @lesto/content-prose
```

## Quick Start

```typescript
import { analyze } from "@lesto/content-prose";

const result = analyze("The CEO will leverage synergies.");

console.log(result.issues);
// [
//   { type: "jargon", word: "leverage", suggestion: "use" },
//   { type: "jargon", word: "synergies", suggestion: "collaboration" }
// ]
```

## Features

- **Weasel words** - Detect vague or imprecise language
- **Hedge words** - Find words that weaken statements
- **Cliches** - Identify overused phrases
- **Filler words** - Remove unnecessary words
- **Jargon** - Simplify corporate speak

## ASD-STE100 Simplified Technical English

The `ste` rule checks the mechanically checkable subset of ASD-STE100. It is
**off by default** — STE is a house style, not a general prose default. Turn it
on per project:

```json
{
  "rules": { "ste": "warn" }
}
```

It reports:

| Check              | ASD-STE100 rule | Example                                  |
| ------------------ | --------------- | ---------------------------------------- |
| Sentence length    | 6.3, 6.4        | 20 words in a procedure, 25 elsewhere    |
| Paragraph length   | 6.6             | at most 6 sentences                      |
| Contractions       | 2.1             | `don't` → `do not`                       |
| Progressive tense  | 3.4             | `is running` → `runs`                    |
| Participle clauses | 5.2             | `, using the flag` → a full sentence     |
| Noun clusters      | 4.2             | `user account access token` → 3 nouns    |
| Verb tense         | 3.1             | `has finished`, `shall`, `would`         |
| Word choice        | 1.1             | `assist` → `help`, `prior to` → `before` |

A list item is held to the tighter procedural sentence limit; a heading and a
table row are exempt from both length checks.

Contractions and single-word substitutions carry an auto-fix. A **phrase**
substitution reports but never auto-fixes: a phrase replacement can change the
form the next word must take (`for the purpose of testing` would become `to
testing`), and `extract()` blanks a lone `_` to a space, so a phrase can match
across a `snake_case` identifier. An entry whose replacement has an irregular
past participle is left out of the map entirely — `performed` -> `did` would
rewrite `was performed` to `was did`.

### The approved-word dictionary is not bundled

The ASD-STE100 approved-word dictionary is ASD copyright and is **not** shipped
with this package. `STE_WORD_MAP` in `src/ste.ts` is a small hand-written set of
plain-language substitutions in the spirit of the standard. Extend it per project
with a `replace` custom rule rather than adding the official list to this
repository.

A few `ste` word-choice entries overlap the always-on `hedge` and `fillers`
rules, so one word can draw a report from two rules when `ste` is enabled.

### Known limits

Without a part-of-speech tagger, the noun-cluster and `-ing` checks are
heuristic. Both are tuned to stay quiet rather than be wrong: a finite verb ends
a noun cluster instead of extending it, and an `-ing` word is only reported in a
progressive tense or a participle clause, never on its own.

**Noun clusters are the noisiest check.** English cannot be split into nouns and
verbs by shape alone — `taps`, `spells` and `streams` are all a noun or a verb
depending on context — so a run can cross a subject-verb-object boundary and
look like a modifier stack. Three filters cut most of that: a stop-word list, a
finite-verb list, and a gate that only reports a cluster introduced by a
determiner or a preposition. Measured over the 164 markdown files in this
repository, those filters take the check from 1338 reports to 487. A spot check
says roughly half of what remains is still a subject-verb-object crossing. Treat
the count as a signal to review, not as a defect list, and suppress a line with
`<!-- prose-disable-next-line ste -->`.

The sentence tokenizer also needs a capital letter after a full stop to split.
A sentence that starts with an inline-code span (`` `config` is required. ``)
reads as a continuation of the sentence before it, which can inflate one
sentence-length report. That behaviour is shared with the `readability` rule.

## Configuration

```typescript
import { configure } from "@lesto/content-prose/config";

const analyzer = configure({
  severity: "warning",
  ignore: ["synergy"],
});
```

## Documentation

Full documentation at [usedocks.dev](https://usedocks.dev)

## License

MIT
