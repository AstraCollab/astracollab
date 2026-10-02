import type { Metadata } from "next"
import Link from "next/link"

import { SiteFooter } from "@/components/site-footer"
import { SiteHeader } from "@/components/site-header"

export const metadata: Metadata = {
  title: "Documentation",
  description:
    "How Cognitive Memory works: the four tiers, what gets learned, how restatements are reconciled, and why every injection is labelled."
}

/**
 * The reference.
 *
 * The landing page argues that this is worth having; this page is what you read
 * once you have decided, and it is written to be read rather than skimmed. Every
 * rule here corresponds to something enforced in code and pinned by a test,
 * because a document that describes intended behaviour rather than actual
 * behaviour is worse than none.
 */

const SECTIONS = [
  { id: "model", label: "The model" },
  { id: "tiers", label: "Tiers" },
  { id: "capture", label: "What gets learned" },
  { id: "reconciliation", label: "Reconciliation" },
  { id: "injection", label: "Injection" },
  { id: "recall", label: "Recall" },
  { id: "tensions", label: "Tensions" },
  { id: "self-model", label: "Self-model" },
  { id: "api", label: "API" },
  { id: "dashboard", label: "Dashboard" },
  { id: "auth", label: "Credentials" }
] as const

export default function DocsPage() {
  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader />

      <div className="mx-auto flex w-full max-w-5xl flex-1 gap-10 px-6 py-12">
        <aside className="hidden w-44 shrink-0 lg:block">
          <nav className="sticky top-20 space-y-2 text-[13px]">
            {SECTIONS.map((section) => (
              <a
                key={section.id}
                href={`#${section.id}`}
                className="block text-zinc-500 transition hover:text-zinc-200"
              >
                {section.label}
              </a>
            ))}
          </nav>
        </aside>

        <main className="min-w-0 flex-1 space-y-16 pb-24">
          <header className="space-y-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-violet-300/60">
              Documentation
            </p>
            <h1 className="text-3xl font-medium tracking-tight">Cognitive Memory</h1>
            <p className="max-w-2xl text-sm leading-6 text-zinc-400">
              A memory service for agents. It stores durable facts, decides what
              to put in front of a model each turn, and tells you why. The
              retrieval path is deterministic by design, and the reasoning behind
              every threshold below is written down because the numbers are only
              defensible with it.
            </p>
            <div className="flex flex-wrap gap-3 pt-2">
              <Link
                href="/dashboard"
                className="rounded-lg bg-violet-500 px-3.5 py-2 text-[13px] font-medium text-white transition hover:bg-violet-400"
              >
                Get an API key
              </Link>
              <Link
                href="/#tiers"
                className="rounded-lg border border-white/12 px-3.5 py-2 text-[13px] text-zinc-300 transition hover:border-white/25"
              >
                Back to the overview
              </Link>
            </div>
          </header>

          <Doc id="model" title="The model">
            <p>
              Most “memory” for agents is a list of strings and a similarity
              search. That is enough to make a demo feel like recall, and it fails
              in three specific ways that show up in production.
            </p>
            <p>It cannot hold a contradiction.</p>
            <p>
              Two stored claims that cannot both be true are, in a flat list,
              indistinguishable from two unrelated facts. There is nowhere to put
              “these disagree” — so one of them quietly wins, and the agent
              proceeds on a premise the user has already contradicted.
            </p>
            <p>It has no notion of cost.</p>
            <p>
              A similarity search returns k results, and k is chosen by whoever
              wrote the call. As the store grows, so does the prompt, and the
              material included falls into two groups: things that were relevant,
              and things that merely looked like they might be. The second group
              is what context rot actually measures.
            </p>
            <p>It cannot say why something matched.</p>
            <p>
              A cosine score is not an explanation. When a user asks why their
              agent believes something, the honest answer is a floating point
              number, which is not an answer.
            </p>
            <p>
              This service is built around those three gaps. It stores tiers, so
              cost per turn is a decision rather than an accident. It stores
              tensions as first-class rows. And every injection is recorded with
              the rule that produced it, so the dashboard can show the exact block
              a model is about to receive.
            </p>
          </Doc>

          <Doc id="tiers" title="Four tiers">
            <p>
              A tier is a cost decision. L0 and L1 are written into the prompt
              every turn; L2 and L3 cost nothing until something promotes or
              recalls them.
            </p>
            <TiersTable />
            <p>
              New statements land in <b>L1</b> immediately. Waiting for a
              promotion pass added a turn of latency, which meant a fact you
              taught on one turn was still missing from the very next prompt — the
              most visible possible way for memory to look broken.
            </p>
            <p>
              L1 is capped by the token budget. When the cap bites, the report
              says <code>truncated: true</code> rather than dropping the tail in
              silence, and the least recently accessed entries are the ones that
              lose their place.
            </p>
          </Doc>

          <Doc id="capture" title="What gets learned">
            <p>
              Learning runs deterministic patterns first, then optionally a model.
              The order is the point: a model is a good judge and a poor witness,
              because it can refuse, hedge, or return nothing, and a fact the user
              plainly stated then never gets learned at all.
            </p>
            <Rules />
            <p>
              Three things are always refused. Instructions about how to behave in
              <i> this</i> conversation — “do not verify this against the repo” —
              are not project facts. A turn whose user message contains a question
              is a lookup, not a lesson, so learning is skipped: extracting from
              recall turns stored the assistant’s own answers back as memories,
              which duplicated facts and evicted the real ones. And anything
              interaction-scoped is returned as a rejection with a reason rather
              than dropped.
            </p>
          </Doc>

          <Doc id="reconciliation" title="Reconciliation">
            <p>
              Two statements can say the same thing. Storing both is how a memory
              layer becomes unsearchable inside a week, so a candidate is compared
              against what is already held and folded in — under one rule that
              governs every merge:
            </p>
            <Callout>
              A merge must keep every distinctive token of both sides. A
              replacement missing one is refused, and both entries are kept.
            </Callout>
            <p>
              Distinctive tokens are the ones that carry a fact’s identity —
              identifiers, numbers, codes. Function words and generic nouns
              (“file”, “name”, “project”) are excluded because they recur in every
              restatement and hide real differences. The test is deliberately
              biased towards reporting a loss: a false positive costs one
              duplicate row, which is recoverable, while a false negative deletes
              a fact permanently.
            </p>
            <p>
              So “Always run migrations against staging” and “Always run
              migrations against staging, never production” do not merge. The
              second says strictly more, and dropping the qualifier is exactly the
              failure this rule exists to prevent.
            </p>
            <p>
              With a model configured, the ADD / MERGE / REPLACE / REJECT decision
              is made once per turn for all candidates together, and any failure
              falls back to keeping both.
            </p>
          </Doc>

          <Doc id="injection" title="What goes into the prompt">
            <p>
              <code>POST /v1/context</code> returns the block to prepend to a
              system prompt, plus the entries that produced it and what each cost.
            </p>
            <ReasonsTable />
            <p>
              The trigger is the interesting one, and it is deterministic. Pull
              identifiers out of the message — URLs, dotted hosts, paths,
              SCREAMING_SNAKE, camelCase, long kebab-case, hex-ish codes — and keep
              only those absent from the visible transcript. If the caller named
              something concrete the model cannot already see, and a memory
              mentions it, that memory’s body is included. No model is asked
              whether that matters.
            </p>
            <p>
              A synchronous fast gate runs first on the raw message and catches
              explicit corrections — “actually, we switched to Postgres”, “stop
              using that”, “that’s wrong”. When it fires, a premise-correction
              notice goes into the block, because a user visibly changing their
              mind is the single most reliable signal that the agent’s assumption
              is stale.
            </p>
          </Doc>

          <Doc id="recall" title="Recall">
            <p>
              Ranking is token overlap, normalised by the smaller side, with
              paraphrases of one fact collapsed to their best-scoring instance. No
              model and no embedding service is involved.
            </p>
            <p>
              That is a deliberate trade. A semantic index earns its keep on fuzzy
              paraphrase over very large corpora. The register an agent actually
              stores is URLs, build ids, ports, paths and conventions — where
              exact tokens are both faster and more precise, and where an
              embedding adds latency, cost, and a failure mode at the one moment
              you cannot afford one: mid-conversation.
            </p>
            <p>
              The practical consequence is that recall quality is a property of
              the deployment rather than of the provider. A question that shares
              no words with a memory will not match it, which is why the index is
              pre-staged into every prompt as well: a memory you never had to ask
              for is a memory that cannot be missed.
            </p>
            <Callout>
              An empty result returns <code>empty: true</code>. The SDK turns that
              into “if you were not told, say so rather than guessing”, because a
              silent miss is how a language model invents a fact it was never
              given.
            </Callout>
          </Doc>

          <Doc id="tensions" title="Knowledge tensions">
            <p>
              A tension is two claims that cannot both be true, stored as a pair
              with an actionable question. It is pinned into every context build
              until resolved, and it is the one thing that is always injected in
              full regardless of budget.
            </p>
            <pre className="overflow-x-auto rounded-xl border border-white/[0.08] bg-black/40 px-4 py-4 font-mono text-[11px] leading-5 text-zinc-400">
              {`### Active Knowledge Tensions (Contradictions)
- [CRITICAL] “We deploy on Fridays” conflicts with “We never deploy on Fridays”.
  Ask: Which is it?`}
            </pre>
            <p>
              Resolving one keeps the resolution, including the reusable pattern
              it revealed. Deleting it would mean rediscovering the same
              contradiction next month.
            </p>
          </Doc>

          <Doc id="self-model" title="The self-model">
            <p>
              Reliability per domain, tracked as a moving average over outcomes
              you record. Any active domain below 75% is rendered into every
              prompt as a guardrail listing its known failure patterns and what
              has worked.
            </p>
            <p>
              One detail worth stating plainly, because the obvious formula gets
              it wrong: the average carries a prior of two samples. Dividing by
              the sample count makes the first outcome fully replace the starting
              estimate, so a single failed task takes a domain from 0.8 to 0 — and
              the domain then trips the guardrail threshold forever. With the
              prior, one failure is a strong signal and ten are conclusive, which
              is what a reliability number should mean.
            </p>
            <p>
              Nothing here is inferred. Without outcomes recorded through{" "}
              <code>POST /v1/self-model/outcome</code>, the model stays at its
              priors and no guardrail ever fires, which is the most common reason a
              self-model looks like it is not working.
            </p>
          </Doc>

          <Doc id="api" title="API">
            <p>Every endpoint is JSON. Authenticate with <code>Authorization: Bearer &lt;key&gt;</code>.</p>
            <ApiTable />
            <p>
              Errors carry a tag, a message, and whatever is actionable:{" "}
              <code>requiredScope</code> on a 403, <code>issues</code> on a 400. A
              caller can therefore tell a wrong key from a wrong scope, and a
              malformed body from an outage, without parsing prose.
            </p>
          </Doc>

          <Doc id="dashboard" title="Dashboard">
            <p>
              Ten pages, all authenticated by session cookie rather than by API key —
              looking at your own memory should not cost you a credential, and
              handing out keys to open a page would train exactly the habit this
              service discourages. What each one answers:
            </p>
            <DashboardTable />
            <p>
              Two of them are worth calling out, because they are the ones that turn
              a vague feeling into a specific fix.
            </p>
            <p>
              <b>Analytics</b> splits the token spend by the rule that caused each
              line: index, trigger, tension, guardrail. A build that spends its
              whole budget on index lines and no bodies is not a memory that needs a
              bigger budget, it is a store with nothing worth promoting, and the two
              problems have opposite fixes.
            </p>
            <p>
              <b>Activity</b> replays the block that was actually sent, not the one
              the planner would produce today. Re-running the planner against current
              memory answers &ldquo;what would the agent get now&rdquo;, which is a
              much better-looking answer than the one that caused whatever you are
              trying to understand. The triggering message is not stored with it —
              that is the conversation, not the memory — but the identifiers inside
              it are, because those are what explain why a full body was spent.
            </p>
            <p>
              <b>Settings</b> holds per-organisation overrides of the token ceiling,
              the index limit and the recall default, plus whether model extraction
              runs at all and how long the logs are kept. Each override is nullable,
              and null means &ldquo;inherit the deployment default&rdquo;: a setting
              that silently reverts is worse than no setting at all, so the page shows
              both numbers and clearing the override is one click rather than a guess
              at what the deployment default was last week.
            </p>
          </Doc>

          <Doc id="auth" title="Credentials">
            <p>Two kinds of credential, deliberately separated.</p>
            <p>
              A <b>session</b> identifies a person. Better Auth owns users,
              sessions and organisations; it is what the dashboard uses, and the
              only thing that can create an organisation or mint a key.
            </p>
            <p>
              An <b>API key</b> identifies an agent. Keys are opaque, scoped,
              individually revocable, and stored as a sha256 hash — the secret is
              shown exactly once. A key resolves to one organisation and a set of
              scopes, and can only read and write that organisation’s memory.
            </p>
            <p>
              The separation is the security model: a leaked agent key cannot mint
              a new key, cannot change its own scopes, and cannot create an
              organisation. Rotation happens from a signed-in session.
            </p>
            <p>
              sha256 rather than a slow key derivation, on purpose. Password hashing
              exists to make guessing a human password expensive; these secrets
              carry 256 bits of entropy, so there is no search to slow down, and a
              deliberately slow hash would add latency to every request to protect
              against an attack that cannot happen. The public prefix means a
              presented key is one indexed lookup and one constant-time comparison.
            </p>
          </Doc>
        </main>
      </div>

      <SiteFooter />
    </div>
  )
}

