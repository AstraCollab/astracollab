/**
 * Deterministic fact extraction.
 *
 * A model extractor is good at judgement but it is still a model: it can
 * refuse, hedge, or return nothing, and a fact the user plainly stated then
 * never gets learned. Everything stated unambiguously is captured here with
 * plain pattern matching, and the model is layered on top for the subtler cases.
 *
 * Only high-confidence shapes are matched. Being wrong in this direction writes
 * a useless memory; being silent loses a real one, which is the worse failure.
 */

const URL = /\bhttps?:\/\/[^\s<>()[\]"'`]+/g

/**
 * Positive requirements only.
 *
 * "never X" reads correctly as a requirement. "do not X" / "don't X" must NOT be
 * captured here: naively taking the object of a negation produces nonsense like
 * "The user requires: verify it against the repo" from "do not verify it against
 * the repo", which inverts the meaning.
 */
const REQUIREMENT =
  /\b(always|never|must|should|make sure to|remember to)\b[\s:]+([^.?!\n]{4,160})/gi

/**
 * "<subject> is <value>".
 *
 * The value must NOT stop at the first `.`: that truncates
 * `internal-hbr-2291.pineapple.example` to `internal-hbr-2291` and then poisons
 * recall with the broken value. Stop at a period only when it ends a sentence.
 */
const ASSIGNMENT = /\b([A-Za-z][\w ()-]{2,60}?)\s+(?:is|are)\s+([^\n?!]{3,200})/g

const CODEISH = /[A-Z0-9_./:-]/

const looksLikeValue = (value: string): boolean => {
  const trimmed = value.trim()
  if (trimmed.length < 3 || trimmed.length > 200) return false
  if (/^(not|nothing|unclear|unknown|the same|that|this|it)\b/i.test(trimmed)) return false
  return CODEISH.test(trimmed)
}

/** Cut a captured clause back to its first complete sentence. */
const firstSentence = (value: string): string => {
  const match = /\.(?=\s+[A-Z(])/.exec(value)
  return match ? value.slice(0, match.index) : value
}

const tidy = (value: string): string =>
  firstSentence(value)
    .replace(/\s+/g, " ")
    .replace(/^(?:that|the|a|an|it|this)\s+/i, "")
    .replace(/[,;:\s.。]+$/, "")
    .trim()

export interface DeterministicMemory {
  readonly content: string
  readonly domains: Array<string>
}

/**
 * Extract statements the user made that are worth remembering, without a model.
 */
export const extractDeterministic = (userMessage: string): Array<DeterministicMemory> => {
  const out: Array<DeterministicMemory> = []
  const push = (content: string): void => {
    const cleaned = tidy(content)
    if (cleaned.length < 8 || cleaned.length > 300) return
    if (/^(yes|no|ok|okay|sure|thanks|thank you|got it|noted)\b/i.test(cleaned)) return
    if (out.some((existing) => existing.content.toLowerCase() === cleaned.toLowerCase())) return
    out.push({ content: cleaned, domains: [] })
  }

  // 1. URLs are unambiguous.
  for (const match of userMessage.match(URL) ?? []) {
    push(`User-provided URL: ${match}`)
  }

  // 2. Stated requirements, kept in the user's own words.
  //    Paraphrasing flipped meaning once: "Never force push" became
  //    "The user requires: force push" — the exact opposite instruction.
  for (const match of userMessage.matchAll(REQUIREMENT)) {
    const verb = (match[1] ?? "").toLowerCase()
    const body = tidy(match[2] ?? "")
    if (!body) continue
    push(`User requirement (${verb}): ${body}`)
  }

  // 3. "X is Y" where Y is identifier-shaped.
  for (const match of userMessage.matchAll(ASSIGNMENT)) {
    const subject = tidy(match[1] ?? "")
    const value = tidy(match[2] ?? "")
    if (!subject || !looksLikeValue(value)) continue
    push(`${subject} is ${value}`)
  }

  // The three passes overlap: "Always run the canary pipeline for staging" gets
  // caught as a requirement *and* as an assignment, and the assignment copy is
  // truncated mid-value. Two rows for one sentence is noise the engine then has
  // to reconcile later, so the contained one is dropped here instead.
  const deduped = out.filter(
    (candidate, index) =>
      !out.some((other, otherIndex) => {
        if (otherIndex === index) return false
        if (other.content.length <= candidate.content.length) return false
        return isCoveredBy(candidate.content, other.content)
      })
  )

  return deduped.slice(0, 6)
}

/**
 * Whether everything worth keeping in `narrow` is already in `wide`.
 *
 * Compared on the tokens that carry a fact's identity, so dropping a number or a
 * qualifier counts as loss even when the wording differs.
 */
const isCoveredBy = (narrow: string, wide: string): boolean => {
  const have = new Set(wide.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 4))
  const covered = narrow
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4)
  return covered.length > 0 && covered.every((word) => have.has(word))
}
