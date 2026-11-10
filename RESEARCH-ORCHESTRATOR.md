# Orchestrator improvement research

**Goal:** make the orchestrator smart enough to (1) cross-reference other projects and (2) work well with free/open-weight models, which are less capable than flagship models.

This is a research memo, not a code change. It summarizes what the orchestrator is today, what the published patterns say, and a prioritized set of changes for this repo.

---

## 1. What the orchestrator is today

### Where it lives
- `packages/nah/src/delegation.ts` — parent-facing tools: `delegate_task`, `delegate_tasks`, `delegate_explore`, `delegate_explores`. Each builds a `SubtaskSpec` and hands it to the harness `Orchestrator`.
- `packages/not-another-harness/src/orchestrator.ts` — the core `Orchestrator` class.
- `packages/nah/src/session.ts` / `state.ts` — one shared orchestrator per session, used by both direct delegation and `/workflow` steps.
- `packages/not-another-harness/src/orchestrator.ts` exports `orchestratorPrompt()` (system-prompt guidance for the parent) and `formatSubtaskReport()` (how a child's result is rendered back to the parent).

### Core mechanics (from `orchestrator.ts`)
- `run(spec)` runs one subtask as an isolated child agent; rejects with `OrchestratorBusyError` when at the concurrency cap (default 3).
- `runAll(specs)` runs a plan in waves up to the cap; settles every task even if one fails.
- `runWorkflow(workflow, ...)` gives each deterministic step `delegate` / `delegateAll` plus `pendingWorkflows` / `resumeWorkflow` (suspend/resume for human answers).
- Each child gets a **fresh transcript**, a **workspace snapshot** (git worktree by default), **boundary notes**, its own tool set, per-task step/spend/time caps, and an inline diff capped at 30k chars (longer diffs retain the workspace).
- Events stream via `onEvent` (subtask-start / subtask-event / subtask-finish); usage folds into the parent's totals.

### What it does NOT do today
- No automatic decomposition: the parent or workflow must write each assignment.
- No cross-repository awareness: a child works in one workspace; nothing indexes or reads other projects.
- No model-provider support for local/open-weight models: `packages/nah/src/model.ts` supports `anthropic`, `openai`, `openrouter`, `openai-compatible`. There is no ollama / llama.cpp / vLLM / local provider.
- No structured-output / grammar enforcement, which is what makes weak models reliably call tools.

---

## 2. Published patterns that apply (research)

### Anthropic, "Building effective agents" (Dec 2024)
The orchestrator here matches their **orchestrator-workers** pattern: a central LLM dynamically breaks down tasks, delegates to workers, and synthesizes results. Their key takeaways relevant to us:

1. **Workflows for predictable parts, agents only where flexibility is needed.** Don't add complexity unless it measurably improves outcomes.
2. **Routing:** send easy/common tasks to small/cheap models, hard/unusual ones to capable models. This is directly applicable to running open-weight models for the easy subtasks.
3. **Evaluator-optimizer:** one model generates, another reviews/feedback-loops. A natural fit for "weak model proposes, stronger model (or the same model with a checklist) verifies."
4. **Tool prompt engineering (Appendix 2):** this is the most actionable section. Weak models fail at tools mostly because of format. Recommendations:
   - Give the model tokens to "think" before acting.
   - Keep tool formats close to natural text; avoid formats with overhead (e.g. counting thousands of lines for diffs, JSON-escaping code).
   - Add examples, edge cases, input-format requirements, and clear boundaries between similar tools.
   - **Poka-yoke** the tools: make it harder to make a mistake than to make it right.
   - Real example from Anthropic's SWE-bench agent: relative filepaths broke after directory changes → switched to absolute paths; usage became flawless.
   - They spent more time optimizing tools than the overall prompt.

### OpenAI, "Structured Outputs"
For weaker models, **schema-enforced output** matters more than prompting. JSON Schema mode (`strict: true`) guarantees the model emits valid, schema-conformant arguments — no retry loop for malformed JSON. For open-weight models served locally, the equivalent is **grammar/constrained decoding** (llama.cpp GBNF grammars, vLLM/SGLang guided decoding, outlines).

### Claude Agent SDK
Confirms the same decomposition: subagents for focused subtasks, tool runner for the loop, hooks/sessions/MCP for extensibility. The design principle — "start simple, add complexity only when measured to help" — matches this repo's existing `delegate_explore` guidance ("declining to delegate is a correct outcome").

---

## 3. Goal A — cross-reference other projects

There is currently no concept of "other projects" in the orchestrator. Patterns to borrow:

| Pattern | What it gives us | Relevance to nah |
|---|---|---|
| **Project registry** | A known list of repos/projects with paths and descriptions, so the orchestrator can address them by name. | Easy first step; no ML required. |
| **Code RAG / symbol index** | Index symbols, imports, and call graphs across repos; retrieve relevant snippets into a child's prompt. | Fits alongside `cognitive-memory` (already in this repo). |
| **MCP clients for code hosts** | Read GitHub/GitLab/repos without checking them out. | Good for cross-repo read-only research (like `delegate_explore`). |
| **Fan-out exploration across repos** | `delegate_explores` already runs several questions in parallel; extend so each question can target a different workspace/repo. | Direct extension of an existing tool. |
| **Repo summaries / boundary notes** | Each child gets a summary of related projects (what they expose, where their APIs live) as boundary notes, so cross-repo references are explicit rather than assumed. | Reuses `boundaryNotes` already passed to children. |

**Recommended first step:** add a lightweight project registry + extend `delegate_explore(s)` so a question can name another project/workspace, then index symbols for retrieval. Do not build a vector database first — start with keyword/symbol search (tree-sitter or grep-based), which is cheap and explainable.

---

## 4. Goal B — work well with free/open-weight models

Open-weight models (e.g. Llama, Qwen, DeepSeek locally served) are weaker at: multi-step planning, reliable tool calling, long-context reasoning, and recovering from a wrong turn. The orchestrator must compensate structurally rather than hoping the model is smart enough.

### Structural changes that help weak models
1. **Decompose harder.** Orchestrator-workers only works if each worker task is *easier* than the whole. Weak models need smaller, more atomic subtasks with explicit acceptance criteria — which is already the `subtaskSchema` contract, but it should be enforced more aggressively (min detail, max scope).
2. **Enforce structured tool output.** Use JSON Schema / grammar-constrained decoding so a weak model can't emit malformed tool arguments. The OpenAI "Structured Outputs" doc shows the model; locally this means llama.cpp GBNF or vLLM guided decoding wired into the model call.
3. **Poka-yoke every tool.** Make the wrong call impossible or trivially caught: absolute paths only (Anthropic's SWE-bench finding), no diff-line-counting, enums instead of free text where possible, one clearly-named tool per job.
4. **Router / model split.** Route easy subtasks (search, read, summarize) to the open-weight model and hard ones (plan, refactor across files, debug) to a stronger model. Anthropic's routing workflow is the template; this repo already supports per-provider model resolution in `model.ts`, so a router is a small addition.
5. **Evaluator-optimizer loop.** After a weak-model child finishes, run a verification pass (schema check + test run + a second model reviewing the diff) before presenting it. The orchestrator's `onEvent`/`onUsage` hooks already observe each child; add a verification wrapper.
6. **Respect small context windows.** Local models often have short windows. Keep child prompts compact: fresh transcripts already help; add explicit summarization of boundary notes and retrieval of only relevant snippets instead of dumping whole files.
7. **Human-in-the-loop checkpoints.** The suspend/resume workflow (`pendingWorkflows`/`resumeWorkflow`) is already there; use it to pause weak-model agents before mutating changes and require approval. This is already the approval gate in `delegation.ts`; make it explicit for weak models.

### What's missing in this repo today
- No local model provider (ollama/llama.cpp/vLLM). `model.ts` would need a `local` or `llama-cpp` case, or reuse `openai-compatible` with a local base URL (which actually works today for vLLM-like servers).
- No structured-output enforcement for tool calls.
- No per-model capability metadata (context window, cost, strength tier) to drive a router.
- No eval harness to measure weak-model delegation success before rolling it out.

---

## 5. Combined recommendation: "weak-model-aware orchestrator"

The two goals reinforce each other: cross-repo work is exactly the kind of broad, uncertain task where a weak model gets lost, so decomposition + verification matters most there.

A practical evolution:

1. **Phase 1 (no ML):** project registry + cross-repo `delegate_explore` targeting; boundary notes include related-project summaries.
2. **Phase 2 (tool hygiene):** poka-yoke tools (absolute paths, enums, small schemas), per-subtask step caps tuned smaller, mandatory acceptance criteria.
3. **Phase 3 (model-aware):** per-model capability metadata (tier, context window, cost) in model resolution; a router that assigns subtasks to open-weight vs. strong models; structured output / guided decoding where available.
4. **Phase 4 (verification):** evaluator-optimizer wrapper around weak-model children (schema + tests + review) before diff is shown; suspend/resume checkpoints for mutations.
5. **Phase 5 (eval):** a small eval suite of representative subtasks run against the open-weight model to measure delegation success before promoting it.

---

## 6. Concrete files to touch (when you're ready to implement)

- `packages/nah/src/delegation.ts` — add cross-repo targeting to `delegate_explore(s)`, tighter subtask schema, per-task caps.
- `packages/not-another-harness/src/orchestrator.ts` — optional verification wrapper / per-task capability routing (keep core simple; the Anthropic principle is simplicity first).
- `packages/nah/src/model.ts` — add model capability metadata; local provider is optional (openai-compatible already reaches vLLM/llama.cpp servers).
- `packages/nah/src/model-preferences.js` / tier config — define model tiers (weak/open-weight vs. strong) for routing.
- Existing `cognitive-memory` package — natural place for cross-project symbol/index storage.

---

## 7. Sources

- Anthropic, "Building effective agents" — orchestrator-workers, routing, evaluator-optimizer, tool prompt engineering/poka-yoke: https://www.anthropic.com/research/building-effective-agents
- Anthropic, Claude Agent SDK overview (subagents, tool runner, MCP, sessions): https://code.claude.com/docs/en/agent-sdk/overview
- OpenAI, Structured Outputs (JSON Schema enforcement; rationale for weak models): https://developers.openai.com/api/docs/guides/structured-outputs
- Existing repo code: `packages/nah/src/delegation.ts`, `packages/not-another-harness/src/orchestrator.ts`, `packages/nah/src/model.ts`, `apps/nah/src/app/docs/orchestrator/page.tsx`

None of this requires a framework; per the Anthropic article, the right move is simple, composable additions to the existing orchestrator, each validated by an eval before the next one.