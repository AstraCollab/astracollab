/**
 * Deterministic fact extraction.
 *
 * The model-backed extractor in `./memory.ts` is good at judgement but it is
 * still a model: it can refuse, hedge, or return nothing, and a fact the user
 * plainly stated then never gets learned. Since the user asked for memory to
 * work regardless of model, anything stated unambiguously is captured here
 * with plain pattern matching, and the model extractor is layered on top for
 * everything subtler.
 *
 * Only high-confidence shapes are matched. Being wrong in this direction writes
 * a useless memory; being silent loses a real one, and the model extractor can
 * still catch it later.
 */

const URL = /\bhttps?:\/\/[^\s<>()[\]"'`]+/g;

/**
 * Positive requirements only.
 *
 * "never X" reads correctly as a requirement. "do not X" / "don't X" must NOT be
 * captured here: naively taking the object of a negation produced nonsense like
 * "The user requires: verify it against the repo" from "do not verify it against
 * the repo", inverting the user's meaning.
 */
const REQUIREMENT =
  /\b(always|never|must|should|make sure to|remember to)\b[\s:]+([^.?!\n]{4,160})/gi;

/**
 * "<subject> is <value>".
 *
 * The value must NOT stop at the first `.`: that truncated
 * `internal-hbr-2291.pineapple.example` to `internal-hbr-2291` and then poisoned
 * recall with the broken value. Stop at a period only when it ends a sentence.
 */
const ASSIGNMENT = /\b([A-Za-z][\w ()-]{2,60}?)\s+(?:is|are)\s+([^\n?!]{3,200})/g;

const CODEISH = /[A-Z0-9_./:-]/;

const looksLikeValue = (value: string): boolean => {
  const trimmed = value.trim();
  if (trimmed.length < 3 || trimmed.length > 200) return false;
  // Avoid capturing filler like "this is fine" or "it is not".
  if (/^(not|nothing|unclear|unknown|the same|that|this|it)\b/i.test(trimmed)) return false;
  if (!CODEISH.test(trimmed)) return false;
  return true;
};

/** Cut a captured clause back to its first complete sentence. */
const firstSentence = (value: string): string => {
  // A period followed by whitespace and a capital letter starts a new sentence.
  const match = /\.(?=\s+[A-Z(])/.exec(value);
  return match ? value.slice(0, match.index) : value;
};

const tidy = (value: string): string =>
  firstSentence(value)
    .replace(/\s+/g, " ")
    .replace(/^(?:that|the|a|an|it|this)\s+/i, "")
    .replace(/[,;:\s.。]+$/, "")
    .trim();

export type DeterministicMemory = { content: string; domains?: string[] };

/**
 * Extract statements the user made that are worth remembering, without a model.
 */
export const extractDeterministic = (userMessage: string): DeterministicMemory[] => {
  const out: DeterministicMemory[] = [];
  const push = (content: string) => {
    const cleaned = tidy(content);
    if (cleaned.length < 8 || cleaned.length > 300) return;
    if (/^(yes|no|ok|okay|sure|thanks|thank you|got it|noted)\b/i.test(cleaned)) return;
    if (out.some((existing) => existing.content.toLowerCase() === cleaned.toLowerCase())) return;
    out.push({ content: cleaned });
  };

  // 1. URLs are unambiguous.
  for (const match of userMessage.match(URL) ?? []) {
    push(`User-provided URL: ${match}`);
  }

  // 2. Stated requirements, kept in the user's own words.
  //    Paraphrasing flipped meaning: "Never force push" became
  //    "The user requires: force push", i.e. the exact opposite instruction.
  for (const match of userMessage.matchAll(REQUIREMENT)) {
    const verb = (match[1] ?? "").toLowerCase();
    const body = tidy(match[2] ?? "");
    if (!body) continue;
    push(`User requirement (${verb}): ${body}`);
  }

  // 4. "X is Y" where Y is identifier-shaped.
  for (const match of userMessage.matchAll(ASSIGNMENT)) {
    const subject = tidy(match[1] ?? "");
    const value = tidy(match[2] ?? "");
    if (!subject || !looksLikeValue(value)) continue;
    push(`${subject} is ${value}`);
  }

  return out.slice(0, 6);
};
