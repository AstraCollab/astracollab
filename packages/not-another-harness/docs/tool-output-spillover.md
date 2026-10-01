# Tool output spillover

Design for letting a tool hand back a pointer instead of a wall of text, and
using that to make an aggressive inline cap safe.

## The problem

Every model step replays the transcript, so a large tool result is paid for again
on every later step of the run. A 30 KB `npm test` result that arrives on step 4
is re-billed on steps 5 through 20.

The naive fix — cap the output — does not work. This repo already learned that:

> `bash` is deliberately left roomy. Its truncation notice tells the agent to
> re-run the command with `| tail -n N`, which pays for the same output twice. A
> live audit run cut at 120 lines did exactly that and cost more than the
> original.
> — the previous `caps.ts` header

The cap was not the mechanism. The **notice** was: it invited a re-execution of
the expensive part. With output truncated and unrecoverable, the agent's only
move is to run the command again.

## The unlock

Spillover changes what the agent can do instead: write the full output to a file
the harness owns, and return a small preview plus the path. The output is then
*recoverable*, so the inline cap can drop as far as is useful — and cutting the
inline cap is the actual prize, not the spill itself.

Claude Code expresses this directly. Its inline ceiling is configurable down to
4,000 characters (from 30,000), and its docs note that raising or lowering it
"does not remove the spill — a result over the inline ceiling still arrives as
path + preview." The knob is safe because the spill is the safety net.

Without a spill, our ceiling can only go so low before the re-run cost returns.
That is the whole argument for doing this before tightening further.

## What the references actually do

Verified against primary sources.

| | Location | Git pollution | Preview | Failure path |
|---|---|---|---|---|
| **Claude Code** | `~/.claude/projects/<proj>/<session>/tool-results/` | None | head, 2,000 chars + path | head+tail 10,000, **no path** |
| **Crush** | `<dataDir>/shell-output/` — **inside the project** | **Yes** (untracked; no gitignore entry found) | head+tail, symmetric line+byte budget + path | same |
| **goose** | `tempfile::TempDir()`, 8 rotating slots | None | **tail-only**, 50 lines / 10,000 bytes + path + read recipe | same |
| **Codex** (hook output only) | `os.temp_dir()/hook_outputs/<thread_id>/` | None | head+tail 50/50, token-bounded, footer budgeted out | same |

Notable: **no harness spills shell output to a file inside the project except
Crush**, and Crush is the one with the git-pollution exposure. Every other one
puts it outside the working tree.

Codex does not spill shell output at all — it truncates head+tail and tells the
model how much was dropped. That is a legitimate cheaper design; it just makes
the output permanently unrecoverable.

## Our design

### Location

```
~/.nah/sessions/<session-id>/tool-output/
```

Outside the repository, beside the session transcript that already lives at
`~/.nah/sessions/<id>.jsonl`. Chosen over Crush's in-project directory for one
reason: command output lands in the working tree untracked, and `git add -A`
commits it. Build logs are exactly the kind of output that contains credentials
from a failed auth step.

### Requirements

These are the six details worth copying, each with the reason it exists.

**1. Success/failure asymmetry.** A successful command that exceeds the inline
ceiling gets a head-only preview **and a path**. A failing one gets a head+tail
excerpt and **no path, and is never spilled**.

Two reasons. On failure the useful part is at the end — the stack trace — so
head+tail is right and deferral buys little. And failure output is the most
likely to contain secrets: an auth error, a connection string with a password, a
token echoed by a failed request. Not spilling it shrinks the plaintext-at-rest
surface precisely where it is most likely to matter.

**2. Filenames never derive from input.** `<uuid>.txt`, owner-only, `0o700` on
the directory. A filename built from the command text would let a command
influence where its own output is written. Codex's layout also puts the thread id
in the *directory*, so concurrent sessions cannot collide.

**3. Two-axis eviction.** 7 days **or** 512 MiB, whichever comes first, age before
size. The non-obvious half is the size bound — Crush's comment on it is the
lesson:

> Age alone does not bound disk: a busy afternoon of large tool output can fill it
> well inside the retention window, so the oldest files go early to stay under
> this.

Deletion is pattern-scoped (`*.txt` in a directory we own) so a misconfigured path
cannot take unrelated files with it.

**4. Cap the artifact, not just the threshold.** Per-file cap of 16 MiB. The
reference caps at 64 MiB against a 30 KB threshold — the same order of ratio.
Without a per-file cap, one `git log -p` on a large repository spends the entire
directory budget on a single file.

**5. The footer is budgeted out of the preview.** The preview allowance is 2,000
characters *total*, and the recovery footer is subtracted from it before the
preview is cut. Otherwise the footer is what pushes the result back over the
limit it was meant to stay under — Codex's explicit reason for doing it this way.

