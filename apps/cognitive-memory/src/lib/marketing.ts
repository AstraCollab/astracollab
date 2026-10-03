/**
 * The marketing site: its map, and its content.
 *
 * Two jobs, one file, because they rot together. The nav is read by the header,
 * the footer and the overview card grid; the content is read by the pages. A
 * landing page that has been split into four pages is exactly the shape where the
 * same tier table ends up written down twice and drifts.
 *
 * Everything here is data rather than JSX so a page is a layout. That also means
 * the numbers in the marketing copy and the numbers in `scripts/measure.ts` are
 * side by side in one file, which is what makes it obvious when one of them
 * needs re-measuring.
 */

export interface MarketingPage {
  readonly href: string
  readonly title: string
  readonly summary: string
}

export const MARKETING_PAGES: readonly MarketingPage[] = [
  {
    href: "/",
    title: "Overview",
    summary: "Every line comes with a reason and a price."
  },
  {
    href: "/how-it-works",
    title: "How it works",
    summary: "Five steps from a statement to a bounded prompt block."
  },
  {
    href: "/tiers",
    title: "Tiers & cost",
    summary: "What a memory costs per turn, and why the ceiling is a decision."
  },
  {
    href: "/use-cases",
    title: "Use cases",
    summary: "Coding agents, support, research, and everything else."
  },
  {
    href: "/faq",
    title: "Questions",
    summary: "The ones worth answering honestly, including the hard three."
  }
]

/**
 * The reference.
 *
 * Not a marketing page, and deliberately not in `MARKETING_PAGES` — that list is
 * the map of the pages that sell the thing, and the reference is where all of
 * them stop making arguments and start answering questions. Kept separate so
 * adding it here cannot quietly add it to the nav.
 */
export const REFERENCE: MarketingPage = {
  href: "/docs",
  title: "Reference",
  summary:
    "Every endpoint, the SDK, and the reasoning behind each default. The four pages above are the argument; this is where you check it."
}

/* -------------------------------------------------------------------------- */
/* Content                                                                    */
/* -------------------------------------------------------------------------- */

export interface Tier {
  readonly tier: string
  readonly name: string
  readonly holds: string
  readonly cost: string
  readonly when: string
}

export const TIERS: readonly Tier[] = [
  {
    tier: "L0",
    name: "Pinned",
    holds: "Unresolved contradictions, per-domain reliability, and any correction caught in the message being answered.",
    cost: "Full body, every turn",
    when: "When the agent must not guess, or must be careful in a domain it has been failing in."
  },
  {
    tier: "L1",
    name: "Hot cache",
    holds: "Facts pre-staged for the work in front of it. A new fact lands here immediately.",
    cost: "One index line, plus a body when a trigger fires",
    when: "Default home for everything you tell the service."
  },
  {
    tier: "L2",
    name: "Warm store",
    holds: "Indexed candidates, scored against each turn and promoted if they earn it.",
    cost: "Nothing until promoted",
    when: "Facts that are true but not currently relevant."
  },
  {
    tier: "L3",
    name: "Cold archive",
    holds: "Everything else, still searchable, still recallable on demand.",
    cost: "Nothing until recalled",
    when: "History. Retrieved by a question, never by the context builder."
  }
]

export interface InjectionReason {
  readonly reason: string
  readonly included: string
  readonly why: string
}

export const REASONS: readonly InjectionReason[] = [
  {
    reason: "index",
    included: "A single gist line.",
    why: "The default, and what almost every memory costs. 200 memories index for ~1.3k tokens."
  },
  {
    reason: "trigger",
    included: "The full body.",
    why: "You named something concrete the transcript does not already contain — a build id, a host, a path — and a memory mentions it. No model decides this."
  },
  {
    reason: "tension",
    included: "The full body.",
    why: "Two stored claims contradict each other. A contradiction is a question to ask, not trivia to skim."
  },
  {
    reason: "guardrail",
    included: "The full body.",
    why: "A domain this agent has been measurably unreliable in."
  },
  {
    reason: "—",
    included: "Nothing.",
    why: "Above the index budget. The report says so rather than quietly dropping the tail."
  }
]

export interface LoopStep {
  readonly n: string
  readonly title: string
  readonly body: string
  /** The documentation page that goes deeper on this step. */
  readonly href: string
  readonly hrefLabel: string
}

