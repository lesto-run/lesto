/**
 * ASD-STE100 Simplified Technical English rule.
 *
 * Implements the mechanically checkable subset of the ASD-STE100 writing rules
 * as a single `ste` rule. It is OFF by default — STE is a house style, not a
 * general prose default.
 *
 * Checks, mapped to the ASD-STE100 writing rules they approximate:
 *   - sentence length      (procedures max 20 words, descriptions max 25)
 *   - paragraph length     (max 6 sentences)
 *   - contractions         ("don't" -> "do not")
 *   - progressive tense    ("is running")
 *   - participle clauses   (", using the flag", "by setting the flag")
 *   - noun clusters        (more than 3 nouns in a row)
 *   - non-approved tenses  (perfect tenses, "shall", "would")
 *   - non-approved words   (see STE_WORD_MAP)
 *
 * NOT implemented: the ASD-STE100 approved-word dictionary. It is ASD copyright
 * and is not bundled. STE_WORD_MAP below is a small hand-written substitution
 * map in the spirit of the standard, not a reproduction of it.
 */
import type { Rule, Diagnostic, TextSpan, SpanKind } from "./types.js";
import { offsetToPositionFast, type LineIndex } from "./position.js";
import { RuleContext, escapeRegex, preserveCase } from "./rule-context.js";
import { tokenizeSentences } from "./sentence-tokenizer.js";

/**
 * Words and phrases with a plainer equivalent, in the spirit of the ASD-STE100
 * approved-word list. Keys are lowercase; a phrase key uses single spaces.
 *
 * A phrase key never carries an auto-fix — see STE_WORD_MAP_PHRASES.
 * Entries whose replacement has an irregular past participle are omitted
 * ("performed" would rewrite "was performed" to "was did").
 */
export const STE_WORD_MAP: Record<string, string> = {
  // Wordy phrases
  "prior to": "before",
  "subsequent to": "after",
  "in order to": "to",
  "for the purpose of": "to",
  "in the event that": "if",
  "in the event of": "if",
  "due to the fact that": "because",
  "in conjunction with": "with",
  "with regard to": "about",
  "in the vicinity of": "near",
  "a number of": "some",
  "at this time": "now",
  "is able to": "can",
  "are able to": "can",
  "make an adjustment to": "adjust",

  // Long verbs
  assist: "help",
  assists: "helps",
  assisted: "helped",
  attempt: "try",
  attempts: "tries",
  attempted: "tried",
  obtain: "get",
  obtains: "gets",
  perform: "do",
  performs: "does",
  require: "need",
  requires: "needs",
  required: "needed",
  initiate: "start",
  initiates: "starts",
  initiated: "started",
  modify: "change",
  modifies: "changes",
  modified: "changed",
  eliminate: "remove",
  eliminates: "removes",
  eliminated: "removed",
  demonstrate: "show",
  demonstrates: "shows",
  indicate: "show",
  indicates: "shows",
  determine: "find",
  determines: "finds",
  determined: "found",
  verify: "check",
  verifies: "checks",
  verified: "checked",
  purchase: "buy",
  purchases: "buys",
  purchased: "bought",

  // Long modifiers
  additional: "more",
  numerous: "many",
  sufficient: "enough",
  currently: "now",
  previously: "before",
  regarding: "about",
  via: "by",
};

/**
 * Phrase keys, which never carry an auto-fix.
 *
 * A phrase replacement can change the form the next word must take ("for the
 * purpose of testing" -> "to testing"), and `extract()` blanks a lone `_` to a
 * space, so a phrase can match across a snake_case identifier and a fix would
 * rewrite the identifier. The diagnostic still reports; only the fix is held
 * back.
 */
const STE_WORD_MAP_PHRASES = new Set(Object.keys(STE_WORD_MAP).filter((key) => key.includes(" ")));

/** Numeric limits from the ASD-STE100 writing rules. */
export const STE_LIMITS = {
  /** Rule 6.3 — a sentence in a procedure has at most 20 words. */
  proceduralSentenceWords: 20,
  /** Rule 6.4 — a sentence in a description has at most 25 words. */
  descriptiveSentenceWords: 25,
  /** Rule 6.6 — a paragraph has at most 6 sentences. */
  paragraphSentences: 6,
  /** Rule 4.2 — at most 3 nouns in a row. */
  nounClusterWords: 3,
} as const;

