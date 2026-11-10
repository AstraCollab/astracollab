# Research: isolated worktrees for agents

**Problem:** agents working in the same workspace end up stepping on each other — one agent's edit clobbers another's in-flight change, two children write to the same file, or a child half-applies over a parent edit mid-turn. This report covers what your orchestrator already does, what the published patterns say, and concrete hardening options.

---

## 1. What your orchestrator already does

### Two isolation strategies exist
`packages/not-another-harness/src/orchestrator.ts` defines both, and `packages/nah/src/delegation.ts` chooses between them:

| Strategy | Used by | What it does |
|---|---|---|
| `sharedWorkspaceIsolation()` | `delegate_explore`, `delegate_explores` | Child runs in `.` — the **same** workspace as the parent. Boundary note tells it to coordinate through files. No cleanup work. |
| `createGitWorktreeIsolation(...)` | `delegate_task`, `delegate_tasks` | Child gets a **detached git worktree** in the OS temp dir, branched from a snapshot of the parent's working tree (uncommitted changes included via a throwaway index — no `git stash`, so the parent tree is never touched). Diff is collected on finish, worktree removed by default, retained only when the diff is too large to inline. |

### Key properties of the worktree path (already implemented)
- **One checkout per child.** Two children cannot collide in the same directory; a child cannot half-apply over a parent edit in progress.
- **Snapshot, not stash.** The parent's working tree (including untracked files) is frozen into a throwaway commit using `GIT_INDEX_FILE`, so the parent's real index and working tree are never mutated. A crash mid-delegation cannot leave the user's uncommitted work in a stash.
- **Boundary notes are explicit.** Each child is told: "This is an isolated worktree. Do not attempt to access or modify the parent worktree," and whether the parent's uncommitted changes are included or absent.
- **Diff never auto-applies.** The child's work returns as a diff + `changedPaths`; the parent (or a workflow) reviews and integrates deliberately. This is the safety backstop even if isolation somehow fails.
- **Pluggable.** `SubtaskIsolation` is an interface; `Orchestrator` only needs "a root, some facts, something to review, something to clean up."

### Where the gap is today
`delegate_explore` and `delegate_explores` — the read-only research children — run in the **shared workspace**. They don't write files by design (no edit/write tools), but their `bash` is unrestricted, so a research child can still `sed -i`, `rm`, or `git checkout` files the parent is mid-edit on. The comment in `delegation.ts` acknowledges this: "This is not a promise that nothing changes on disk. `bash` can still write."

So the real risk isn't file-tool collisions between children (the worktree path already prevents that for editing children) — it's:
1. **Explore children with bash** touching shared files.
2. **No cross-child coordination** at all: two `delegate_task` children in separate worktrees can each edit the same logical area, and the parent discovers the conflict only when reviewing both diffs.
3. **No checkpoint / rollback** inside a child's worktree: if a child makes a mess, the only remedy is to throw away the whole worktree (there's no per-file rewind within a child run).
4. **No isolation outside git:** if there's no repository, `createGitWorktreeIsolation` can't run and the harness falls back to shared workspace.

---

## 2. Published research that applies

### Anthropic, "Scaling Managed Agents: Decoupling the brain from the hands" (Apr 2026)
Directly relevant. Anthropic ran into exactly this class of problem when every agent shared one container:

- **"Don't adopt a pet"** — a single shared environment means one failure or unresponsive agent jeopardizes every session running in it. The fix: treat environments as cattle, provision them per need, and let the harness remain outside.
- **The security boundary** — untrusted agent code must never run where credentials live. Git tokens are bundled into the sandbox at clone time and never handed to the agent; MCP/OAuth tokens live in a vault behind a proxy.
- **"Many brains, many hands"** — once models were smart enough to reason across multiple execution environments, the single shared container became the bottleneck. Each brain should reach into its own hand (sandbox/workspace) on demand, and hands can be passed between brains. The interface is `execute(name, input) → string`: a name and input go in, a string comes out. The harness doesn't know whether the hand is a container, a worktree, or an emulator.

Takeaway: **per-agent workspace isolation is not a nice-to-have; it's the structural fix** for "agents mess up each other's work." The orchestrator should provision a fresh, isolated workspace per child on demand, not share one.

### Anthropic Claude Agent SDK — Subagents
Four benefits of subagents map directly to isolation:
1. **Context isolation** — each subagent runs its own conversation; only the final report returns to the parent.
2. **Parallelization** — independent subtasks run concurrently instead of sequentially.
3. **Specialized instructions** — per-child system prompt.
4. **Tool restrictions** — a subagent can be limited to a subset of tools (e.g. read-only for research), making "do not edit" a *capability boundary* rather than an instruction the model can ignore.

Important distinction from the docs: **forking branches the conversation history, not the filesystem.** If a forked agent edits files, those changes are real and visible to any session in the same directory. To branch *and* revert file changes you need file checkpointing — i.e. isolation at the filesystem layer, which is exactly what worktrees give you.

### Anthropic Claude Agent SDK — File Checkpointing
Tracks file modifications through Write/Edit/NotebookEdit and lets you rewind files to any previous checkpoint UUID. Limitations that matter for your case:
- Rewinding restores files on disk; it does **not** rewind the conversation.
- Subagent edits are **not** tracked — only the foreground/main conversation's tool edits are.
- Bash mutations (`sed -i`, etc.) are not tracked unless a Write/Edit also touched the file.

Takeaway: checkpointing complements but does **not** replace worktree isolation. Worktrees isolate *between* children; checkpointing would let a parent roll back its *own* edits mid-turn. They're different layers.

---

## 3. Design space: how to harden isolation