function Doc({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 space-y-4">
      <h2 className="text-lg font-medium tracking-tight">{title}</h2>
      <div className="max-w-2xl space-y-4 text-[13px] leading-6 text-zinc-400">{children}</div>
    </section>
  )
}

function Callout({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border-l-2 border-violet-400/50 bg-violet-500/[0.05] px-4 py-3 text-zinc-300">
      {children}
    </p>
  )
}

function TiersTable() {
  const rows = [
    ["L0", "Pinned", "Tensions, self-model guardrails, correction notices", "Full body, always"],
    ["L1", "Hot cache", "Newly learned and pre-staged facts", "Index line, body on trigger"],
    ["L2", "Warm store", "Candidates scored against each turn", "Nothing until promoted"],
    ["L3", "Cold archive", "Everything else, still recallable", "Nothing until recalled"]
  ] as const
  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.08]">
      <div className="grid grid-cols-[52px_100px_1fr_120px] gap-3 border-b border-white/[0.07] bg-white/[0.03] px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-zinc-600">
        <span>Tier</span>
        <span>Name</span>
        <span>Holds</span>
        <span>Cost</span>
      </div>
      {rows.map(([tier, name, holds, cost]) => (
        <div
          key={tier}
          className="grid grid-cols-[52px_100px_1fr_120px] gap-3 border-b border-white/[0.05] px-4 py-3 last:border-0"
        >
          <code className="font-mono text-[11px] text-violet-200">{tier}</code>
          <span className="text-xs text-zinc-200">{name}</span>
          <span className="text-xs text-zinc-500">{holds}</span>
          <span className="text-xs text-zinc-600">{cost}</span>
        </div>
      ))}
    </div>
  )
}

