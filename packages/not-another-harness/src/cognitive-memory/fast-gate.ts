/**
 * Fast Heuristic Gate
 * 
 * Synchronous, sub-5ms gate running on the critical path before model invocation.
 * Detects explicit user corrections/contradictions and significant domain pivots
 * without triggering an LLM call.
 */

export interface FastGateResult {
  action: "proceed" | "inject_caution";
  cautionNote?: string;
  detectedDomains?: string[];
}

const CONTRADICTION_PATTERNS = [
  /actually,?\s+(?:we|i)\s+(?:switched|changed|moved|migrated|replaced|use|want|have)/i,
  /that(?:'s|\s+is)\s+(?:wrong|incorrect|outdated|false|not\s+right|no\s+longer)/i,
  /no,?\s+(?:it(?:'s|\s+is)|we\s+use|we\s+switched|it\s+should\s+be|don(?:'t|\s+not)\s+use)/i,
  /stop\s+using\s+/i,
  /instead\s+of\s+/i,
  /disregard\s+(?:prior|previous|what\s+i\s+said)/i,
];

const DOMAIN_KEYWORDS: Record<string, RegExp[]> = {
  auth: [/auth/i, /login/i, /session/i, /jwt/i, /oauth/i, /token/i, /password/i, /permission/i],
  database: [/postgres/i, /sqlite/i, /sql/i, /schema/i, /migration/i, /prisma/i, /drizzle/i, /mongo/i, /redis/i],
  frontend: [/css/i, /tailwind/i, /component/i, /jsx/i, /tsx/i, /layout/i, /ui/i, /render/i, /html/i],
  build: [/vite/i, /webpack/i, /turbo/i, /tsconfig/i, /pnpm/i, /package\.json/i, /bundle/i],
  api: [/rest/i, /graphql/i, /endpoint/i, /route/i, /fetch/i, /request/i, /response/i],
  git: [/branch/i, /commit/i, /merge/i, /rebase/i, /worktree/i, /conflict/i],
};

export const runFastGate = (userMessage: string): FastGateResult => {
  if (!userMessage || userMessage.trim().length === 0) {
    return { action: "proceed" };
  }

  // 1. Check for explicit contradiction signals
  for (const pattern of CONTRADICTION_PATTERNS) {
    if (pattern.test(userMessage)) {
      return {
        action: "inject_caution",
        cautionNote: "User appears to be explicitly correcting a prior premise or configuration. Verify current facts before proceeding with assumptions.",
        detectedDomains: extractDomains(userMessage),
      };
    }
  }

  return {
    action: "proceed",
    detectedDomains: extractDomains(userMessage),
  };
};

export const extractDomains = (text: string): string[] => {
  const matched: string[] = [];
  for (const [domain, patterns] of Object.entries(DOMAIN_KEYWORDS)) {
    if (patterns.some((p) => p.test(text))) {
      matched.push(domain);
    }
  }
  return matched;
};
