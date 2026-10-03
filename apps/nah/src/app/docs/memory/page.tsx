import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Code, DocHeader, DocSection, DocsShell, Note } from "@/components/docs/DocsShell";

const tiers = [
  ["L0", "Registers", "Unresolved contradictions, per-domain reliability, and the fast-gate notice. Bodies only."],
  ["L1", "Hot cache", "The only tier rendered into the prompt. One gist line each, plus a body where a trigger earns it. Newly taught facts land here."],
  ["L2", "Warm store", "Off the index. Up to 20 candidates go to the arbiter each turn, and the best three above the relevance floor are promoted back to L1."],
  ["L3", "Cold archive", "Searchable and promotable, but nothing writes here on its own. Eviction demotes to L2, so L3 fills only through addMemory(item, \"L3\")."],
];

const learning = [
  ["Deterministic first", "Pattern matching runs before any model call, so a plainly-stated fact is captured even when the model refuses, hedges, or returns nothing."],
  ["Then the model", "The same model that runs the turn extracts facts, preferences, conventions and tensions in the user's own words."],
  ["Never from questions", "A lookup is not a lesson. A message containing a question mark is not extracted from at all — this one is CLI wiring, not engine behaviour."],
  ["Interaction-scoped text is dropped", "\"Do not verify this against the repo\" and \"just remember this\" describe how to behave right now, so they never become project facts."],
  ["Too short or too long is dropped", "Statements under 8 characters or over 600 are discarded before they reach a tier, and the deterministic pass returns at most 6."],
  ["Paraphrases collapse", "A byte-identical restatement always folds into the one you hold. Anything else is put to a reconcile function, which may merge, replace, or reject it."],
];

const wiring = [
  ["extract", "createTurnExtractor(model)", "The same model that runs the turn. Skips questions, and layers deterministic matches under whatever the model returns."],
  ["reconcile", "createMemoryReconciler(model)", "One batched add/merge/replace/reject call per turn over restatements. An unusable answer keeps both statements."],
  ["onPersist", "MemoryStore", "Projects the snapshot onto SQLite rows under ~/.nah/memory after every turn, and restores them on the next run."],
  ["recall", "createRecallTool", "search() exposed to the model as a read-only tool, so pre-staging is never the only way in."],
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
  ["search(query, limit = 8)", "Deterministic ranked lookup across all three memory tiers. Backs the recall tool."],
  ["postTurnAsync({ userMessage, assistantResponse, detectedDomains? })", "Arbiter, extraction, budgets, persistence. Fire and forget; it runs after the response streams."],
  ["addMemory(item, targetTier = \"L2\")", "Adds or promotes a MemoryItem into a tier."],
  ["addTension(tension) / resolveTension(id, { resolvedBy, pattern })", "Registers or closes a contradiction pinned in L0."],
  ["recordDomainOutcome(domain, success, failurePattern?)", "The only writer of the self-model. Moving average, weight 1 / min(samples, 10)."],
  ["getSnapshot() / loadSnapshot(snapshot)", "Serialize or restore the full L0–L3 state and stats."],
];

const options = [
  ["extract", "Model-backed turn extractor. Without one, the built-in regex only recognises \"always/never/must/should/make sure to/remember to\" and learns nothing else."],
  ["reconcile", "Adjudicates a new statement against ones you already hold. Omit it and only byte-identical restatements collapse."],
  ["arbiter", "Decide tiers with a model. Omit it and promotion is deterministic content-word overlap."],
  ["maxTotalTokens", "Ceiling on everything injected into one prompt, index and bodies together. Default 2000."],
  ["maxL1Tokens", "Budget for the hot cache. Default 8000; the least recently used are demoted to L2, never dropped."],
  ["onPersist", "Called with the snapshot after every turn. This is the only persistence hook there is."],
  ["initialSelfModel", "Seed reliability scores and activeDomains. The guardrail block renders from here."],
  ["maxL0Tokens", "Accepted but not read. L0 is bounded by maxTotalTokens; no tiering decision consults it."],
];

