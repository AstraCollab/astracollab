import Link from "next/link"

import { SiteFooter } from "@/components/site-footer"
import { SiteHeader } from "@/components/site-header"

/**
 * The landing page.
 *
 * Its job is to answer one question properly — what cognitive memory is, and why
 * it is not a vector store with a nicer name — and then get out of the way. Every
 * claim on it is either a measured number from `scripts/measure.ts` or a
 * behaviour the test suite pins down. The deep reference lives at /docs; a
 * landing page that tries to be the manual is a manual nobody reads.
 *
 * The page leads on cost and attribution rather than on forgetfulness.
 * Forgetting is the whole category's opening line and it is true of everything
 * here; what a similarity search cannot offer is a per-turn price and a reason
 * attached to every line, and that is the part worth the first screen.
 *
 * The hero shows the `/v1/context` receipt rather than the rendered prompt. The
 * prompt is a consequence; the receipt is the evidence, and it is the part a
 * reader cannot get from a competitor's docs.
 */

const TIERS = [
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
] as const

const REASONS = [
  ["index", "A single gist line.", "The default, and what almost every memory costs. 200 memories index for ~1.3k tokens."],
  ["trigger", "The full body.", "You named something concrete the transcript does not already contain — a build id, a host, a path — and a memory mentions it. No model decides this."],
  ["tension", "The full body.", "Two stored claims contradict each other. A contradiction is a question to ask, not trivia to skim."],
  ["guardrail", "The full body.", "A domain this agent has been measurably unreliable in."],
  ["", "Nothing.", "Above the index budget. The report says so rather than quietly dropping the tail."]
] as const

const RECEIPT = [
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
] as const

const SDK_CLIENTS = [
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
] as const

const CAPABILITIES = [
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
] as const

const NUMBERS = [
  ["5.0 ms", "recall p50", "Deterministic ranked lookup over 200 stored memories. No model in the path, so it does not move when a provider does."],
  ["2.9 ms", "context build p50", "The whole prompt block — index lines, triggered bodies, contradictions and weak domains — assembled before the model is called."],
  ["77%", "fewer tokens", "Indexing 200 memories costs 1.3k tokens. Injecting all 200 bodies costs 3.6k. Bodies are spent only where something earned them."],
  ["0", "models required", "Deterministic extraction runs first. A deployment with no model key still learns plainly-stated facts."]
] as const

const USE_CASES = [
  ["Coding agents", "Hold the build id, the deploy command, the naming convention, the thing that broke last month. Get them back in the one line that matters."],
  ["Support agents", "Remember what this customer was told, what was actually true, and which of the two is now contradicted."],
  ["Research assistants", "Keep a running set of findings and the open questions, with disagreements surfaced rather than averaged away."],
  ["Internal assistants", "Company facts with a source, an owner, and a date — and a running record of which topics the assistant is weak on."],
  ["Long-running work", "A service the agent can call for the hundredth session. Memory survives deploys, restarts, and model swaps."],
  ["Multi-tenant products", "Memory as a credentialed storage layer: your own database, your own keys, revocable per integration."]
] as const

