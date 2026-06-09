/**
 * Rich help text for each lumen rule.
 * Provides educational context and actionable suggestions.
 */

export interface RuleHelp {
  help: string;
  suggestion: string;
  /** AI instruction for fixing this issue */
  prompt?: string;
}

type HelpGenerator = (match: string) => RuleHelp;

export const RULE_HELP: Record<string, HelpGenerator> = {
  fillers: (match) => ({
    help: `"${match}" is a filler word that adds length without contributing meaning. Filler words make writing feel padded and can obscure your main point.`,
    suggestion: "Try removing this word entirely, or replace it with more specific language.",
    prompt: `Remove "${match}" entirely. Adjust capitalization and punctuation as needed.`,
  }),

  weasel: (match) => ({
    help: `"${match}" is a weasel word—a vague quantifier that weakens your writing by avoiding specificity. Readers may question whether you have real data.`,
    suggestion: "Replace with concrete numbers, percentages, or specific examples.",
    prompt: `Remove "${match}" or replace it with a specific number, percentage, or concrete example.`,
  }),

  hedge: (match) => ({
    help: `"${match}" is hedge language that undermines your assertions. While sometimes appropriate for nuance, overuse makes writing feel uncertain and less authoritative.`,
    suggestion: "Consider whether the hedge is necessary. If you're confident, state it directly.",
    prompt: `Remove "${match}" and make the statement more direct and confident.`,
  }),

  passive: (match) => ({
    help: `"${match}" appears to use passive voice. Passive constructions can obscure who is performing the action and make sentences harder to follow.`,
    suggestion: 'Rewrite with the actor as the subject. E.g., "The report was written by Sarah" → "Sarah wrote the report."',
    prompt: `Rewrite in active voice. Identify who is performing the action and make them the subject of the sentence.`,
  }),

  adverbs: (match) => ({
    help: `"${match}" is an adverb (ends in -ly). While not always problematic, adverbs often indicate a weak verb that could be replaced with a stronger, more precise one.`,
    suggestion: 'Try using a more vivid verb instead. E.g., "walked quickly" → "hurried" or "strode."',
    prompt: `Remove "${match}" entirely, or replace the verb+adverb combination with a single stronger verb.`,
  }),

  simplify: (match) => ({
    help: `"${match}" has a simpler alternative. Plain language is usually clearer, more accessible, and easier to read quickly.`,
    suggestion: "Use the simpler word unless the complex one adds necessary precision or nuance.",
    prompt: `Replace "${match}" with its simpler alternative.`,
  }),

  repeated: (match) => ({
    help: `"${match}" appears twice in a row. This is usually a typo from editing or copy-pasting.`,
    suggestion: "Remove the duplicate word.",
    prompt: `Remove the duplicate "${match}".`,
  }),

  cliches: (match) => ({
    help: `"${match}" is a cliché—an overused phrase that has lost its impact through repetition. Clichés can make writing feel lazy or unoriginal.`,
    suggestion: "Express this idea in your own words, or find fresh imagery that conveys the same meaning.",
    prompt: `Replace the cliché "${match}" with original, fresh language that conveys the same meaning.`,
  }),

  condescending: (match) => ({
    help: `"${match}" can come across as condescending or patronizing to readers. What seems "obvious" or "simple" to you may not be to everyone.`,
    suggestion: "Remove this word. Trust your readers to understand without being told something is easy.",
    prompt: `Remove "${match}" entirely. Adjust capitalization and punctuation as needed.`,
  }),

  profanity: (match) => ({
    help: `"${match}" is flagged as potentially inappropriate language.`,
    suggestion: "Consider your audience and publication context. Replace if the tone doesn't fit.",
    prompt: `Replace or remove "${match}" with more appropriate language.`,
  }),

  readability: () => ({
    help: "This sentence is complex due to its length or structure. Long sentences with many clauses can lose readers, especially when scanning.",
    suggestion: "Try breaking this into 2-3 shorter sentences, or simplify the structure by removing subordinate clauses.",
    prompt: `This sentence is too complex. Rewrite as TWO shorter sentences (under 15 words each). Break at a natural point (comma, dash, or conjunction). Do NOT just remove words—actually restructure into multiple sentences.`,
  }),

  spelling: (match) => ({
    help: `"${match}" appears to be misspelled.`,
    suggestion: "Use the suggested correction if available, or check your spelling.",
    prompt: `Correct the spelling of "${match}".`,
  }),

  // A11y (accessibility) rules
  altText: () => ({
    help: "Images must have alt text for screen reader users and when images fail to load. Alt text describes the image content and purpose.",
    suggestion: "Add descriptive alt text that explains what the image shows. Be specific and concise (1-2 sentences). Avoid starting with 'Image of' or 'Picture of'.",
    prompt: "Generate descriptive alt text for this image that explains its content and purpose. Be specific, concise, and avoid starting with 'Image of'.",
  }),

  headingHierarchy: (match) => ({
    help: `${match} Proper heading hierarchy is crucial for screen reader navigation. Users often navigate by headings, and skipped levels create confusion.`,
    suggestion: "Use headings in sequential order (H1 → H2 → H3). Don't skip levels. Each page should have only one H1.",
    prompt: "Fix the heading level to follow proper hierarchy without skipping levels.",
  }),

  headingDuplicate: (match) => ({
    help: `${match} Duplicate headings at the same level make navigation confusing for screen reader users who navigate by heading list.`,
    suggestion: "Make this heading more specific to distinguish it from other headings at this level.",
    prompt: "Make this heading more specific and unique compared to other headings at this level.",
  }),

  linkText: (match) => ({
    help: `"${match}" is vague link text. Screen reader users often navigate by links, and hear link text out of context. Vague text like "click here" provides no information about the destination.`,
    suggestion: 'Use descriptive link text that explains where the link goes. E.g., instead of "click here", use "view the API documentation" or "read the getting started guide".',
    prompt: `Replace the vague link text "${match}" with descriptive text that explains the link destination.`,
  }),

  codeBlockLanguage: () => ({
    help: "Code blocks without language specification miss out on syntax highlighting and screen reader announcements. The language tag helps readers understand what type of code they're viewing.",
    suggestion: "Add a language identifier after the opening fence: ```javascript, ```python, ```bash, etc. Use ```text for plain text or output.",
    prompt: "Add the appropriate language identifier to this code block for syntax highlighting and accessibility.",
  }),

  embedTitle: (match) => ({
    help: `${match} Screen reader users need a title to understand embedded content. Without a title, they may not know what the iframe or video contains.`,
    suggestion: 'Add a descriptive title attribute that explains the embedded content. E.g., title="Tutorial: Setting up authentication".',
    prompt: "Add a descriptive title attribute to this embedded element that explains its content.",
  }),
};

/**
 * Get help text for a diagnostic.
 */
export function getHelpForRule(rule: string, matchedText: string): RuleHelp | null {
  const generator = RULE_HELP[rule];
  if (!generator) return null;
  return generator(matchedText);
}
