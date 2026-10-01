import Link from "next/link";
import { Code, DocHeader, DocSection, DocsShell, Note } from "@/components/docs/DocsShell";

const tiers = [
  ["L0", "Registers", "Active tensions, the proprioceptive self-model, and the fast-gate notice. Bodies only."],
  ["L1", "Hot cache", "Pre-staged memories. Rendered as a one-line index; a body is spent only when a trigger earns it."],
  ["L2", "Warm store", "Indexed candidates offered to the arbiter for promotion, capped at 20 per turn."],
  ["L3", "Cold archive", "Historical memories that stay out of the prompt until something promotes or recalls them."],
];

const learning = [
  ["Deterministic first", "Pattern matching runs before any model call, so a plainly-stated fact is captured even when the model refuses, hedges, or returns nothing."],
  ["Then the model", "The same model that ran the turn extracts facts, preferences, and conventions in the user's own words."],
  ["Never from questions", "A lookup is not a lesson. Extraction is skipped when your message contains a question mark."],
  ["Interaction-scoped text is dropped", "Instructions about how to behave right now, such as 'do not verify this against the repo', are not durable project facts."],
  ["Paraphrases collapse", "Two restatements of one fact become one entry, so the index cannot fill with copies of itself."],
];

const reasons = [
  ["index", "One gist line. The default, and what nearly everything costs."],
  ["trigger", "Full body — you named an identifier absent from the visible transcript and a memory matched it."],
  ["tension", "Full body. Unresolved contradictions earn the tokens."],
  ["guardrail", "Full body. A domain this agent is unreliable in."],
];

const api = [
  ["planInjection({ userMessage?, forceFull? })", "Returns text, entries, totalTokens and truncated. The primary entry point."],
  ["getPromptContext(message?)", "Prompt text only. Prefer planInjection when you want to know what was included."],
  ["search(query, limit?)", "Deterministic ranked lookup across all tiers. Backs the recall tool."],
  ["postTurnAsync({ userMessage, assistantResponse })", "Extraction, arbitration, budget enforcement, and persistence."],
  ["addMemory(item, targetTier)", "Adds or promotes a MemoryItem into a tier. Defaults to L2."],
  ["addTension(tension) / resolveTension(id, resolution)", "Registers or closes a contradiction pinned in L0."],
  ["recordDomainOutcome(domain, success, failurePattern?)", "Updates the moving-average reliability score for a domain."],
  ["getSnapshot() / loadSnapshot(snapshot)", "Serialize or restore the full L0–L3 state and stats."],
];

const indexSample = [
  "## Cognitive Memory State",
  "### Memory index — established earlier in this project",
  "- staging build ID (deployment)",
  "- file naming: kebab-case (naming)",
  "- internal staging host is internal-hbr-2291.example (infra)",
].join("\n");

const logSample = [
  "/memory",
  "",
  "Prompt injection log (what memory added, and why)",
  "  7 turn(s) · avg 58 tokens · max 83",
  "  index=25",
  "  turn 7: 58 tokens",
  "    index [index/L1] staging build ID is ZQ7X4M2K",
  "    index [index/L1] internal staging host is internal-hbr-2291.example",
].join("\n");

const setupSample = [
  "import { CognitiveMemory } from '@astracollab/not-another-harness';",
  "",
  "const memory = new CognitiveMemory({",
  "  extract: myExtractor,       // omit to use only the built-in patterns",
  "  arbiter: createModelArbiter({ model: arbiterModel }),",
  "  maxTotalTokens: 2000,",
  "});",
].join("\n");

const recallSample = [
  "recall { query: 'staging build id', limit: 6 }",
  "",
  "// Remembered (1 match):",
  "// - The staging build ID is ZQ7X4M2K. (deployment) [L1, relevance 0.75]",
].join("\n");