const FAQ = [
  {
    q: "How do I know what memory is costing me?",
    a: "Every context build returns the entries that produced it, each with the rule that selected it — index, trigger, tension, guardrail — and its token cost, plus the total and whether the budget truncated. Analytics splits the spend by that same reason, which is the difference between “memory is expensive” and a number you can act on: a build spending its whole budget on index lines and no bodies is a store with nothing worth promoting, not a budget that needs raising."
  },
  {
    q: "Is this a vector database with extra steps?",
    a: "No, and the difference is load-bearing. Ranking here is deterministic token overlap with identifier matching, so recall behaves identically on every run and on every model, and you can name the terms that matched. A semantic index earns its keep on fuzzy paraphrase over very large corpora; for the register an agent actually stores — URLs, build ids, ports, conventions — exact tokens are both faster and more precise."
  },
  {
    q: "Do I need a model configured?",
    a: "No. Deterministic pattern extraction runs first, so a plainly-stated fact is captured even with no provider configured at all — health reports `extractor: rules-only` so you know which mode you are in. Add a key and turns are also summarised and contradictions are detected, with a typed output contract validated by the effect/ai layer rather than by parsing prose."
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
] as const

export default function Home() {
  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader />

      <main className="flex-1">
        {/* Hero */}
        <section className="relative overflow-hidden border-b border-white/[0.06]">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,rgba(139,92,246,0.16),transparent_70%)]"
          />
          <div className="relative mx-auto w-full max-w-5xl px-6 pb-20 pt-20 sm:pt-28">
            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-violet-300/70">
              A budget and a paper trail
            </p>
            <h1 className="mt-5 max-w-3xl text-4xl font-medium leading-[1.1] tracking-tight text-balance sm:text-5xl">
              Every line comes with a reason and a price.
              <span className="text-zinc-500"> Nothing enters the prompt unattributed.</span>
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-7 text-zinc-400">
              You cannot budget what has no price. Cognitive Memory files what an
              agent is told into four tiers &mdash; a gist line by default, a full
              body only where something concrete earned it &mdash; and returns the
              reason and the token cost of every line it injects.
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-3">
              <PrimaryLink href="/dashboard">Mint an API key</PrimaryLink>
              <SecondaryLink href="/docs">Read the reference</SecondaryLink>
            </div>
            <p className="mt-4 text-xs text-zinc-600">
              Self-hosted SQLite · REST API · TypeScript SDK · learns with no model
              key set
            </p>

            <div className="mt-14 overflow-hidden rounded-xl border border-white/[0.08] bg-black/40">
              <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2">
                <span className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">
                  one turn, itemised
                </span>
                <span className="font-mono text-[10px] text-zinc-700">
                  POST /v1/context
                </span>
              </div>

              <div className="divide-y divide-white/[0.04]">
                {RECEIPT.map((line) => (
                  <div key={line.id} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-2.5">
                    <span className="w-[62px] font-mono text-[10px] uppercase tracking-wide text-zinc-700">
                      {line.tier}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-[13px] leading-5 text-zinc-300">
                        {line.gist}
                      </p>
                      <p className="mt-0.5 text-[11px] leading-4 text-zinc-600">
                        {line.why}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="rounded border border-white/[0.08] px-1.5 py-0.5 font-mono text-[10px] text-violet-200/80">
                        {line.reason}
                      </span>
                      <span className="w-12 text-right font-mono text-[11px] text-zinc-500">
                        {line.tokens}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              <div className="border-t border-white/[0.06] px-4 py-3">
                <div className="flex items-baseline justify-between">
                  <span className="text-[11px] text-zinc-500">
                    99 of a 2,000 token ceiling
                  </span>
                  <span className="font-mono text-[10px] text-zinc-700">
                    truncated: false
                  </span>
                </div>
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.06]">
                  <div className="h-full w-[5%] rounded-full bg-violet-400/70" />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Pipeline */}
        <Section
          eyebrow="The loop"
          title="Five steps, and only one of them needs a model"
          lede="A statement arrives in a conversation. It is checked against what is already known, folded in or kept apart, filed in a tier, and then either indexed or written out in full — depending on what the message in front of it actually referred to."
        >
          <ol className="grid gap-px overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.06] sm:grid-cols-5">
            <Step n="01" title="Capture" body="Deterministic patterns first: URLs, assignments, stated requirements. No model, no refusal, no silent loss." />
            <Step n="02" title="Reconcile" body="Restatements are folded into what is held. A merge that would drop a qualifier is refused and both are kept." />
            <Step n="03" title="File" body="Into one of four tiers. New facts land hot so the next prompt already knows them." />
            <Step n="04" title="Plan" body="Build the block: a gist line for everything, a full body only for triggers, contradictions and weak domains." />
            <Step n="05" title="Inject" body="Into the system prompt, inside a token budget that reports when it truncated." />
          </ol>
        </Section>

        {/* What it is */}
        <Section
          eyebrow="What this is"
          title="A memory store that tells you what it cost"
          lede="Keeping facts is the easy half. The part that decides whether an agent is usable in production is everything around them: what a stored fact costs per turn, which line earned its place, what was refused, and why a recall came back empty."
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {CAPABILITIES.map((capability) => (
              <article key={capability.title} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-5">
                <h3 className="text-sm font-medium text-zinc-100">{capability.title}</h3>
                <p className="mt-2 text-[13px] leading-6 text-zinc-400">{capability.body}</p>
                <p className="mt-3 border-l border-white/[0.08] pl-3 text-xs leading-5 text-zinc-600">
                  {capability.aside}
                </p>
              </article>
            ))}
          </div>
        </Section>

        {/* Tiers */}
        <Section
          eyebrow="Tiers"
          title="Four tiers, one budget"
          lede="Tiers are not decoration. They decide what a memory costs per turn, and therefore how much of it you can afford to keep."
        >
          <div className="overflow-hidden rounded-xl border border-white/[0.08]">
            <div className="hidden grid-cols-[64px_140px_1fr_200px] gap-4 border-b border-white/[0.07] bg-white/[0.03] px-5 py-2.5 font-mono text-[10px] uppercase tracking-widest text-zinc-600 sm:grid">
              <span>Tier</span>
              <span>Name</span>
              <span>Holds</span>
              <span>Cost per turn</span>
            </div>
            {TIERS.map((row) => (
              <div
                key={row.tier}
                className="grid gap-1 border-b border-white/[0.05] px-5 py-4 last:border-0 sm:grid-cols-[64px_140px_1fr_200px] sm:gap-4"
              >
                <code className="font-mono text-[12px] text-violet-200">{row.tier}</code>
                <span className="text-[13px] text-zinc-200">{row.name}</span>
                <div>
                  <p className="text-[13px] leading-5 text-zinc-400">{row.holds}</p>
                  <p className="mt-1 text-xs text-zinc-600">{row.when}</p>
                </div>
                <span className="text-xs leading-5 text-zinc-500">{row.cost}</span>
              </div>
            ))}
          </div>
        </Section>

        {/* Index not everything */}
        <Section
          eyebrow="Why an index"
          title="Injecting everything is how memory becomes a liability"
          lede="Chroma's 2025 context-rot report measures accuracy falling as input length grows, with the damage coming from topically-related distractors rather than from structure. A short, high-signal index with on-demand bodies keeps recall cheap without spending the window on material that is usually irrelevant."
        >
          <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
            <div className="overflow-hidden rounded-xl border border-white/[0.08]">
              <div className="grid grid-cols-[110px_120px_1fr] gap-3 border-b border-white/[0.07] bg-white/[0.03] px-4 py-2.5 font-mono text-[10px] uppercase tracking-widest text-zinc-600">
                <span>Reason</span>
                <span>Included</span>
                <span>What earned it</span>
              </div>
              {REASONS.map(([reason, included, why]) => (
                <div
                  key={reason || "dropped"}
                  className="grid grid-cols-[110px_120px_1fr] gap-3 border-b border-white/[0.05] px-4 py-3 last:border-0"
                >
                  <code className="font-mono text-[11px] text-violet-200">{reason || "—"}</code>
                  <span className="text-xs text-zinc-300">{included}</span>
                  <span className="text-xs leading-5 text-zinc-500">{why}</span>
                </div>
              ))}
            </div>
            <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-5">
              <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">
                measured, 200 memories
              </p>
              <div className="mt-4 space-y-4">
                <Bar label="Index + triggers" value={1320} max={3643} tone="accent" />
                <Bar label="Every body" value={3643} max={3643} tone="muted" />
              </div>
              <p className="mt-4 text-xs leading-5 text-zinc-500">
                Same 200 facts. 77% fewer tokens, and the window keeps its room for
                the actual task.
              </p>
              <p className="mt-3 text-[11px] text-zinc-700">
                Reproduce with <code className="font-mono">pnpm measure</code>.
              </p>
            </div>
          </div>
        </Section>

        {/* Numbers */}
        <section className="border-y border-white/[0.06] bg-white/[0.015]">
          <div className="mx-auto grid w-full max-w-5xl gap-px px-6 py-4 sm:grid-cols-2 lg:grid-cols-4">
            {NUMBERS.map(([value, label, detail]) => (
              <div key={label} className="py-6">
                <p className="text-2xl font-medium tracking-tight text-zinc-100">{value}</p>
                <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-violet-300/60">
                  {label}
                </p>
                <p className="mt-3 text-xs leading-5 text-zinc-500">{detail}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Use cases */}
        <Section
          eyebrow="Use cases"
          title="For agents that have to be right twice"
          lede="The same failure everywhere: an agent that was right last month is confidently wrong today, and nothing in the transcript shows which. A bounded prompt and a recorded reason for every line are what turn one session into continuity."
        >
          <div className="grid gap-px overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.06] sm:grid-cols-2 lg:grid-cols-3">
            {USE_CASES.map(([title, body]) => (
              <div key={title} className="bg-[#08080b] p-5">
                <h3 className="text-[13px] font-medium text-zinc-100">{title}</h3>
                <p className="mt-2 text-xs leading-5 text-zinc-500">{body}</p>
              </div>
            ))}
          </div>
        </Section>

        {/* SDK */}
        <Section
          eyebrow="SDK"
          title="One typed client, and plain HTTP for everything else"
          lede="There is one official SDK, and it is the only one that needs installing. Every endpoint is plain JSON over HTTP, so the other way in is curl — which is why the integration below is two calls in any language, not a port waiting to happen."
        >
          <div className="overflow-hidden rounded-xl border border-white/[0.08]">
            <div className="flex items-center justify-between gap-4 border-b border-white/[0.07] bg-white/[0.03] px-4 py-2.5">
              <span className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">
                @astracollab/cogmem
              </span>
              <code className="font-mono text-[11px] text-zinc-400">
                pnpm add @astracollab/cogmem
              </code>
            </div>
            <div className="grid gap-px bg-white/[0.06] sm:grid-cols-2">
              {SDK_CLIENTS.map((client) => (
                <div key={client.name} className="bg-[#08080b] p-5">
                  <h3 className="text-[13px] font-medium text-zinc-100">{client.name}</h3>
                  <p className="mt-2 text-xs leading-5 text-zinc-500">{client.body}</p>
                  {client.note ? (
                    <p className="mt-3 text-[11px] leading-5 text-zinc-700">{client.note}</p>
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <Code
              title="TypeScript — the whole turn"
              body={`import { createClient, runTurn } from "@astracollab/cogmem"

const memory = createClient({
  apiKey: process.env.COGNITIVE_MEMORY_KEY!,
  baseUrl: "http://localhost:3000",
})

// context before the model, learning after it
const { context, learning } = await runTurn(
  memory,
  {
    userMessage,
    run: (block) => callYourModel(block, userMessage),
  },
  { domain: "database" }
)

context.totalTokens   // what this turn cost
context.entries       // every line, with its reason
learning?.counts      // stored, merged, rejected, tensions`}
            />
            <Code
              title="Any language — two HTTP calls"
              body={`# what the agent should know before it answers
curl -X POST localhost:3000/api/v1/context \\
  -H "Authorization: Bearer $COGNITIVE_MEMORY_KEY" \\
  -H "content-type: application/json" \\
  -d '{"userMessage":"deploy ZQ7X4M2K to staging"}'

# what it should remember from the finished turn
curl -X POST localhost:3000/api/v1/turns \\
  -H "Authorization: Bearer $COGNITIVE_MEMORY_KEY" \\
  -H "content-type: application/json" \\
  -d '{"userMessage":"...","assistantResponse":"..."}'`}
            />
          </div>
          <p className="text-sm text-zinc-500">
            The SDK is ~3kB gzipped, ESM-first, and depends on one small fetch
            wrapper. It also ships the deterministic engine, so the same ranking
            and tiering can run in-process with no service at all.{" "}
            <Link href="/docs#sdk" className="text-violet-200 hover:text-violet-100">
              Full reference →
            </Link>
          </p>
        </Section>

        {/* FAQ */}
        <Section
          eyebrow="Questions"
          title="The ones worth answering honestly"
          lede="Including the three that decide whether this is the right tool for you: what it costs, whether it needs a model, and why it is not a vector database."
        >
          <div className="divide-y divide-white/[0.06] overflow-hidden rounded-xl border border-white/[0.08]">
            {FAQ.map((item) => (
              <details key={item.q} className="group px-5 py-4">
                <summary className="flex cursor-pointer list-none items-start justify-between gap-4 text-[13px] text-zinc-200 marker:hidden">
                  {item.q}
                  <span className="mt-0.5 shrink-0 text-zinc-600 transition group-open:rotate-45">
                    +
                  </span>
                </summary>
                <p className="mt-3 max-w-3xl text-[13px] leading-6 text-zinc-500">{item.a}</p>
              </details>
            ))}
          </div>
        </Section>

        {/* CTA */}
        <section className="border-t border-white/[0.06]">
          <div className="mx-auto w-full max-w-5xl px-6 py-20 text-center">
            <h2 className="text-2xl font-medium tracking-tight text-balance">
              Give every token your agent spends a receipt.
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-zinc-500">
              Create an account, make an organisation, and mint a key. The secret
              is shown once, because only a hash is stored.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <PrimaryLink href="/dashboard">Open the dashboard</PrimaryLink>
              <SecondaryLink href="/docs">Read the reference</SecondaryLink>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  )
}

function Section({
  eyebrow,
  title,
  lede,
  children
}: {
  eyebrow: string
  title: string
  lede: string
  children: React.ReactNode
}) {
  return (
    <section className="border-b border-white/[0.06]">
      <div className="mx-auto w-full max-w-5xl space-y-7 px-6 py-20">
        <div className="max-w-2xl space-y-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-violet-300/60">
            {eyebrow}
          </p>
          <h2 className="text-2xl font-medium tracking-tight text-balance">{title}</h2>
          <p className="text-sm leading-6 text-zinc-500">{lede}</p>
        </div>
        {children}
      </div>
    </section>
  )
}

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <li className="bg-[#08080b] p-5">
      <span className="font-mono text-[10px] text-violet-300/50">{n}</span>
      <h3 className="mt-2 text-[13px] font-medium text-zinc-100">{title}</h3>
      <p className="mt-2 text-xs leading-5 text-zinc-500">{body}</p>
    </li>
  )
}

function Bar({ label, value, max, tone }: { label: string; value: number; max: number; tone: "accent" | "muted" }) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-zinc-400">{label}</span>
        <span className="font-mono text-[11px] text-zinc-500">{value.toLocaleString()} tok</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className={tone === "accent" ? "h-full bg-violet-400/70" : "h-full bg-white/15"}
          style={{ width: `${Math.max(2, (value / max) * 100)}%` }}
        />
      </div>
    </div>
  )
}

function Code({ title, body }: { title: string; body: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-black/40">
      <div className="border-b border-white/[0.06] px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-zinc-600">
        {title}
      </div>
      <pre className="overflow-x-auto px-4 py-4 font-mono text-[11px] leading-5 text-zinc-400">{body}</pre>
    </div>
  )
}

export function PrimaryLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 rounded-lg bg-violet-500 px-4 py-2.5 text-[13px] font-medium text-white transition hover:bg-violet-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-300"
    >
      {children}
      <span aria-hidden>→</span>
    </Link>
  )
}

export function SecondaryLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 rounded-lg border border-white/12 px-4 py-2.5 text-[13px] text-zinc-300 transition hover:border-white/25 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-300"
    >
      {children}
    </Link>
  )
}