function ReasonsTable() {
  const rows = [
    ["index", "gist line", "The default. What nearly every memory costs."],
    ["trigger", "full body", "A concrete identifier absent from the transcript matched this memory."],
    ["tension", "full body", "An unresolved contradiction, with the question to ask."],
    ["guardrail", "full body", "A domain this agent has been unreliable in."]
  ] as const
  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.08]">
      {rows.map(([reason, included, why]) => (
        <div
          key={reason}
          className="grid grid-cols-[92px_96px_1fr] gap-3 border-b border-white/[0.05] px-4 py-3 last:border-0"
        >
          <code className="font-mono text-[11px] text-violet-200">{reason}</code>
          <span className="text-xs text-zinc-300">{included}</span>
          <span className="text-xs text-zinc-500">{why}</span>
        </div>
      ))}
    </div>
  )
}

function Rules() {
  const rules = [
    ["URLs", "Unambiguous. A host with a dot in it is captured whole, so a value like internal-hbr-2291.pineapple.example is never truncated at the first period."],
    ["Stated requirements", "always / never / must / should / make sure to — kept in your own words, because paraphrasing once turned “Never force push” into “requires: force push”."],
    ["Assignments", "“X is Y” where Y is identifier-shaped. Function words and filler are rejected, so “this is fine” never becomes a memory."],
    ["Model extraction", "Optional, on top. Project facts, preferences and constraints the patterns cannot see — with the user's statement treated as the signal, not the assistant's confidence."]
  ] as const
  return (
    <div className="space-y-2">
      {rules.map(([rule, detail]) => (
        <div key={rule} className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3">
          <p className="text-xs font-medium text-zinc-200">{rule}</p>
          <p className="mt-1 text-xs leading-5 text-zinc-500">{detail}</p>
        </div>
      ))}
    </div>
  )
}