export const STEPS: readonly LoopStep[] = [
  {
    n: "01",
    title: "Capture",
    body: "Deterministic patterns first: URLs, assignments, stated requirements. No model, no refusal, no silent loss.",
    href: "/docs/capture",
    hrefLabel: "What gets learned"
  },
  {
    n: "02",
    title: "Reconcile",
    body: "Restatements are folded into what is held. A merge that would drop a qualifier is refused and both are kept.",
    href: "/docs/reconciliation",
    hrefLabel: "Reconciliation"
  },
  {
    n: "03",
    title: "File",
    body: "Into one of four tiers. New facts land hot so the next prompt already knows them.",
    href: "/docs/tiers",
    hrefLabel: "Four tiers"
  },
  {
    n: "04",
    title: "Plan",
    body: "Build the block: a gist line for everything, a full body only for triggers, contradictions and weak domains.",
    href: "/docs/injection",
    hrefLabel: "What goes into the prompt"
  },
  {
    n: "05",
    title: "Inject",
    body: "Into the system prompt, inside a token budget that reports when it truncated.",
    href: "/docs/api",
    hrefLabel: "The API"
  }
]

export interface Capability {
  readonly title: string
  readonly body: string
  readonly aside: string
}

export const CAPABILITIES: readonly Capability[] = [
  {
    title: "Every line has a reason attached",
    body: "A gist line for everything held, a full body only for an identifier you named, a contradiction, or a domain the agent has been unreliable in. The rule that selected each line is stored with it, so a bad prompt is a thing you can read rather than a thing you can only feel.",
    aside: "There is no published benchmark for pre-inject versus on-demand retrieval, so the honest way to tune the tradeoff is to watch it happen."
  },
  {
    title: "The window stays yours",
    body: "A similarity search returns k results, and k is whatever the caller passed. Here the per-turn budget is a setting, and a full body is spent only where something concrete earned it — so what your agent reads does not grow with everything you have ever told it.",
    aside: "When the ceiling bites, the report says truncated: true. It does not quietly drop the tail and let you assume the rest was irrelevant."
  },
  {
    title: "A disagreement is a record, not a coin toss",
    body: "Two claims that cannot both be true are stored as a pair, with the question that would settle it, and pinned into every prompt until somebody answers. Nothing is silently reconciled away, and no model is asked to adjudicate.",
    aside: "A list of strings has nowhere to put “these disagree”. It stores both, or it quietly drops one — and the agent cannot tell you which happened."
  },
  {
    title: "Nothing lands without a reason",
    body: "A rejection comes back with the reason it was rejected, so a client that sent ten statements and got three back is told which seven did not land. Corrections in the incoming message are caught synchronously and a recall that matches nothing returns empty rather than a plausible guess.",
    aside: "Deterministic extraction runs first, so a plainly-stated fact is learned even with no model configured at all."
  }
]

export interface Stat {
  readonly value: string
  readonly label: string
  readonly detail: string
}

export const STATS: readonly Stat[] = [
  {
    value: "5.0 ms",
    label: "recall p50",
    detail: "Deterministic ranked lookup over 200 stored memories. No model in the path, so it does not move when a provider does."
  },
  {
    value: "2.9 ms",
    label: "context build p50",
    detail: "The whole prompt block — index lines, triggered bodies, contradictions and weak domains — assembled before the model is called."
  },
  {
    value: "77%",
    label: "fewer tokens",
    detail: "Indexing 200 memories costs 1.3k tokens. Injecting all 200 bodies costs 3.6k. Bodies are spent only where something earned them."
  },
  {
    value: "0",
    label: "models required",
    detail: "Deterministic extraction runs first. A deployment with no model key still learns plainly-stated facts."
  }
]

export interface UseCase {
  readonly title: string
  readonly body: string
  /** What this kind of agent tends to store. */
  readonly holds: string
  /** What the tiering buys it specifically. */
  readonly gain: string
}