// Blocks

/**
 * A markdown block rebuilt from its spans.
 *
 * `extract()` emits one span per contiguous text run per LINE, so a hard-wrapped
 * sentence arrives as several spans. Sentence and paragraph checks are only
 * correct over the rejoined block, so spans are grouped back into blocks here
 * and joined with a single space.
 */
interface Block {
  kind: SpanKind;
  /** Span texts joined with a single space. */
  text: string;
  /** Source offset of the first span. */
  offset: number;
  /** Maps an index in `text` back to a source offset. */
  segments: Array<{ at: number; offset: number; length: number }>;
}

/**
 * Group spans back into markdown blocks.
 *
 * A blank line always ends a block. A heading is always its own block. Each list
 * item starts a new block but absorbs its unmarked continuation lines, so a
 * wrapped bullet stays one block.
 */
export function groupBlocks(spans: TextSpan[], lineIndex: LineIndex): Block[] {
  const blocks: Block[] = [];
  let current: Block | undefined;
  let previousLine = -1;

  for (const span of spans) {
    const kind = span.kind ?? "paragraph";
    const { line } = offsetToPositionFast(lineIndex, span.offset);
    const lineChanged = line !== previousLine;
    const startsBlock =
      current === undefined ||
      line - previousLine >= 2 ||
      (lineChanged &&
        (kind === "heading" ||
          current.kind === "heading" ||
          kind === "listItem" ||
          kind === "tableRow" ||
          current.kind === "tableRow" ||
          (kind === "blockquote" && current.kind !== "blockquote")));

    if (startsBlock) {
      current = {
        kind,
        text: span.text,
        offset: span.offset,
        segments: [{ at: 0, offset: span.offset, length: span.text.length }],
      };
      blocks.push(current);
    } else {
      // `current` is defined here: startsBlock is true whenever it is undefined.
      const block = current as Block;
      const at = block.text.length + 1;
      block.text = `${block.text} ${span.text}`;
      block.segments.push({ at, offset: span.offset, length: span.text.length });
    }
    previousLine = line;
  }

  return blocks;
}

/**
 * Clamp a highlight length to what is left of the source line.
 *
 * A block joins several source lines, so a block-text length can be longer than
 * the line the diagnostic starts on. The formatter draws an underline of this
 * length and would otherwise run past the end of the line.
 */
function clampToLine(lineIndex: LineIndex, offset: number, length: number): number {
  const { line } = offsetToPositionFast(lineIndex, offset);
  const nextLineStart = lineIndex.lineStarts[line];
  if (nextLineStart === undefined) return length;
  return Math.min(length, Math.max(nextLineStart - 1 - offset, 1));
}

/**
 * Emit an `ste` diagnostic.
 *
 * Every check measures its highlight in joined-block space, but the offset is a
 * source offset, so a highlight that crosses a hard wrap would draw past the end
 * of its line. Clamping here means no check can forget to do it.
 */
function steDiag(
  ctx: RuleContext,
  offset: number,
  message: string,
  matchText: string,
  extra: Partial<Pick<Diagnostic, "length" | "fix" | "help" | "suggestion" | "prompt">>,
): Diagnostic {
  const { length } = extra;
  return ctx.diag("ste", offset, message, matchText, {
    ...extra,
    ...(length === undefined ? {} : { length: clampToLine(ctx.lineIndex, offset, length) }),
  });
}

/** Map an index in `block.text` back to an offset in the source document. */
function toOffset(block: Block, index: number): number {
  // Seeded with a zero-length segment at the block start, so a block with no
  // segments maps every index to its own offset instead of needing a guard.
  let segment = { at: 0, offset: block.offset, length: 0 };
  for (const candidate of block.segments) {
    if (candidate.at > index) break;
    segment = candidate;
  }
  return segment.offset + (index - segment.at);
}

// Patterns and word lists