function DashboardTable() {
  const rows = [
    ["/dashboard", "Overview", "What needs a human: unresolved contradictions, weak domains, whether the budget is truncating."],
    ["/dashboard/context", "Context", "The exact block your agent would be given for any message, with the reason and cost of every line."],
    ["/dashboard/activity", "Activity", "Every context build, with the block that was sent and the reason each line was included."],
    ["/dashboard/memory", "Library", "Search, filter, edit, retier and bulk-forget. Plus a recall inspector that names the terms that matched."],
    ["/dashboard/tensions", "Tensions", "Contradictions by status, with resolve, reopen, and the reusable pattern a resolution revealed."],
    ["/dashboard/self-model", "Self-model", "Reliability per domain with every sample behind the score, and a form to record an outcome."],
    ["/dashboard/analytics", "Analytics", "Tokens per turn over time, the reason mix, per-endpoint and per-key spend, tier distribution."],
    ["/dashboard/start", "Get started", "SDK and curl snippets, and a live tester that sends real requests with a key you paste."],
    ["/dashboard/keys", "Keys", "Issue, scope, expire and revoke agent credentials."],
    ["/dashboard/settings", "Settings", "Budgets, extraction, retention, the organisation, and a danger zone."]
  ] as const
  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.08]">
      {rows.map(([href, name, does]) => (
        <Link
          key={href}
          href={href}
          className="grid grid-cols-[1fr_120px_2fr] items-baseline gap-3 border-b border-white/[0.05] px-4 py-3 transition last:border-0 hover:bg-white/[0.02]"
        >
          <code className="font-mono text-[11px] text-violet-200">{href}</code>
          <span className="text-xs text-zinc-300">{name}</span>
          <span className="text-xs leading-5 text-zinc-500">{does}</span>
        </Link>
      ))}
    </div>
  )
}