**6. ANSI is stripped before spilling and before previewing.** Truncation cuts
land mid-stream, where an unterminated escape sequence bleeds styling into the
rest of the transcript. The stored artifact is stripped too, which also makes it
greppable and `sed`-able.

### Constants

| | Value |
|---|---|
| Directory | `~/.nah/sessions/<id>/tool-output/`, mode `0o700` |
| File | `<uuid>.txt`, mode `0o600` |
| Inline ceiling, success | **10,000 chars** (dropped from 30,000) |
| Inline ceiling, failure | 10,000 chars head+tail, unchanged |
| Preview budget, success | **2,000 chars including the footer** |
| Per-file cap | 16 MiB |
| Retention | 7 days |
| Directory budget | 512 MiB |

The preview is the *head* of the ANSI-stripped output. The failure path is
unchanged from what is already shipped.

### Result shape

Success, over the ceiling:

```
<first ~1,800 chars of stripped stdout>

[Full output: /Users/you/.nah/sessions/a1b2c3d4e5f6/tool-output/9f2c….txt (48,213 chars).
Read a slice with bash: sed -n '200,400p' /Users/you/.nah/sessions/a1b2c3d4e5f6/tool-output/9f2c….txt]
```

The recipe is in the notice, following goose, so recovery needs no permission
change and no new tool.

### Reachability: a read-only carve-out

`read` is confined to the workspace root, so it cannot reach the spill directory.
The user has approved a narrow widening: **`read`, `exists` and `readdir` may also
reach the session's `tool-output` directory; `write` and `delete` may not.**

This is a small, bounded widening rather than a general one:

- The directory is one the harness itself created and wrote to.
- Access is read-only, so it cannot be used to modify anything outside the
  workspace.
- It is derived from the session id, not from model input.

`read`'s own cap still applies, so paging is still how you read a large spill —
the carve-out only makes the file *reachable*.

## Security posture

Stated plainly rather than presented as new risk:

**Command output is already written to disk in plaintext today.** The session
transcript at `~/.nah/sessions/<id>.jsonl` stores tool results verbatim —
verified: a `bash` tool result containing a fake AWS secret appears in the JSONL
unredacted. Anthropic documents the same for Claude Code:

> If a tool reads a `.env` file or a command prints a credential, that value is
> written to `projects/<project>/<session>.jsonl`.

Spillover therefore adds a **second copy at the same retention**, not a new class
of exposure. Two things follow:

- Failure output not being spilled is a meaningful reduction, because that is
  where secrets concentrate.
- Redacting at the session-store boundary would fix both copies at once. That is a
  separate piece of work and out of scope here.

Two further risks inherent to the mechanism, accepted:

- A spill file outlives the approval that produced the command. You approved
  `npm test` for this turn; its 40 MB log may contain a token from a failed auth
  step and persists for 7 days. The 7-day retention and 512 MiB bound are the
  mitigations.
- The spill path is a model-visible string, so a hostile file in the repository
  could textually impersonate a spill notice. The real path always begins with the
  session directory; the notice format is stable, but this is not detectable by
  the harness.

## Out of scope

- **Streaming to a working file while the command runs.** Claude Code streams
  output to disk as it is produced, which is what lets it both cap the artifact and
  kill a runaway producer at 5 GB. Our `exec` buffers stdout in memory and returns
  a string, so a runaway `yes` will exhaust memory before any of this applies. That
  is a pre-existing limitation of `exec`, not something spillover introduces, and
  fixing it means changing how output is collected.
- **Spilling MCP-style tool results** generically. Only `bash` spills here. The
  other tools' outputs are already bounded by their own caps.
- **Secret redaction.** See above.
- **A content index over spilled files.** The `recall` tool does not cover them,
  and building one is the same problem as indexing the repository.

## Test plan

- Spill store writes to the session directory with `0o700` / `0o600`.
- Filenames are UUIDs and do not contain any part of the command text.
- Preview plus footer never exceeds 2,000 characters, even when the footer is
  pathologically long.
- ANSI escapes are absent from both the preview and the stored artifact.
- A spilled artifact over 16 MiB is truncated, and the notice says so.
- Eviction removes files older than the retention window.
- Eviction removes the oldest files when the directory exceeds its byte budget,
  **even when every file is fresh** — the case age-only retention misses.
- A successful command over the ceiling returns a path; the file exists and holds
  the full output.
- A **failing** command over the ceiling returns head+tail, no path, and writes
  **no file**.
- When no spill store is configured, behaviour is unchanged (graceful degradation).
- The read carve-out reaches `tool-output` and refuses everything else outside the
  workspace.
- `write` and `delete` still refuse the spill directory.