export const USE_CASES: readonly UseCase[] = [
  {
    title: "Coding agents",
    body: "Hold the build id, the deploy command, the naming convention, the thing that broke last month. Get them back in the one line that matters.",
    holds: "Build ids, hosts, paths, conventions, deploy commands",
    gain: "The window stays free for the diff, because a fact you did not name costs a line and not a body."
  },
  {
    title: "Support agents",
    body: "Remember what this customer was told, what was actually true, and which of the two is now contradicted.",
    holds: "What was said, what was true, ticket-level commitments",
    gain: "A correction is pinned into the next prompt, so the agent does not repeat a promise that was withdrawn."
  },
  {
    title: "Research assistants",
    body: "Keep a running set of findings and the open questions, with disagreements surfaced rather than averaged away.",
    holds: "Findings, sources, open questions, superseded claims",
    gain: "Two sources that disagree surface as a question instead of one of them quietly winning."
  },
  {
    title: "Internal assistants",
    body: "Company facts with a source, an owner, and a date — and a running record of which topics the assistant is weak on.",
    holds: "Runbooks, ownership, policy, tribal knowledge",
    gain: "A domain the assistant keeps failing in gets a guardrail in every prompt until it earns its way back."
  },
  {
    title: "Long-running work",
    body: "A service the agent can call for the hundredth session. Memory survives deploys, restarts, and model swaps.",
    holds: "Everything learned, across sessions and agents",
    gain: "It is a service, not a file in the repo — so it is queryable, revocable, and per-tenant."
  },
  {
    title: "Multi-tenant products",
    body: "Memory as a credentialed storage layer: your own database, your own keys, revocable per integration.",
    holds: "Per-organisation facts, isolated by key",
    gain: "Every read is filtered by organisation in one auditable place, so the boundary is a single check."
  }
]

export interface Faq {
  readonly q: string
  readonly a: string
  /** Whether this is one of the three that decide the fit. */
  readonly decisive?: boolean
}

export const FAQ: readonly Faq[] = [
  {
    q: "How do I know what memory is costing me?",
    a: "Every context build returns the entries that produced it, each with the rule that selected it — index, trigger, tension, guardrail — and its token cost, plus the total and whether the budget truncated. Analytics splits the spend by that same reason, which is the difference between “memory is expensive” and a number you can act on: a build spending its whole budget on index lines and no bodies is a store with nothing worth promoting, not a budget that needs raising.",
    decisive: true
  },
  {
    q: "Is this a vector database with extra steps?",
    a: "No, and the difference is load-bearing. Ranking here is deterministic token overlap with identifier matching, so recall behaves identically on every run and on every model, and you can name the terms that matched. A semantic index earns its keep on fuzzy paraphrase over very large corpora; for the register an agent actually stores — URLs, build ids, ports, conventions — exact tokens are both faster and more precise.",
    decisive: true
  },
  {
    q: "Do I need a model configured?",
    a: "No. Deterministic pattern extraction runs first, so a plainly-stated fact is captured even with no provider configured at all — health reports `extractor: rules-only` so you know which mode you are in. Add a key and turns are also summarised and contradictions are detected, with a typed output contract validated by the effect/ai layer rather than by parsing prose.",
    decisive: true
  },
  {
    q: "What happens when two stored facts contradict each other?",
    a: "They are kept. A contradiction is stored as a pair of claims plus the question that would settle it, and it is pinned into every context build until it is resolved — so the agent sees both sides and the question rather than whichever one happened to be stored first. Resolving one keeps the resolution and the pattern it revealed, because deleting it just means rediscovering the same contradiction next month."
  },
  {
    q: "What happens when the agent is wrong?",
    a: "Nothing is treated as gospel. A restatement is folded into what is already held only when the merge keeps every distinctive token, so a qualifier like 'never production' cannot be quietly dropped. When a rewrite would lose information the service keeps both instead, because a duplicate costs one row and a lost fact is gone for good."
  },
  {
    q: "How do I stop it storing junk?",
    a: "Three ways. Interaction-scoped instructions are rejected with a reason. Questions are treated as lookups rather than lessons, so a recall turn does not store the assistant’s own answer back. And the store is tenant-scoped with a real delete: PATCH the tier to correct cheaply, DELETE when a stored fact is wrong enough that keeping it would keep poisoning recall."
  },
  {
    q: "How is this different from a markdown file in the repo?",
    a: "A file is read in full on every turn, so its cost grows with everything you have ever learned — and an agent has to be trusted to maintain it. Here the store is tiered and budgeted, so the per-turn cost is bounded, the contents are queryable, contradictions and weak domains are represented rather than flattened into prose, and the agent never authors its own memory."
  },
  {
    q: "Who can read my memory?",
    a: "Only the organisation the key belongs to. Keys are opaque, scoped, individually revocable, and stored as a hash — the secret is shown once. Minting a key requires a signed-in session rather than an existing key, so a leaked agent credential cannot escalate itself, and every read is filtered by organisation id in one auditable place."
  },
  {
    q: "Where does the data live?",
    a: "In your SQLite file, or your PostgreSQL-compatible deployment of it. There is no telemetry about your memory content, and the service is a single process with a single database file — which is the point: you can read every byte your agent has been told."
  }
]