function ApiTable() {
  const rows = [
    ["POST", "/v1/context", "Build the prompt block. Returns text, entries with reasons, and the token cost.", "memories:read"],
    ["POST", "/v1/recall", "Deterministic ranked lookup. Returns empty:true when nothing matched.", "memories:read"],
    ["POST", "/v1/turns", "Learn from a completed turn.", "memories:write"],
    ["POST", "/v1/memories", "Store facts outright. Restatements are folded in.", "memories:write"],
    ["GET", "/v1/memories", "List what is held, with tier counts.", "memories:read"],
    ["GET", "/v1/memories/:id", "One memory in full.", "memories:read"],
    ["PATCH", "/v1/memories/:id", "Move between tiers.", "memories:write"],
    ["DELETE", "/v1/memories/:id", "Forget one memory.", "memories:write"],
    ["GET", "/v1/tensions", "Contradictions, filterable by status.", "memories:read"],
    ["POST", "/v1/tensions", "Record a contradiction.", "memories:write"],
    ["POST", "/v1/tensions/:id", "Resolve one, keeping the pattern.", "memories:write"],
    ["GET", "/v1/self-model", "Reliability per domain.", "memories:read"],
    ["POST", "/v1/self-model/outcome", "Record how a domain went.", "memories:write"],
    ["GET", "/v1/stats", "Counts, weak domains, active tensions.", "stats:read"],
    ["GET", "/api/v1/health", "Liveness, limits, extractor mode. No key required.", "—"],
    ["GET", "/v1/keys", "List your keys by prefix.", "session"],
    ["POST", "/v1/keys", "Mint a key. The secret is returned once.", "session"],
    ["DELETE", "/v1/keys/:id", "Revoke a key.", "session"]
  ] as const
  return (
    <div className="overflow-x-auto rounded-xl border border-white/[0.08]">
      <table className="w-full text-left text-xs">
        <thead className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">
          <tr className="border-b border-white/[0.07]">
            <th className="px-4 py-2 font-normal">Method</th>
            <th className="px-4 py-2 font-normal">Path</th>
            <th className="px-4 py-2 font-normal">Does</th>
            <th className="px-4 py-2 font-normal">Needs</th>
          </tr>
        </thead>
        <tbody className="text-zinc-500">
          {rows.map(([method, path, does, needs]) => (
            <tr key={`${method} ${path}`} className="border-b border-white/[0.05] last:border-0">
              <td className="px-4 py-2.5 font-mono text-[10px] text-zinc-400">{method}</td>
              <td className="px-4 py-2.5 font-mono text-[11px] text-violet-200">{path}</td>
              <td className="px-4 py-2.5">{does}</td>
              <td className="px-4 py-2.5 font-mono text-[10px] text-zinc-600">{needs}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