export default function MemoryPage() {
  return <DocsShell current="/docs/memory"><DocHeader eyebrow="MEMORY / COGNITIVE MEMORY" title="Remembered, not assumed." description="CognitiveMemory learns durable facts from your turns and puts the relevant ones in front of the model. It is deterministic where it can be: what gets stored, what gets pre-staged, and what a recall returns do not depend on which model you configured." />
    <DocSection id="tiers" title="Four tiers, one prompt block"><div className="overflow-hidden rounded-xl border border-white/[0.08]"><div className="grid grid-cols-[36px_92px_1fr] border-b border-white/[0.07] bg-white/[0.025] px-4 py-2 font-mono text-[9px] uppercase tracking-widest text-zinc-600"><span>Tier</span><span>Name</span><span>Contents</span></div>{tiers.map(([tier, name, contents]) => <div key={tier} className="grid grid-cols-[36px_92px_1fr] border-b border-white/[0.06] px-4 py-3 last:border-0"><code className="font-mono text-[11px] text-violet-200">{tier}</code><span className="text-[11px] text-zinc-300">{name}</span><span className="text-xs leading-5 text-zinc-400">{contents}</span></div>)}</div><p>Nothing here is required for the agent loop to run — memory is an additive layer you construct yourself.</p></DocSection>

    <DocSection id="learning" title="What gets learned, and what does not"><p>Naive memory only catches phrasings like 'always use kebab-case' and silently drops everything else. These rules exist because that made memory look broken: a stated fact simply never reached the tiers.</p><div className="space-y-2">{learning.map(([rule, detail]) => <div key={rule} className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5"><p className="text-[11px] font-medium text-zinc-300">{rule}</p><p className="mt-1 text-xs leading-5 text-zinc-500">{detail}</p></div>)}</div><p>A newly taught memory lands in L1 immediately. Waiting for the arbiter to promote it added a turn of latency, so a fact you taught on one turn was still missing from the next prompt.</p></DocSection>

    <DocSection id="index" title="Index by default, bodies on demand"><p>Always injecting every memory body is expensive and injects distractors by construction. Instead each turn gets a one-line index of everything remembered, and a full body is spent only where a deterministic signal earns it.</p><p>The trigger is the same idea Aider uses for its repo map: pull identifiers out of your message — URLs, paths, SCREAMING_SNAKE, camelCase, long kebab-case, hex-ish codes — and keep only those <em>absent from the visible transcript</em>. If you name something concrete the model cannot already see, and a memory mentions it, that memory&apos;s body is included. No model decision is involved.</p><div className="overflow-hidden rounded-xl border border-white/[0.08]"><div className="grid grid-cols-[92px_1fr] border-b border-white/[0.07] bg-white/[0.025] px-4 py-2 font-mono text-[9px] uppercase tracking-widest text-zinc-600"><span>Reason</span><span>What was included</span></div>{reasons.map(([reason, detail]) => <div key={reason} className="grid grid-cols-[92px_1fr] border-b border-white/[0.06] px-4 py-3 last:border-0"><code className="font-mono text-[11px] text-violet-200">{reason}</code><span className="text-xs leading-5 text-zinc-400">{detail}</span></div>)}</div><Code language="text">{indexSample}</Code><p><code className="font-mono text-[11px] text-zinc-300">maxTotalTokens</code> caps everything injected in one prompt, index and bodies together. When the cap bites the report says so rather than silently dropping the tail.</p><Note title="Why an index rather than everything">Research on context rot finds that accuracy degrades with input length across models, and that the damage comes from topically-related distractors rather than from structure. A small, high-signal index with on-demand bodies keeps recall cheap without filling the window with material that is usually irrelevant.</Note></DocSection>

    <DocSection id="recall" title="The recall tool"><p>Pre-staging is a best-effort optimisation: a model may not read the index, and a question sharing no words with a memory will not have it staged. The <code className="font-mono text-[11px] text-zinc-300">recall</code> tool lets the agent ask directly. Ranking runs in-process with the same token-overlap scoring used for promotion, so recall quality does not depend on model quality.</p><Code language="text">{recallSample}</Code><p>When nothing matches it says so, and tells the model to say it was not told rather than guessing. It is read-only, so it is not approval-gated. The CLI registers it automatically alongside the coding tools.</p></DocSection>

    <DocSection id="observability" title="Seeing what it cost"><p>There is no published benchmark for pre-inject versus on-demand retrieval for coding-agent project memory, so the only way to tune the tradeoff is to watch it. Every injection is recorded with its reason and token cost.</p><Code language="text">{logSample}</Code><p>Use it to decide whether the budget is too tight, whether the trigger is firing when it should, and whether an index line is enough or the model keeps reaching for recall.</p></DocSection>

    <DocSection id="arbiter" title="Promotion and the arbiter"><p>After extraction, warm candidates are scored against the current turn by content-word overlap, and the best few are promoted. Scoring used to compare a single domain tag against the turn text with a substring match, which almost never fired — a memory tagged <code className="font-mono text-[11px] text-zinc-300">naming-conventions</code> cannot match a question that says 'naming'. Promotion was effectively random.</p><p>Supply <code className="font-mono text-[11px] text-zinc-300">arbiter</code> to decide tiers with a model instead. An arbiter is just a function receiving the turn text, the assistant reply, the L0 prompt, the L1 summaries and the L2 candidates, returning a structured <code className="font-mono text-[11px] text-zinc-300">ArbiterEvaluationResult</code>. One that throws returns an empty result rather than failing the turn.</p><Code language="ts">{setupSample}</Code></DocSection>

    <DocSection id="self-model" title="Self-model and knowledge tensions"><p>The self-model tracks per-domain reliability as a moving average, plus known failure patterns and recommended strategies. Any active domain below 75% reliability is rendered into L0 as a guardrail, so weak areas get explicit attention instead of confident guesses.</p><p>Active tensions are pinned into every prompt block until resolved, each paired with an actionable question so the agent asks rather than guesses. <code className="font-mono text-[11px] text-zinc-300">addTension</code>, <code className="font-mono text-[11px] text-zinc-300">resolveTension</code> and <code className="font-mono text-[11px] text-zinc-300">recordDomainOutcome</code> drive both.</p></DocSection>

    <DocSection id="persistence" title="Persistence"><p>The CLI stores memory per working directory under <code className="font-mono text-[11px] text-zinc-300">~/.nah/memory</code> and reloads it on the next run, so a fact you taught yesterday is available in a session that starts today. Set <code className="font-mono text-[11px] text-zinc-300">NAH_MEMORY_NOPERSIST=1</code> to keep memory in-process only.</p><p>Memory is entirely in-process plus the JSON snapshot; the agent is never asked to author or maintain memory files by hand.</p></DocSection>

    <DocSection id="api" title="API surface"><div className="space-y-2">{api.map(([name, desc]) => <div key={name} className="grid gap-1 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 sm:grid-cols-[280px_1fr] sm:gap-4"><code className="font-mono text-[10px] leading-5 text-violet-200">{name}</code><span className="text-xs leading-5 text-zinc-500">{desc}</span></div>)}</div><p>Types for every item above — <code className="font-mono text-[11px] text-zinc-300">MemoryItem</code>, <code className="font-mono text-[11px] text-zinc-300">MemoryInjectionReport</code>, <code className="font-mono text-[11px] text-zinc-300">MemoryInclusionReason</code>, <code className="font-mono text-[11px] text-zinc-300">KnowledgeTension</code>, <code className="font-mono text-[11px] text-zinc-300">CognitiveMemoryOptions</code> — are exported from the package root alongside the class.</p><p>There is also <code className="font-mono text-[11px] text-zinc-300">packages/nah/eval-memory.mts</code>, which teaches facts containing unguessable tokens, wipes the transcript, and asks again — so anything the model can still answer came out of memory rather than context.</p><Link href="/docs/agent-loop" className="text-violet-200 hover:text-white">How memory fits into the loop →</Link></DocSection>
  </DocsShell>;
}