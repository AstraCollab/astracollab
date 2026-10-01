/**
 * Deterministic relevance and reconciliation primitives.
 *
 * Ported from the harness's cognitive memory so that a recall here ranks the
 * same way, and a merge decision here is made for the same reasons. The
 * reasoning behind the thresholds is preserved because the numbers are only
 * defensible with it:
 *
 * - A memory cannot be found by a model being smart, only by words overlapping.
 * - Lexical overlap peaks on identical strings and bottoms out on the
 *   paraphrases that actually add information, so the *recall* floor is low and
 *   a separate step decides what to do with what came back.
 * - Losing a fact is permanent; an extra duplicate costs one row. Every
 *   threshold below leans that way.
 */

const STOP_WORDS = new Set([
  "the", "and", "for", "this", "that", "with", "from", "you", "are", "was", "has", "have",
  "what", "which", "when", "were", "will", "your", "our", "its", "not", "but", "all", "any",
  "can", "did", "does", "how", "into", "out", "use", "used", "using", "one", "two", "get",
  "new", "now", "then", "than", "them", "they", "his", "her", "she", "him", "been", "being",
  "there", "here", "also", "just", "like", "make", "made", "need", "want", "about", "after",
  "tell", "know", "give", "show", "please", "would", "could", "should", "shall"
])

/** Words that appear in every restatement of a fact and so carry no identity. */
const FILLER_TOKENS = new Set([
  "this", "that", "these", "those", "there", "here", "with", "from", "into", "must",
  "should", "always", "never", "under", "over", "about", "after", "before", "when",
  "where", "which", "what", "your", "their", "them", "they", "then", "than", "also",
  "just", "only", "each", "every", "some", "such", "very", "more", "most", "same",
  "file", "files", "name", "names", "project", "repository", "repo", "note"
])

/** Content words worth matching a memory against. */
export const relevanceTokens = (value: string): Set<string> =>
  new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3 && !STOP_WORDS.has(word))
  )

/** Overlap of two token sets, normalised by the smaller side. */
export const overlapScore = (query: Set<string>, candidate: Set<string>): number => {
  if (query.size === 0 || candidate.size === 0) return 0
  let shared = 0
  for (const word of query) if (candidate.has(word)) shared += 1
  return shared / Math.min(query.size, candidate.size)
}

/**
 * Floor for *candidate* recall, not a similarity decision.
 *
 * Deliberately low. This only decides who gets adjudicated; a tight gate misses
 * exactly the paraphrases worth merging.
 */
export const CANDIDATE_FLOOR = 0.3

/** Above this, a memory is worth promoting into the pre-staged index. */
export const PROMOTE_THRESHOLD = 0.12

/** How many existing memories to put in front of an adjudicator. */
export const MAX_CANDIDATES = 8

/** Two results this similar are the same memory, restated. */
export const COLLAPSE_THRESHOLD = 0.8

/**
 * Tokens that carry a fact's identity: identifiers, numbers, codes.
 *
 * Function words and generic nouns are dropped because they recur in every
 * restatement and hide real differences.
 */
export const distinctiveTokens = (value: string): Set<string> =>
  new Set(
    value
      .toLowerCase()
      .replace(/['']/g, "")
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .filter((w) => /\d/.test(w) || w.length >= 4)
      .filter((w) => !FILLER_TOKENS.has(w))
  )

/**
 * Whether rewriting `original` as `replacement` would drop information.
 *
 * Distinctive tokens carry a fact's identity, so a replacement missing one has
 * deleted something — usually the qualifier that made the two statements differ
 * at all ("never production", a build id, a port). Trailing plurals are folded
 * so "deploys" merging into "deploy" is not read as a deletion.
 *
 * Biased towards reporting a loss: a false positive costs a duplicate entry,
 * which is recoverable, while a false negative deletes a fact for good.
 */
export const isLossyRewrite = (original: string, replacement: string): boolean => {
  const fold = (tokens: Set<string>): Set<string> =>
    new Set([...tokens].map((t) => (t.length >= 4 && t.endsWith("s") ? t.slice(0, -1) : t)))
  const after = fold(distinctiveTokens(replacement))
  for (const token of fold(distinctiveTokens(original))) {
    if (!after.has(token)) return true
  }
  return false
}