const CONTRACTIONS: Record<string, string> = {
  "aren't": "are not",
  "can't": "cannot",
  "couldn't": "could not",
  "didn't": "did not",
  "doesn't": "does not",
  "don't": "do not",
  "hadn't": "had not",
  "hasn't": "has not",
  "haven't": "have not",
  "he's": "he is",
  "here's": "here is",
  "i'm": "I am",
  "i've": "I have",
  "isn't": "is not",
  "it'll": "it will",
  "it's": "it is",
  "let's": "let us",
  "mustn't": "must not",
  "she's": "she is",
  "shouldn't": "should not",
  "that's": "that is",
  "there's": "there is",
  "they'd": "they would",
  "they'll": "they will",
  "they're": "they are",
  "they've": "they have",
  "wasn't": "was not",
  "we'd": "we would",
  "we'll": "we will",
  "we're": "we are",
  "we've": "we have",
  "weren't": "were not",
  "what's": "what is",
  "who's": "who is",
  "won't": "will not",
  "wouldn't": "would not",
  "you'd": "you would",
  "you'll": "you will",
  "you're": "you are",
  "you've": "you have",
};

/**
 * Build a regex alternation body from map keys.
 *
 * Longest first: alternation is leftmost-first, not longest-first, so a key
 * that is a prefix of another key would otherwise shadow it.
 */
export const alternation = (
  keys: string[],
  escape: (key: string) => string = escapeRegex,
): string =>
  keys
    .toSorted((a, b) => b.length - a.length)
    .map(escape)
    .join("|");

/** Escape a key so it accepts a straight or a typographic apostrophe. */
const apostropheEscape = (key: string): string => escapeRegex(key).replace(/'/g, "['’]");

/** Normalize a typographic apostrophe so a match can be looked up in the map. */
const normalizeApostrophe = (text: string): string => text.replace(/’/g, "'");

/**
 * Words that end in "ing" but are not verb forms, so they never signal a
 * progressive tense or a participle clause.
 */
const ING_NOT_A_VERB = new Set([
  "anything",
  "ceiling",
  "during",
  "everything",
  "king",
  "morning",
  "nothing",
  "regarding",
  "ring",
  "sibling",
  "something",
  "spring",
  "string",
  "thing",
  "wing",
]);

/** Past participles that are irregular, so the "-ed"/"-en" test misses them. */
const IRREGULAR_PARTICIPLES = [
  "been",
  "brought",
  "built",
  "bought",
  "caught",
  "done",
  "found",
  "given",
  "gone",
  "held",
  "kept",
  "known",
  "left",
  "lost",
  "made",
  "met",
  "paid",
  "put",
  "read",
  "run",
  "said",
  "seen",
  "sent",
  "set",
  "shown",
  "sold",
  "taken",
  "taught",
  "told",
  "thought",
  "written",
];

/**
 * Finite verbs that break a noun cluster.
 *
 * Without a part-of-speech tagger, a present-tense verb ("the token expires")
 * is indistinguishable from a plural noun ("the token expires log"). This list
 * resolves the ambiguity toward the verb reading, which can only ever suppress
 * a report - it cannot invent one - so the rule stays quiet rather than wrong.
 */
const CLUSTER_VERB_BREAKS = new Set([
  ...IRREGULAR_PARTICIPLES,
  "accepts",
  "adds",
  "allows",
  "answers",
  "applies",
  "blocks",
  "breaks",
  "builds",
  "calls",
  "checks",
  "closes",
  "contains",
  "creates",
  "deletes",
  "depends",
  "dispatch",
  "dispatches",
  "does",
  "drops",
  "emit",
  "emits",
  "ends",
  "enters",
  "exists",
  "expects",
  "expires",
  "fails",
  "finds",
  "gives",
  "goes",
  "handle",
  "handles",
  "happens",
  "holds",
  "hydrates",
  "inline",
  "inlines",
  "investigates",
  "keeps",
  "knows",
  "leaves",
  "lets",
  "lists",
  "loads",
  "looks",
  "maps",
  "matches",
  "means",
  "moves",
  "needs",
  "occurs",
  "opens",
  "owns",
  "passes",
  "points",
  "prints",
  "publish",
  "publishes",
  "puts",
  "reads",
  "receives",
  "register",
  "registers",
  "removes",
  "render",
  "renders",
  "reports",
  "requires",
  "resets",
  "resolves",
  "return",
  "returns",
  "routes",
  "runs",
  "saves",
  "says",
  "scouts",
  "sends",
  "sets",
  "shares",
  "ships",
  "shows",
  "solves",
  "sorts",
  "starts",
  "states",
  "stays",
  "stops",
  "swaps",
  "takes",
  "teach",
  "teaches",
  "tells",
  "throws",
  "tries",
  "turns",
  "updates",
  "upgrades",
  "wants",
  "works",
  "writes",
  "yields",
]);