const indexSample = [
  "## Cognitive Memory State",
  "### Memory index — established earlier in this project",
  "One line per remembered item. Use `recall` to pull a full item, then treat it as true.",
  "- staging build ID (deployment)",
  "- file naming: kebab-case (naming)",
  "- internal staging host is internal-hbr-2291.example (infra)",
].join("\n");

const logSample = [
  "/memory",
  "",
  "Cognitive Memory Cache State",
  "  Turns processed: 7",
  "  Active tensions: 0",
  "  L1 Hot cache items: 9",
  "  L2 Warm store items: 2",
  "  L3 Cold archive items: 0",
  "",
  "Prompt injection log (what memory added, and why)",
  "  7 turn(s) · avg 58 tokens · max 83",
  "  index=25",
  "  turn 7: 58 tokens",
  "    index [index/L1] staging build ID (deployment)",
  "    body  [trigger/L1] internal staging host is internal-hbr-2291.example",
].join("\n");

const setupSample = [
  "import { CognitiveMemory, createModelArbiter } from 'not-another-harness';",
  "",
  "const memory = new CognitiveMemory({",
  "  extract: myExtractor,       // omit to use only the built-in patterns",
  "  reconcile: myReconciler,    // omit to collapse exact matches only",
  "  arbiter: createModelArbiter({ model: arbiterModel }),",
  "  maxTotalTokens: 2000,",
  "  onPersist: (snapshot) => db.save(snapshot),",
  "});",
].join("\n");

const recallSample = [
  "recall { query: 'staging build id', limit: 6 }",
  "",
  "// Remembered (1 match):",
  "// - The staging build ID is ZQ7X4M2K. (deployment) [L1, relevance 0.75]",
].join("\n");

const cogmemSample = [
  "> /cogmem setup",
  "Service URL [https://cogmem.astracollab.app]:",
  "Key: 1) device credential store  2) paste here  3) use COGNITIVE_MEMORY_KEY  [1]:",
  "  service ok · version 1.4.0 · extractor rules+model",
  "memory → hosted · https://cogmem.astracollab.app",
  "",
  "> /cogmem",
  "Cognitive Memory",
  "  backend   hosted · https://cogmem.astracollab.app",
  "  key       cmk_…1f (40 chars) from the credential store",
  "  memories  14 L1 · 2 L2 · 0 L3",
  "",
  "> /cogmem local",
  "memory → local · everything you already learned is still there",
].join("\n");