/**
 * Dotted names that are not prose: hostnames, package names, file names.
 *
 * `internal-hbr-2291.pineapple.example` is precisely the kind of value a user
 * names and a memory holds, and without this the identifier patterns below missed
 * it — the trigger silently never fired for a host, which is one of the cases it
 * exists for. The last label must be alphabetic, which is what keeps version
 * strings and abbreviations out; a short stoplist covers the rest.
 */
const HOSTNAME = /\b[a-z0-9][a-z0-9-]{1,}(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi

/** Dotted tokens that are ordinary writing, not names. */
const NOT_A_HOSTNAME = new Set([
  "eg", "ie", "etc", "vs", "approx", "inc", "ltd", "corp", "dept", "est", "fig", "no", "al"
])

/**
 * Identifiers worth matching a memory against: URLs, paths, hostnames,
 * SCREAMING_SNAKE, camelCase, long kebab-case and hex-ish codes.
 *
 * The same idea as Aider's `mentioned_idents`: a user naming a concrete thing
 * is a much stronger signal than the words around it. This is what turns a
 * recall into a full-body injection without asking a model.
 */
export const extractIdentifiers = (text: string): string[] => {
  const found = new Set<string>()
  for (const match of text.match(/\bhttps?:\/\/[^\s<>()[\]"'`]+/g) ?? []) found.add(match)
  for (const match of text.match(HOSTNAME) ?? []) {
    if (NOT_A_HOSTNAME.has(match.toLowerCase())) continue
    found.add(match)
  }
  for (const match of text.match(/\b(?:\.{0,2}\/)?[\w-]+(?:\/[\w.-]+)+\/?/g) ?? []) {
    if (match.length > 3) found.add(match)
  }
  for (const match of text.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? []) found.add(match)
  for (const match of text.match(/\b[A-Z]{2,}[0-9][A-Z0-9-]*\b/g) ?? []) found.add(match)
  for (const match of text.match(/\b[a-z]+(?:[A-Z][a-z0-9]+){1,}\b/g) ?? []) found.add(match)
  for (const match of text.match(/\b[a-z]+(?:-[a-z0-9]+){2,}\b/g) ?? []) found.add(match)
  for (const match of text.match(/\b[0-9a-f]{6,}\b/gi) ?? []) found.add(match)
  return [...found]
}

/**
 * Instructions about *this conversation* rather than durable facts about the
 * project.
 *
 * "Do not verify the staging build against the repository" and "just remember
 * this" describe how to behave right now, so storing them produces noise that
 * later looks like a project constraint.
 *
 * Explicit patterns rather than a "is this specific enough?" heuristic, because
 * over-filtering would silently lose real memories, which is the worse failure.
 */
const INTERACTION_SCOPED = [
  /\b(?:do not|don'?t|never|no need to)\s+(?:verify|check|confirm|look\s?up|search|investigate|browse|resolve)\b/i,
  /\bjust\s+(?:remember|note|acknowledge|retain|treat)\b/i,
  /\b(?:held|noted|stored|remembered)\s+(?:in|for)\s+(?:this|the)\s+conversation\b/i,
  /\bnot\s+verified\b/i,
  /\bwithout\s+verifying\b/i,
  /\bfor\s+this\s+(?:conversation|session|turn|reply|response)\s+only\b/i,
  /^(?:ok|okay|noted|got it|sure|thanks)\b[.!]?$/i
]

export const isInteractionScoped = (content: string): boolean =>
  INTERACTION_SCOPED.some((pattern) => pattern.test(content))

/** Similarity of two statements by the tokens that carry identity. */
export const similarity = (a: string, b: string): number => {
  const left = distinctiveTokens(a)
  const right = distinctiveTokens(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const word of left) if (right.has(word)) shared += 1
  return shared / Math.min(left.size, right.size)
}

export const normalise = (value: string): string => value.trim().toLowerCase()