/**
 * Words that introduce a noun phrase: determiners, possessives and prepositions.
 *
 * A cluster is only reported when one of these sits immediately before it. A
 * noun phrase in technical prose is normally introduced this way, so the gate
 * costs little recall - and it discards the common false positive, where the
 * run has actually crossed a subject-verb-object boundary rather than stacking
 * modifiers ("the engine taps Postgres logical replication").
 */
const CLUSTER_INTRODUCERS = new Set([
  "a",
  "an",
  "and",
  "another",
  "any",
  "at",
  "both",
  "by",
  "each",
  "either",
  "every",
  "for",
  "from",
  "her",
  "his",
  "in",
  "into",
  "its",
  "my",
  "neither",
  "no",
  "of",
  "on",
  "onto",
  "or",
  "our",
  "per",
  "some",
  "such",
  "that",
  "the",
  "their",
  "these",
  "this",
  "those",
  "through",
  "to",
  "via",
  "with",
  "within",
  "your",
]);

/**
 * Words that are never the head of a noun cluster: articles, prepositions,
 * conjunctions, pronouns, auxiliaries and modals.
 */
const CLUSTER_STOP_WORDS = new Set([
  "a",
  "about",
  "above",
  "across",
  "after",
  "against",
  "all",
  "along",
  "also",
  "am",
  "among",
  "an",
  "and",
  "any",
  "are",
  "around",
  "as",
  "at",
  "be",
  "been",
  "before",
  "behind",
  "below",
  "beside",
  "besides",
  "between",
  "beyond",
  "both",
  "but",
  "by",
  "always",
  "can",
  "cannot",
  "could",
  "do",
  "does",
  "during",
  "each",
  "eight",
  "either",
  "else",
  "every",
  "except",
  "few",
  "first",
  "five",
  "for",
  "four",
  "from",
  "get",
  "gets",
  "give",
  "gives",
  "had",
  "has",
  "have",
  "he",
  "hence",
  "her",
  "here",
  "his",
  "how",
  "however",
  "i",
  "if",
  "in",
  "indeed",
  "inside",
  "instead",
  "into",
  "is",
  "it",
  "its",
  "last",
  "least",
  "less",
  "likewise",
  "make",
  "makes",
  "many",
  "may",
  "meanwhile",
  "might",
  "more",
  "moreover",
  "most",
  "much",
  "must",
  "my",
  "never",
  "next",
  "nine",
  "no",
  "nor",
  "not",
  "of",
  "off",
  "often",
  "on",
  "once",
  "one",
  "only",
  "or",
  "other",
  "otherwise",
  "our",
  "out",
  "outside",
  "over",
  "own",
  "per",
  "plus",
  "rather",
  "same",
  "second",
  "see",
  "sees",
  "set",
  "seven",
  "several",
  "she",
  "should",
  "since",
  "six",
  "so",
  "some",
  "sometimes",
  "still",
  "such",
  "ten",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "therefore",
  "these",
  "they",
  "this",
  "those",
  "three",
  "through",
  "thus",
  "to",
  "too",
  "toward",
  "towards",
  "twice",
  "two",
  "under",
  "unless",
  "until",
  "up",
  "upon",
  "use",
  "uses",
  "versus",
  "very",
  "via",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "whether",
  "which",
  "while",
  "who",
  "whose",
  "why",
  "will",
  "with",
  "within",
  "without",
  "would",
  "yet",
  "you",
  "your",
  "zero",
]);