/** The itemised `/v1/context` receipt, shown on the overview. */
export interface ReceiptLine {
  readonly id: string
  readonly tier: string
  readonly reason: string
  readonly gist: string
  readonly why: string
  readonly tokens: number
}

export const RECEIPT: readonly ReceiptLine[] = [
  {
    id: "mem_7f2a",
    tier: "L1",
    reason: "index",
    gist: "staging build ID is ZQ7X4M2K",
    why: "One line. Nothing in the message asked for it.",
    tokens: 11
  },
  {
    id: "mem_1c84",
    tier: "L1",
    reason: "index",
    gist: "files are named in kebab-case",
    why: "One line. Held since the last session.",
    tokens: 9
  },
  {
    id: "mem_9b03",
    tier: "L3",
    reason: "trigger",
    gist: "internal staging host is internal-hbr-2291.example",
    why: "Full body. The message named a host not in the transcript.",
    tokens: 41
  },
  {
    id: "ten_44e1",
    tier: "L0",
    reason: "tension",
    gist: "“We deploy on Fridays” vs “We never deploy on Fridays”",
    why: "Full body. Two stored claims cannot both be true.",
    tokens: 38
  }
]

export const RECEIPT_TOTAL = 99
export const RECEIPT_CEILING = 2000
export const INDEX_TOKENS = 1320
export const EVERY_BODY_TOKENS = 3643

export interface SdkClient {
  readonly name: string
  readonly body: string
  readonly note?: string
}

export const SDK_CLIENTS: readonly SdkClient[] = [
  {
    name: "Official — TypeScript",
    body: "One dependency, typed end to end, Node 22+. Resources mirror the endpoints one-to-one, so memory.context.build() is POST /v1/context and nothing else.",
    note: "runTurn, recallOrExplain and seedMemories wrap the workflows that are easy to get subtly wrong."
  },
  {
    name: "Official — in-process engine",
    body: "The same package also exports the deterministic layer on its own: tiering, ranking, reconciliation, the fast gate. No database, no network, no model in the retrieval path.",
    note: "Importing createClient alone does not pull the engine in, so tree-shaking keeps the client small."
  },
  {
    name: "Any other language",
    body: "Every endpoint is JSON over HTTP with a bearer key. Python, Go, Rust or anything else is a request library and the two calls below — no generated client, no version lock-in.",
    note: "Errors carry a tag, a message, and requiredScope or issues where they apply, so a caller can branch without parsing prose."
  },
  {
    name: "Agent harnesses",
    body: "not-another-harness wires memory in as a dependency and exposes it in-process. If your harness is not that package, the two-call integration is the whole contract.",
    note: "Deliberately not a plugin API: an unofficial memory layer cannot be held to a per-turn cost, which is the point of the receipts."
  }
]

export const INSTALL = "pnpm add cogmemory"

export const TURN_SAMPLE = `import { createClient, runTurn } from "cogmemory"

const memory = createClient({
  apiKey: process.env.COGNITIVE_MEMORY_KEY!,
  baseUrl: "http://localhost:3000",
})

// context before the model, learning after it
const { context, learning, learningSkipped } = await runTurn(
  memory,
  { userMessage, run: (block) => callYourModel(block, userMessage) },
  { domain: "database" }
)

context.totalTokens   // what this turn cost
context.entries       // every line, with its reason
learning?.counts      // stored, merged, rejected, tensions`

export const HTTP_SAMPLE = `# what the agent should know before it answers
curl -X POST localhost:3000/api/v1/context \\
  -H "Authorization: Bearer $COGNITIVE_MEMORY_KEY" \\
  -H "content-type: application/json" \\
  -d '{"userMessage":"deploy ZQ7X4M2K to staging"}'

# what it should remember from the finished turn
curl -X POST localhost:3000/api/v1/turns \\
  -H "Authorization: Bearer $COGNITIVE_MEMORY_KEY" \\
  -H "content-type: application/json" \\
  -d '{"userMessage":"...","assistantResponse":"..."}'`