export default function MemoryPage() {
  return <DocsShell current="/docs/memory"><DocHeader eyebrow="MEMORY / COGNITIVE MEMORY" title="Remembered, not assumed." description="CognitiveMemory learns durable facts from your turns and puts the relevant ones in front of the model. It is deterministic where it can be: what gets stored, what gets pre-staged, and what a recall returns do not depend on which model you configured. The CLI wires a model around that core — the page says which rules are the engine's and which are the CLI's." />
    <DocSection id="cogmem" title="Cognitive Memory, on its own"><div className="rounded-xl border border-violet-300/15 bg-violet-300/[0.045] p-4 sm:p-5"><p className="font-mono text-[9px] uppercase tracking-[0.14em] text-violet-200/80">cogmem.astracollab.app</p><p className="mt-3 text-xs leading-6 text-zinc-400">The tiers on this page are one implementation of Cognitive Memory — the one NAH runs in-process, against a SQLite file under <code className="font-mono text-[11px] text-zinc-300">~/.nah</code>. It is also a hosted service with its own client: <code className="font-mono text-[11px] text-zinc-300">cogmemory</code> serves the same four tiers, recall, tensions and the self-model over HTTP, with a key and a scope per project, and its <code className="font-mono text-[11px] text-zinc-300">runTurn</code> helper will not let a memory failure take down a turn that already produced an answer. The official site covers that, and the design behind it, in more depth than a CLI page can.</p><a href="https://cogmem.astracollab.app" target="_blank" rel="noreferrer" className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-3 py-2 text-[11px] font-medium text-zinc-950 transition hover:bg-white">cogmem.astracollab.app<ArrowUpRight className="size-3" /></a></div></DocSection>

    <DocSection id="tiers" title="Four tiers, one prompt block"><div className="overflow-hidden rounded-xl border border-white/[0.08]"><div className="grid grid-cols-[36px_92px_1fr] border-b border-white/[0.07] bg-white/[0.025] px-4 py-2 font-mono text-[9px] uppercase tracking-widest text-zinc-600"><span>Tier</span><span>Name</span><span>Contents</span></div>{tiers.map(([tier, name, contents]) => <div key={tier} className="grid grid-cols-[36px_92px_1fr] border-b border-white/[0.06] px-4 py-3 last:border-0"><code className="font-mono text-[11px] text-violet-200">{tier}</code><span className="text-[11px] text-zinc-300">{name}</span><span className="text-xs leading-5 text-zinc-400">{contents}</span></div>)}</div><p>L1 is the only memory tier that reaches the prompt as an index. L2 and L3 stay invisible to the model until something promotes them or recall pulls them, which is what keeps the index a fixed size rather than a function of how long you have worked in a directory.</p><p>Nothing here is required for the agent loop to run — memory is an additive layer you construct yourself.</p></DocSection>

    <DocSection id="learning" title="What gets learned, and what does not"><p>Naive memory only catches phrasings like &apos;always use kebab-case&apos; and silently drops everything else. These rules exist because that made memory look broken: a stated fact simply never reached the tiers.</p><div className="space-y-2">{learning.map(([rule, detail]) => <div key={rule} className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5"><p className="text-[11px] font-medium text-zinc-300">{rule}</p><p className="mt-1 text-xs leading-5 text-zinc-500">{detail}</p></div>)}</div><p>A newly taught memory lands in L1 immediately. Waiting for the arbiter to promote it added a turn of latency, so a fact you taught on one turn was still missing from the next prompt.</p><Note title="A merge cannot lose a fact">Paraphrase collapse is deliberately biased towards keeping both. If the adjudicated replacement drops a distinctive token — an id, a port, a qualifier like &quot;never production&quot; — the merge is refused and both statements survive, and a replacement that contradicts what you hold supersedes the old entry rather than sitting beside it. An extra row costs one line of index; a deleted fact costs the fact.</Note></DocSection>

    <DocSection id="wiring" title="What the CLI adds to the engine"><p>The engine owns the tiers, the budget, the ranking and the merge rules. Everything model-shaped is wiring, and the CLI supplies four pieces. Build your own and the question filter becomes yours too — the engine has no opinion about questions.</p><div className="space-y-2">{wiring.map(([option, builder, detail]) => <div key={option} className="grid gap-1 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 sm:grid-cols-[110px_1fr] sm:gap-4"><code className="font-mono text-[10px] leading-5 text-violet-200">{option}</code><p className="text-xs leading-5 text-zinc-500"><code className="font-mono text-[10px] text-zinc-300">{builder}</code><br />{detail}</p></div>)}</div></DocSection>

    <DocSection id="index" title="Index by default, bodies on demand"><p>Always injecting every memory body is expensive and injects distractors by construction. Instead each turn gets a one-line index of the hot cache, and a full body is spent only where a deterministic signal earns it.</p><p>The trigger is the same idea Aider uses for its repo map: pull identifiers out of your message — URLs, hostnames, paths, SCREAMING_SNAKE, alphanumeric codes, camelCase, long kebab-case, hex-ish codes — and keep only those <em>absent from the visible transcript</em>. If you name something concrete the model cannot already see, and a memory mentions it, that memory&apos;s body is included. No model decision is involved, and hostnames are in the set because a host like <code className="font-mono text-[11px] text-zinc-300">internal-hbr-2291.example</code> is exactly the value a memory holds and a dotted-name pattern used to miss.</p><div className="overflow-hidden rounded-xl border border-white/[0.08]"><div className="grid grid-cols-[92px_1fr] border-b border-white/[0.07] bg-white/[0.025] px-4 py-2 font-mono text-[9px] uppercase tracking-widest text-zinc-600"><span>Reason</span><span>What was included</span></div>{reasons.map(([reason, detail]) => <div key={reason} className="grid grid-cols-[92px_1fr] border-b border-white/[0.06] px-4 py-3 last:border-0"><code className="font-mono text-[11px] text-violet-200">{reason}</code><span className="text-xs leading-5 text-zinc-400">{detail}</span></div>)}</div><Code language="text">{indexSample}</Code><p><code className="font-mono text-[11px] text-zinc-300">maxTotalTokens</code> caps everything injected in one prompt, index and bodies together, and when the cap bites the report is flagged as truncated instead of quietly losing the tail.</p><p>Two things move an entry out of the index, and neither deletes it. An L1 item the turn never mentions is demoted to L2 once the cache holds more than five, and if L1 outgrows <code className="font-mono text-[11px] text-zinc-300">maxL1Tokens</code> the least recently used are demoted the same way. A demoted memory still answers recall and can be promoted back.</p><Note title="Why an index rather than everything">Research on context rot finds that accuracy degrades with input length across models, and that the damage comes from topically-related distractors rather than from structure. A small, high-signal index with on-demand bodies keeps recall cheap without filling the window with material that is usually irrelevant.</Note></DocSection>

    <DocSection id="recall" title="The recall tool"><p>Pre-staging is a best-effort optimisation: a model may not read the index, and a question sharing no words with a memory will not have it staged. The <code className="font-mono text-[11px] text-zinc-300">recall</code> tool lets the agent ask directly. Ranking runs in-process, scoring content-word overlap normalised by the shorter side so the score is comparable across memories of different lengths, and the same scoring promotes to L1 — so recall quality does not depend on model quality.</p><Code language="text">{recallSample}</Code><p>Results that are the same fact restated collapse to the best-scoring one, so a paraphrase cannot take two slots in a single answer. <code className="font-mono text-[11px] text-zinc-300">search</code> defaults to 8; the tool asks for 6 and caps the request at 20. When nothing matches it says so, and tells the model to say it was not told rather than guessing. It is read-only, so it is not approval-gated, and the CLI registers it automatically alongside the coding tools.</p></DocSection>

    <DocSection id="observability" title="Seeing what it cost"><p>There is no published benchmark for pre-inject versus on-demand retrieval for coding-agent project memory, so the only way to tune the tradeoff is to watch it. Every injection is recorded with its reason, its tier and its token cost, for the last 20 turns.</p><Code language="text">{logSample}</Code><p>Use it to decide whether the budget is too tight, whether the trigger is firing when it should, and whether an index line is enough or the model keeps reaching for recall. The cost is <code className="font-mono text-[11px] text-zinc-300">ceil(chars / 4)</code> over the gist, the tags and any body — cheap enough to compute on the critical path and good enough for relative tuning, but it is an estimate rather than a provider token count.</p></DocSection>

    <DocSection id="arbiter" title="Promotion and the arbiter"><p>The arbiter runs at the top of <code className="font-mono text-[11px] text-zinc-300">postTurnAsync</code>, over warm candidates left by earlier turns. Anything learned in the current turn has already gone to L1, so a fact you teach is indexed from the very next prompt and is first judged for promotion on the turn after that.</p><p>With no arbiter configured, promotion is deterministic: warm candidates are scored against the current turn by content-word overlap and the best three above the floor are promoted. Scoring used to compare a single domain tag against the turn text with a substring match, which almost never fired — a memory tagged <code className="font-mono text-[11px] text-zinc-300">naming-conventions</code> cannot match a question that says &apos;naming&apos;. Promotion was effectively random.</p><p>Supply <code className="font-mono text-[11px] text-zinc-300">arbiter</code> to decide tiers with a model instead, or take <code className="font-mono text-[11px] text-zinc-300">createModelArbiter</code>, which is exported from the package root and lives in its own entry point so a consumer who only wants the deterministic core does not have to install a model SDK. An arbiter receives the turn text, the assistant reply, the L0 prompt, the L1 summaries and the L2 candidates, and returns a structured <code className="font-mono text-[11px] text-zinc-300">ArbiterEvaluationResult</code>.</p><Code language="ts">{setupSample}</Code><Note title="Wrap your arbiter">The engine catches failures from extraction and persistence and carries on, but it does not catch a throwing arbiter. One that rejects takes the rest of that turn&apos;s memory work with it — extraction, budgets and persistence are all skipped — so the turn itself survives and memory quietly stops updating. Return empty arrays rather than throwing.</Note></DocSection>

    <DocSection id="self-model" title="Self-model and knowledge tensions"><p>The self-model tracks per-domain reliability as a moving average, plus known failure patterns and recommended strategies. A domain in the active list below 75% reliability is rendered into L0 as a guardrail on every prompt, so weak areas get explicit attention instead of confident guesses.</p><p>Nothing populates it by itself. A guardrail needs the domain in <code className="font-mono text-[11px] text-zinc-300">activeDomains</code> — from <code className="font-mono text-[11px] text-zinc-300">initialSelfModel</code>, or by passing <code className="font-mono text-[11px] text-zinc-300">detectedDomains</code> to <code className="font-mono text-[11px] text-zinc-300">postTurnAsync</code> — and at least one recorded outcome. <code className="font-mono text-[11px] text-zinc-300">recordDomainOutcome</code> is the only writer, and the CLI never calls it, so a fresh install shows an empty self-model and injects no guardrails until you wire it yourself.</p><p>Active tensions are pinned into every prompt block until resolved, each paired with an actionable question so the agent asks rather than guesses. This is the one part of L0 the CLI fills on its own, because the turn extractor may report a contradiction it saw. <code className="font-mono text-[11px] text-zinc-300">addTension</code> and <code className="font-mono text-[11px] text-zinc-300">resolveTension</code> drive it from outside; <code className="font-mono text-[11px] text-zinc-300">/tensions resolve &lt;id&gt;</code> closes one in the CLI.</p></DocSection>

    <DocSection id="persistence" title="Persistence"><p>The CLI stores memory per working directory at <code className="font-mono text-[11px] text-zinc-300">~/.nah/memory/&lt;cwd-hash&gt;.sqlite</code> — twelve hex characters of a SHA-1 over the resolved directory path, so two projects never share a store and a path with spaces in it is still a filename — and reloads it on the next run, so a fact you taught yesterday is available in a session that starts today. It uses <code className="font-mono text-[11px] text-zinc-300">node:sqlite</code>, so there is no native module to install, and a memory file from an earlier version is imported once and kept as <code className="font-mono text-[11px] text-zinc-300">.json.imported</code> rather than deleted.</p><p>Memory is stored independently of the transcript, so a turn can be persisted while its memory is not and the other way round. Three switches control it:</p><div className="overflow-hidden rounded-xl border border-white/[0.08]"><div className="grid grid-cols-[210px_1fr] border-b border-white/[0.07] bg-white/[0.025] px-4 py-2 font-mono text-[9px] uppercase tracking-widest text-zinc-600"><span>Switch</span><span>Effect</span></div>{[["--no-session", "Keeps the session and its memory in-process for the life of the run."], ["NAH_MEMORY_NOPERSIST=1", "Disables the store on its own, for the SDK path as well as the CLI. Memory still works within the process."], ["NAH_MEMORY_DEBUG=1", "Traces deterministic matches, model extraction, arbiter scores and persistence per turn."]].map(([flag, effect]) => <div key={flag} className="grid grid-cols-[210px_1fr] border-b border-white/[0.06] px-4 py-3 last:border-0"><code className="font-mono text-[11px] text-violet-200">{flag}</code><span className="text-xs leading-5 text-zinc-400">{effect}</span></div>)}</div><p>Memory is entirely in-process plus that database; the agent is never asked to author or maintain memory files by hand.</p></DocSection>

    <DocSection id="hosted" title="Local or hosted, your choice"><p>Everything above runs in-process against a SQLite file under <code className="font-mono text-[11px] text-zinc-300">~/.nah</code>. The same cognitive layer is also available as a hosted service, and <code className="font-mono text-[11px] text-zinc-300">/cogmem</code> switches between them without changing what the model sees — same tiers, same index/body split, same deterministic recall. Only where the memories live changes.</p><Code language="text">{cogmemSample}</Code><p>Two things are deliberately not done for you. The local store is never touched when you connect, so <code className="font-mono text-[11px] text-zinc-300">/cogmem local</code> brings everything back and nothing is copied anywhere until <code className="font-mono text-[11px] text-zinc-300">/cogmem import</code> is confirmed. And a service that is unreachable never fails a turn: the prompt block is skipped, the reason is shown in <code className="font-mono text-[11px] text-zinc-300">/cogmem</code> and <code className="font-mono text-[11px] text-zinc-300">/memory</code>, and the same is true at startup — hosted memory with no usable key falls back to local and says why, because a silent fallback is indistinguishable from working memory until a fact fails to arrive.</p><p>The key comes from <code className="font-mono text-[11px] text-zinc-300">COGNITIVE_MEMORY_KEY</code> if that is set, and from the platform credential store otherwise, in the same place provider keys live. <code className="font-mono text-[11px] text-zinc-300">COGNITIVE_MEMORY_URL</code> overrides the service URL, which is what makes a self-hosted deployment one variable away. In hosted mode the service does the extraction, so the turns you have are sent to it to learn from — the trade for not spending a model call per turn on your own provider.</p></DocSection>

    <DocSection id="api" title="API surface"><p className="font-mono text-[9px] uppercase tracking-widest text-zinc-600">Methods</p><div className="space-y-2">{api.map(([name, desc]) => <div key={name} className="grid gap-1 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 sm:grid-cols-[300px_1fr] sm:gap-4"><code className="font-mono text-[10px] leading-5 text-violet-200">{name}</code><span className="text-xs leading-5 text-zinc-500">{desc}</span></div>)}</div><p className="pt-2 font-mono text-[9px] uppercase tracking-widest text-zinc-600">Constructor options</p><div className="space-y-2">{options.map(([name, desc]) => <div key={name} className="grid gap-1 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 sm:grid-cols-[300px_1fr] sm:gap-4"><code className="font-mono text-[10px] leading-5 text-violet-200">{name}</code><span className="text-xs leading-5 text-zinc-500">{desc}</span></div>)}</div><p>Types for every item above — <code className="font-mono text-[11px] text-zinc-300">MemoryItem</code>, <code className="font-mono text-[11px] text-zinc-300">MemoryInjectionReport</code>, <code className="font-mono text-[11px] text-zinc-300">MemoryInclusionReason</code>, <code className="font-mono text-[11px] text-zinc-300">MemoryReconciliation</code>, <code className="font-mono text-[11px] text-zinc-300">KnowledgeTension</code>, <code className="font-mono text-[11px] text-zinc-300">CognitiveMemoryOptions</code> — are exported from the package root alongside the class, as are the deterministic primitives it ranks with: <code className="font-mono text-[11px] text-zinc-300">extractDeterministic</code>, <code className="font-mono text-[11px] text-zinc-300">extractIdentifiers</code>, <code className="font-mono text-[11px] text-zinc-300">isInteractionScoped</code>, <code className="font-mono text-[11px] text-zinc-300">runFastGate</code>, <code className="font-mono text-[11px] text-zinc-300">relevanceTokens</code> and <code className="font-mono text-[11px] text-zinc-300">overlapScore</code>.</p><p>There is also <code className="font-mono text-[11px] text-zinc-300">packages/nah/eval-memory.mts</code>, which teaches facts containing unguessable tokens, wipes the transcript, and asks again — so anything the model can still answer came out of memory rather than context.</p><Link href="/docs/agent-loop" className="text-violet-200 hover:text-white">How memory fits into the loop →</Link></DocSection>
  </DocsShell>;
}
