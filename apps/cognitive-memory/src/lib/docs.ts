/**
 * The documentation map.
 *
 * One list, read by the sidebar, the previous/next pager, and the card grid on
 * the overview. It is the only place a page is named, so adding a page means
 * adding a route and one entry here — a sidebar that is maintained by hand
 * drifts from the routes within a week, and the drift is invisible until
 * someone clicks a 404.
 *
 * Order within a group is reading order, and the flattened order is what the
 * pager walks. Groups are ordered by when the question gets asked: what is this,
 * how do I run it, then how does it think, then the exact calls.
 */

export interface DocPage {
  /** The route. Also the identity used for active state and for prev/next. */
  readonly href: string
  readonly title: string
  /** One line, used in the sidebar on wide screens and on the overview grid. */
  readonly summary: string
  /**
   * The words a reader would type to find this, when they are not the title.
   *
   * Search matches on these as well as the title and summary, so this is where
   * "budget", "env vars", "401" and "prior" go — the vocabulary of the problem
   * rather than of the page. Kept here, next to the page it points at, because
   * a keyword list in a separate file is a keyword list nobody maintains.
   */
  readonly keywords: readonly string[]
}

export interface DocGroup {
  readonly label: string
  readonly pages: readonly DocPage[]
}

export const DOC_GROUPS: readonly DocGroup[] = [
  {
    label: "Get started",
    pages: [
      {
        href: "/docs",
        title: "Overview",
        summary: "What the service is for, and the three gaps it exists to close.",
        keywords: [
          "overview",
          "start",
          "introduction",
          "why",
          "pricing",
          "cost",
          "tokens",
          "measured",
        ]
      },
      {
        href: "/docs/quickstart",
        title: "Quickstart",
        summary: "Mint a key, wire two calls, and have memory working in a turn.",
        keywords: [
          "install",
          "setup",
          "first turn",
          "npm",
          "pnpm",
          "cogmem",
          "createClient",
          "runTurn",
          "two calls",
          "begin",
          "hello world"
        ]
      },
      {
        href: "/docs/integrating",
        title: "Integrating with an agent",
        summary: "The complete loop: context in, model, learning out, and what to do when memory is down.",
        keywords: [
          "agent loop",
          "integration",
          "wire up",
          "production",
          "error handling",
          "retry",
          "testing",
          "mock",
          "framework",
          "ai sdk",
          "seed",
          "recallOrExplain",
          "seedMemories",
          "outcomes",
          "resilience",
          "idempotent"
        ]
      },
      {
        href: "/docs/self-hosting",
        title: "Self-hosting",
        summary: "Run it yourself: configuration, budgets, and the operations scripts.",
        keywords: [
          "env",
          "environment variables",
          "config",
          "configuration",
          "deploy",
          "docker",
          "sqlite",
          "migration",
          "drizzle",
          "budgets",
          "self host",
          "production",
          "BETTER_AUTH_SECRET",
        ]
      }
    ]
  },
  {
    label: "How it works",
    pages: [
      {
        href: "/docs/model",
        title: "The model",
        summary: "Why a list of strings and a similarity search fails in production.",
        keywords: [
          "why",
          "design",
          "rationale",
          "similarity search",
          "vector",
          "embeddings",
          "context rot",
          "flat list",
          "background",
        ]
      },
      {
        href: "/docs/tiers",
        title: "Four tiers",
        summary: "L0 through L3, and what each one costs per turn.",
        keywords: [
          "tier",
          "L0",
          "L1",
          "L2",
          "L3",
          "hot cache",
          "pinned",
          "promote",
          "budget",
          "truncated",
          "cost per turn",
        ]
      },
      {
        href: "/docs/capture",
        title: "What gets learned",
        summary: "The capture rules, and the three things always refused.",
        keywords: [
          "learn",
          "learning",
          "extract",
          "extraction",
          "rules",
          "patterns",
          "url",
          "regex",
          "question turn",
          "rejected",
          "skip",
        ]
      },
      {
        href: "/docs/reconciliation",
        title: "Reconciliation",
        summary: "How a restatement is folded in, and the one rule that governs merges.",
        keywords: [
          "merge",
          "duplicate",
          "restatement",
          "dedupe",
          "ADD MERGE REPLACE REJECT",
          "distinctive tokens",
          "lossy",
        ]
      },
      {
        href: "/docs/injection",
        title: "What goes into the prompt",
        summary: "The four injection reasons and the deterministic trigger.",
        keywords: [
          "injection",
          "prompt",
          "context",
          "block",
          "index",
          "trigger",
          "guardrail",
          "tension",
          "tokens",
          "system prompt",
          "reasons",
        ]
      },
      {
        href: "/docs/recall",
        title: "Recall",
        summary: "Token-overlap ranking, and why there is no model in the path.",
        keywords: [
          "recall",
          "search",
          "query",
          "ranking",
          "token overlap",
          "relevance",
          "empty",
          "similarity",
          "top k",
        ]
      },
      {
        href: "/docs/tensions",
        title: "Contradictions",
        summary: "Two claims that cannot both be true, held open until answered.",
        keywords: [
          "contradiction",
          "tension",
          "conflict",
          "disagree",
          "resolve",
          "critical",
          "unresolved",
        ]
      },
      {
        href: "/docs/self-model",
        title: "The self-model",
        summary: "Reliability per domain, and why the average carries a prior.",
        keywords: [
          "self model",
          "reliability",
          "domain",
          "outcome",
          "weak domains",
          "guardrail",
          "prior",
          "75%",
          "score",
          "calibration",
        ]
      }
    ]
  },
  {
    label: "Reference",
    pages: [
      {
        href: "/docs/api",
        title: "API",
        summary: "Every endpoint, the scope it needs, and how errors are tagged.",
        keywords: [
          "api",
          "reference",
          "endpoints",
          "http",
          "rest",
          "curl",
          "status codes",
          "errors",
          "401",
          "403",
          "404",
          "500",
          "scopes",
          "health",
          "request",
          "response",
        ]
      },
      {
        href: "/docs/sdk",
        title: "SDK",
        summary: "The client, the turn helper, and the in-process deterministic layer.",
        keywords: [
          "sdk",
          "client",
          "npm package",
          "typescript",
          "types",
          "cogmem",
          "helper",
          "runTurn",
          "recallOrExplain",
          "seedMemories",
          "errors",
          "config",
          "baseUrl",
          "tree shaking",
          "in-process",
        ]
      },
      {
        href: "/docs/dashboard",
        title: "Dashboard",
        summary: "The ten pages, and which two turn a vague feeling into a fix.",
        keywords: [
          "dashboard",
          "ui",
          "context preview",
          "activity",
          "analytics",
          "library",
          "settings",
          "keys",
          "ten pages",
        ]
      },
      {
        href: "/docs/auth",
        title: "Credentials",
        summary: "Sessions and API keys, and why the separation is the security model.",
        keywords: [
          "auth",
          "authentication",
          "api key",
          "bearer",
          "session",
          "scope",
          "rotate",
          "revoke",
          "sha256",
          "hash",
          "credential",
          "security",
          "cmi_",
        ]
      }
    ]
  }
]

/** Reading order across every group. The pager walks exactly this. */
export const DOC_PAGES: readonly DocPage[] = DOC_GROUPS.flatMap((group) => group.pages)

/** The page a sidebar entry points at, or undefined for an unknown route. */
export function findDocPage(href: string): DocPage | undefined {
  return DOC_PAGES.find((page) => page.href === href)
}

/**
 * The group a page belongs to, so a page can label itself without restating the
 * group name — the alternative is a heading that quietly goes stale when a page
 * is moved between groups.
 */
export function docGroupOf(href: string): DocGroup | undefined {
  return DOC_GROUPS.find((group) => group.pages.some((page) => page.href === href))
}

/**
 * The pages either side of this one, for the pager.
 *
 * Ends are real: the first page has no previous and the last has no next, which
 * is more honest than links to the overview that mean nothing.
 */
export function docNeighbours(
  href: string
): { readonly previous?: DocPage; readonly next?: DocPage } {
  const index = DOC_PAGES.findIndex((page) => page.href === href)
  if (index === -1) return {}
  return {
    previous: index > 0 ? DOC_PAGES[index - 1] : undefined,
    next: index < DOC_PAGES.length - 1 ? DOC_PAGES[index + 1] : undefined
  }
}