const P = {
  contractions: new RegExp(
    `\\b(${alternation(Object.keys(CONTRACTIONS), apostropheEscape)})\\b`,
    "gi",
  ),
  progressive: /\b(am|is|are|was|were|be|been|being)\s+([a-z]+ing)\b/gi,
  participleClause: /(?:,\s+|\bby\s+)([a-z]+ing)\b/gi,
  perfectTense: new RegExp(
    `\\b(have|has|had)\\s+(?:been\\s+)?([a-z]+(?:ed|en)|${IRREGULAR_PARTICIPLES.join("|")})\\b`,
    "gi",
  ),
  unapprovedModal: /\b(shall|ought|would)\b/gi,
  wordMap: new RegExp(`\\b(${alternation(Object.keys(STE_WORD_MAP))})\\b`, "gi"),
  clusterWord: /[A-Za-z][A-Za-z0-9'’-]*/g,
} as const;

// Help text

interface CheckHelp {
  help: string;
  suggestion: string;
  prompt: string;
}

/** Per-check help, keyed by the ASD-STE100 concept the check approximates. */
const STE_HELP = {
  sentenceLength: {
    help: "ASD-STE100 limits a sentence to 20 words in a procedure and 25 words in a description. A long sentence holds more than one instruction, and a reader can miss one.",
    suggestion: "Split the sentence. Put one instruction or one idea in each sentence.",
    prompt:
      "Split this sentence into two or more sentences. Each sentence must state ONE instruction or ONE idea, and must stay under 20 words. Do not delete information.",
  },
  paragraphLength: {
    help: "ASD-STE100 limits a paragraph to 6 sentences. A long paragraph hides its topic and is hard to scan.",
    suggestion: "Split the paragraph, or move the extra sentences into a list of steps.",
    prompt:
      "Split this paragraph so that no paragraph has more than 6 sentences. If it describes a sequence, convert it into a numbered list of steps.",
  },
  contraction: {
    help: "ASD-STE100 does not permit contractions. A contraction is harder to read for a non-native reader, and a machine translator can read it incorrectly.",
    suggestion: "Write the full form of the two words.",
    prompt: "Expand this contraction into its full two-word form.",
  },
  progressive: {
    help: "ASD-STE100 permits only the simple present, the simple past, the simple future and the imperative. The progressive tense (a form of 'be' plus an '-ing' verb) is not permitted.",
    suggestion: "Use the simple tense. Write 'the server starts', not 'the server is starting'.",
    prompt:
      "Rewrite this clause in the simple present, simple past or simple future tense. Remove the progressive '-ing' form.",
  },
  participle: {
    help: "ASD-STE100 does not permit an '-ing' participle clause. The clause hides which noun does the action, so the reader must guess.",
    suggestion: "Make it a full sentence with an explicit subject, or use 'that' plus a verb.",
    prompt:
      "Rewrite this '-ing' participle clause as a full sentence with an explicit subject and a simple-tense verb.",
  },
  nounCluster: {
    help: "ASD-STE100 permits at most 3 nouns in a row. A longer cluster is ambiguous, because the reader cannot tell which noun modifies which.",
    suggestion: "Break the cluster with a preposition, for example 'of', 'for' or 'in'.",
    prompt:
      "Break this noun cluster into at most 3 nouns. Add a preposition such as 'of', 'for' or 'in' to show the relationship between the nouns.",
  },
  verbTense: {
    help: "ASD-STE100 permits only the simple present, the simple past, the simple future and the imperative. A perfect tense, 'shall', 'ought' and 'would' are not permitted.",
    suggestion: "Use the simple past or the simple future. Use 'must' for a requirement.",
    prompt:
      "Rewrite this in a simple tense. Replace a perfect tense with the simple past, replace 'shall' with 'must', and rewrite 'would' as a simple statement.",
  },
  wordChoice: {
    help: "ASD-STE100 approves one short word for each meaning. A longer synonym makes the text harder to read and harder to translate.",
    suggestion: "Use the shorter word with the same meaning.",
    prompt: "Replace this word or phrase with the shorter alternative given in the message.",
  },
} satisfies Record<string, CheckHelp>;

/** Help for one check. The object type is concrete, so every key resolves. */
const helpFor = (check: keyof typeof STE_HELP): CheckHelp => STE_HELP[check];

// Checks

/** Rules 6.3, 6.4 and 6.6 — sentence and paragraph length. */
function checkLength(ctx: RuleContext, block: Block): Diagnostic[] {
  // A heading is not a sentence, and a table row is a list of cell values
  // rather than prose, so neither can be measured as one.
  if (block.kind === "heading" || block.kind === "tableRow") return [];

  const sentences = tokenizeSentences(block.text, 0);
  const limit =
    block.kind === "listItem"
      ? STE_LIMITS.proceduralSentenceWords
      : STE_LIMITS.descriptiveSentenceWords;
  const kindLabel = block.kind === "listItem" ? "a procedure" : "a description";

  const diagnostics = sentences
    .filter((sentence) => sentence.wordCount > limit)
    .map((sentence) =>
      steDiag(
        ctx,
        toOffset(block, sentence.offset),
        `Sentence has ${sentence.wordCount} words. ASD-STE100 allows ${limit} in ${kindLabel}.`,
        sentence.text,
        { length: sentence.text.length, ...helpFor("sentenceLength") },
      ),
    );

  if (sentences.length > STE_LIMITS.paragraphSentences) {
    diagnostics.push(
      steDiag(
        ctx,
        block.offset,
        `Paragraph has ${sentences.length} sentences. ASD-STE100 allows ${STE_LIMITS.paragraphSentences}.`,
        // The id is built from this text. A block starts with its first
        // sentence, so without the prefix the paragraph diagnostic and the
        // sentence-length diagnostic on the same block collide.
        `paragraph ${block.text}`,
        helpFor("paragraphLength"),
      ),
    );
  }

  return diagnostics;
}

/** A matched word or phrase paired with the replacement STE approves. */
export interface Substitution {
  /** The text as it appears in the source, with its original capitalization. */
  matched: string;
  /** Index of the match within the block text. */
  index: number;
  /** The replacement, capitalized to match. */
  replacement: string;
}

/**
 * Pair every match of `pattern` with its entry in `map`.
 *
 * A match with no entry is dropped. The patterns here are generated from their
 * own maps, so that cannot happen in this module — the guard keeps the helper
 * total for a caller that pairs a pattern with a different map.
 */
export function substitutions(
  ctx: RuleContext,
  text: string,
  pattern: RegExp,
  map: Record<string, string>,
  normalize: (value: string) => string = (value) => value,
): Substitution[] {
  return [...ctx.scan(text, pattern)].flatMap((match) => {
    const entry = map[normalize(match.text).toLowerCase()];
    if (entry === undefined) return [];
    return [
      { matched: match.text, index: match.index, replacement: preserveCase(match.text, entry) },
    ];
  });
}

/** Rule 2.1 — no contractions. */
function checkContractions(ctx: RuleContext, block: Block): Diagnostic[] {
  return substitutions(ctx, block.text, P.contractions, CONTRACTIONS, normalizeApostrophe).map(
    ({ matched, index, replacement }) => {
      const start = toOffset(block, index);
      return steDiag(
        ctx,
        start,
        `"${matched}" is a contraction. ASD-STE100 requires "${replacement}".`,
        matched,
        {
          fix: { start, end: start + matched.length, text: replacement },
          ...helpFor("contraction"),
        },
      );
    },
  );
}

/** Rules 3.4 and 5.2 — no progressive tense and no participle clause. */
function checkIngForms(ctx: RuleContext, block: Block): Diagnostic[] {
  const progressive = [...ctx.scan(block.text, P.progressive)].flatMap((match) => {
    const verb = match.groups[1];
    if (verb === undefined || ING_NOT_A_VERB.has(verb.toLowerCase())) return [];
    return [
      steDiag(
        ctx,
        toOffset(block, match.index),
        `"${match.text}" is the progressive tense. ASD-STE100 allows only simple tenses.`,
        match.text,
        { length: match.text.length, ...helpFor("progressive") },
      ),
    ];
  });

  const participles = [...ctx.scan(block.text, P.participleClause)].flatMap((match) => {
    const verb = match.groups[0];
    if (verb === undefined || ING_NOT_A_VERB.has(verb.toLowerCase())) return [];
    // Point at the verb, not at the comma or the "by" that precedes it.
    const verbIndex = match.index + match.text.length - verb.length;
    return [
      steDiag(
        ctx,
        toOffset(block, verbIndex),
        `"${verb}" starts an -ing participle clause. ASD-STE100 does not allow it.`,
        verb,
        { length: verb.length, ...helpFor("participle") },
      ),
    ];
  });

  return [...progressive, ...participles];
}

/** Rule 4.2 — at most 3 nouns in a row. */
function checkNounClusters(ctx: RuleContext, block: Block): Diagnostic[] {
  const isNounCandidate = (word: string): boolean => {
    const lower = word.toLowerCase();
    // A single letter is too weak a signal to open a cluster - it is usually a
    // symbol or a label ("the n items"), not a modifier noun.
    if (lower.length < 2) return false;
    // A possessive already shows which noun owns which, so it ends the cluster.
    if (/['’]/.test(lower)) return false;
    if (CLUSTER_STOP_WORDS.has(lower) || CLUSTER_VERB_BREAKS.has(lower)) return false;
    // A verb or adverb form breaks the cluster rather than extending it.
    return !/(?:ly|ed|ing)$/.test(lower);
  };

  const diagnostics: Diagnostic[] = [];
  let runLength = 0;
  let runStart = 0;
  let runEnd = 0;
  let previousEnd = -1;
  let previousWord = "";
  let introduced = false;

  const flush = () => {
    if (introduced && runLength > STE_LIMITS.nounClusterWords) {
      const clusterText = block.text.slice(runStart, runEnd);
      diagnostics.push(
        steDiag(
          ctx,
          toOffset(block, runStart),
          `"${clusterText}" is a cluster of ${runLength} nouns. ASD-STE100 allows ${STE_LIMITS.nounClusterWords}.`,
          clusterText,
          { length: clusterText.length, ...helpFor("nounCluster") },
        ),
      );
    }
    runLength = 0;
  };

  for (const match of ctx.scan(block.text, P.clusterWord)) {
    // Anything other than plain spaces between two words breaks the cluster.
    const separated =
      previousEnd >= 0 && !/^[ \t]+$/.test(block.text.slice(previousEnd, match.index));
    if (separated) flush();
    if (isNounCandidate(match.text)) {
      if (runLength === 0) {
        runStart = match.index;
        introduced = !separated && CLUSTER_INTRODUCERS.has(previousWord);
      }
      runLength++;
      runEnd = match.index + match.text.length;
    } else {
      flush();
    }
    previousEnd = match.index + match.text.length;
    previousWord = match.text.toLowerCase();
  }
  flush();

  return diagnostics;
}

const verbTenseMessage = (text: string): string =>
  /^(shall|ought|would)$/i.test(text)
    ? `"${text}" is not an approved ASD-STE100 word.`
    : `"${text}" is not a simple tense. ASD-STE100 allows only simple tenses.`;

/** Rule 3.1 — only simple tenses, and no "shall", "ought" or "would". */
function checkVerbTense(ctx: RuleContext, block: Block): Diagnostic[] {
  return [P.perfectTense, P.unapprovedModal].flatMap((pattern) =>
    [...ctx.scan(block.text, pattern)].map((match) =>
      steDiag(ctx, toOffset(block, match.index), verbTenseMessage(match.text), match.text, {
        length: match.text.length,
        ...helpFor("verbTense"),
      }),
    ),
  );
}

/** Rule 1.1 — use the approved word for each meaning. */
function checkWordChoice(ctx: RuleContext, block: Block): Diagnostic[] {
  return substitutions(ctx, block.text, P.wordMap, STE_WORD_MAP).map(
    ({ matched, index, replacement }) => {
      const start = toOffset(block, index);
      // A fix is only safe for a single word that sits inside one span: a match
      // spanning a line break would land its replacement across the newline.
      const fixable =
        !STE_WORD_MAP_PHRASES.has(matched.toLowerCase()) &&
        block.segments.some(
          (segment) => index >= segment.at && index + matched.length <= segment.at + segment.length,
        );
      return steDiag(
        ctx,
        start,
        `"${matched}" is not approved. ASD-STE100 uses "${replacement}".`,
        matched,
        {
          ...(fixable ? { fix: { start, end: start + matched.length, text: replacement } } : {}),
          ...helpFor("wordChoice"),
        },
      );
    },
  );
}

const CHECKS = [
  checkLength,
  checkContractions,
  checkIngForms,
  checkNounClusters,
  checkVerbTense,
  checkWordChoice,
];

/**
 * ASD-STE100 Simplified Technical English rule.
 *
 * Off by default. Enable it with `{ "rules": { "ste": "warn" } }`.
 */
export const ste: Rule = (spans, file, lineIndex) => {
  const ctx = new RuleContext(file, lineIndex, "warning");
  const blocks = groupBlocks(spans, lineIndex);
  return blocks
    .flatMap((block) => CHECKS.flatMap((check) => check(ctx, block)))
    .toSorted((a, b) => a.offset - b.offset);
};
