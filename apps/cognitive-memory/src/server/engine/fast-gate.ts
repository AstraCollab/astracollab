/**
 * The fast gate: a synchronous contradiction check that runs before anything
 * else decides what an agent should be told.
 *
 * Sub-millisecond and model-free by design. It sits on the critical path of a
 * prompt build, so it cannot afford a network call, and its job is small
 * enough that heuristics are the honest choice: catch a user who is visibly
 * correcting a premise, and name the domains the message is about.
 */

export interface FastGateResult {
  readonly action: "proceed" | "inject_caution"
  readonly cautionNote?: string
  readonly detectedDomains: Array<string>
}

const CONTRADICTION_PATTERNS = [
  /actually,?\s+(?:we|i)\s+(?:switched|changed|moved|migrated|replaced|use|want|have)/i,
  /that(?:'s|\s+is)\s+(?:wrong|incorrect|outdated|false|not\s+right|no\s+longer)/i,
  /no,?\s+(?:it(?:'s|\s+is)|we\s+use|we\s+switched|it\s+should\s+be|don(?:'t|\s+not)\s+use)/i,
  /stop\s+using\s+/i,
  /instead\s+of\s+/i,
  /disregard\s+(?:prior|previous|what\s+i\s+said)/i
]

const DOMAIN_KEYWORDS: Record<string, Array<RegExp>> = {
  auth: [/auth/i, /login/i, /session/i, /jwt/i, /oauth/i, /token/i, /password/i, /permission/i],
  database: [/postgres/i, /sqlite/i, /sql/i, /schema/i, /migration/i, /prisma/i, /drizzle/i, /mongo/i, /redis/i],
  frontend: [/css/i, /tailwind/i, /component/i, /jsx/i, /tsx/i, /layout/i, /ui/i, /render/i, /html/i],
  build: [/vite/i, /webpack/i, /turbo/i, /tsconfig/i, /pnpm/i, /package\.json/i, /bundle/i],
  api: [/rest/i, /graphql/i, /endpoint/i, /route/i, /fetch/i, /request/i, /response/i],
  git: [/branch/i, /commit/i, /merge/i, /rebase/i, /worktree/i, /conflict/i]
}

export const extractDomains = (text: string): Array<string> => {
  const matched: Array<string> = []
  for (const [domain, patterns] of Object.entries(DOMAIN_KEYWORDS)) {
    if (patterns.some((pattern) => pattern.test(text))) matched.push(domain)
  }
  return matched
}

export const runFastGate = (userMessage: string): FastGateResult => {
  if (!userMessage || userMessage.trim().length === 0) {
    return { action: "proceed", detectedDomains: [] }
  }

  for (const pattern of CONTRADICTION_PATTERNS) {
    if (pattern.test(userMessage)) {
      return {
        action: "inject_caution",
        cautionNote:
          "User appears to be explicitly correcting a prior premise or configuration. " +
          "Verify current facts before proceeding with assumptions.",
        detectedDomains: extractDomains(userMessage)
      }
    }
  }

  return { action: "proceed", detectedDomains: extractDomains(userMessage) }
}