### A. Make worktree isolation the default for editing children
Today `delegate_task`/`delegate_tasks` already use git worktrees. The hardening is to never fall back to shared workspace for a child that has write tools:
- If `createTools` includes write/edit and there's no git repo, refuse or create a **copy-based isolation** (copy the tree to temp, run, diff against original). `sharedWorkspaceIsolation` should be reserved for genuinely read-only children with no bash, or for children whose whole job is to coordinate *in* the shared space (e.g. a merge child).

### B. Remove bash from explore children, or sandbox their bash
`delegate_explore` gives children `bash` (read-only tools + shell). The delegation.ts comment already notes the shell is an escape hatch around the read-only promise. Options:
- Drop `bash` from `EXPLORE_TOOLS` for explore children that truly must not touch disk. The Anthropic subagent model supports `disallowedTools` / tool allowlists — your harness already builds tools per child via `createTools`, so it can simply omit bash.
- If bash is needed (to verify an answer by running a test), restrict it to read-only commands or run it inside the worktree so mutations can't reach the parent tree.

### C. Cross-child conflict detection
Two children in separate worktrees can still edit the same file. The parent sees two diffs and must merge manually. Additive options:
- **Changed-path registry:** the orchestrator records each finished child's `changedPaths`; before starting a new child, flag overlap with in-flight or finished children's paths so the parent can sequence or re-scope them.
- **Merge guidance in the report:** `formatSubtaskReport` could include a "touches these paths also touched by..." line when there's overlap.
- **Workflow-level sequencing:** deterministic steps that touch the same area should not be delegated in parallel; only independent path sets should fan out via `runAll`.

### D. Per-child workspace snapshots / checkpoints inside a worktree
Within a single child run, if the agent makes a bad edit at step 8, today the remedy is to discard the whole child and re-delegate. A lighter option:
- Snapshot the worktree at child start (the base commit already exists).
- Optionally snapshot again at tool-call boundaries (git commit or `cp -r`) so the parent can offer "rewind this child to before step N" — but this adds complexity. Simpler: the child's diff is already bounded to the worktree, so failure is already contained. The parent just re-delegates with a corrected assignment.

### E. Isolation outside git (non-repo workspaces)
`createGitWorktreeIsolation` requires a git repository (`git rev-parse --show-toplevel` fails otherwise). For non-git workspaces:
- Add a fallback: copy the tree to a temp dir, run the child there, produce a diff by `diff -ruN` against the original. Call it `createCopyIsolation` or similar. This keeps the isolation contract ("a root, some facts, something to review, something to clean up") intact without git.

### F. Stronger boundary notes
The current worktree boundary notes are good but could add:
- "Do not run `git worktree` or `git checkout` commands targeting other worktrees."
- "Do not modify files outside this worktree; bash here is confined to this checkout."
- Explicit instruction on what to do when it needs a file from another project (report the path; do not reach out).

---

## 4. Recommended evolution for this repo

These are additive and backward compatible; none changes the `Orchestrator` contract.

1. **Default editing children to worktree, remove shared-workspace fallback for writers.**
   In `delegation.ts`, `delegate_task`/`delegate_tasks` already use worktrees. Add a guard: if a task spec's `createTools` includes write/edit/is-not-read-only and the repo is not a git repo, fall back to a copy-based isolation rather than shared workspace.

2. **Make explore children read-only by default.**
   Remove `bash` from `EXPLORE_TOOLS` unless the question specifically needs execution. If execution is needed, run it inside a worktree so any mutation is contained and discarded.

3. **Add `createCopyIsolation` (temp-dir copy) for non-git workspaces** so worktree-style isolation is available everywhere, not just in git repos.

4. **Cross-child path-overlap tracking in the orchestrator.**
   `Orchestrator` already tracks `totalUsage` and `active`. Add a registry of finished/in-flight `changedPaths` so `runAll` can warn (in `onEvent`) when sibling tasks touch the same files, letting the parent sequence them.

5. **Retain-failure worktrees for debugging.**
   Already partially supported via `retain`. Consider auto-retaining on `status: "error"` so a failed child's worktree is inspectable rather than deleted.

6. **Document the fork/filesystem distinction.**
   The SDK docs are explicit: forking a conversation does not fork the filesystem. If you add workflow-based "try an alternative branch" features, pair them with worktree isolation so the filesystem actually branches too.

---

## 5. Files to touch when implementing

- `packages/not-another-harness/src/orchestrator.ts` — `SubtaskIsolation`, `sharedWorkspaceIsolation`, `createGitWorktreeIsolation`, `Orchestrator` (add overlap tracking if desired).
- `packages/nah/src/delegation.ts` — tool schemas, `EXPLORE_TOOLS`, worktree vs shared selection, report format.
- `packages/not-another-harness/src/index.ts` — export any new isolation strategy.

---

## 6. Sources

- Anthropic, "Scaling Managed Agents: Decoupling the brain from the hands" — per-agent sandbox isolation, many brains/many hands, pets-vs-cattle environments: https://www.anthropic.com/research/managed-agents
- Anthropic Claude Agent SDK, Subagents — context isolation, parallelization, tool restrictions, fork vs filesystem: https://code.claude.com/docs/en/agent-sdk/subagents
- Anthropic Claude Agent SDK, File checkpointing — per-file rewind, limits (subagent edits not tracked, bash not tracked): https://code.claude.com/docs/en/agent-sdk/file-checkpointing
- Existing repo code: `packages/not-another-harness/src/orchestrator.ts` (isolation implementations), `packages/nah/src/delegation.ts` (delegation tool wiring), `packages/nah/src/workspace.ts` (workspace root resolution)