# Streaming command output

Design for collecting `exec` output without buffering it in the parent, and for
bounding a runaway producer.

## Correction first

I previously wrote that a runaway `yes` "exhausts memory" before any cap
applies. **That was wrong, twice.**

- `runCommand` already caps at `MAX_OUTPUT_BYTES = 8 MiB` per stream
  (`node.ts:317`), checked before each append. The parent does not OOM.
- Measured: `yes` sits at ~1.1 MB RSS and never grows. It is not the memory
  problem.

So the parent is bounded. The real defects are different, and one of them is
severe.

## What is actually wrong

### 1. The run can hang forever — reproduced

`runCommand` resolves on `child.on("close")`. Node documents that `'close'` fires
only after the child's **stdio streams have closed**, and a grandchild that
inherits stdout holds that pipe open after the direct child exits. Two independent
implementations shipped a drain timeout for exactly this — Codex at 2 s
(`IO_DRAIN_TIMEOUT_MS`) and goose at 500 ms (`OUTPUT_DRAIN_TIMEOUT_MILLIS`).

Measured against the shipped harness, `timeoutSeconds: 2`:

```
$ python3 -c "import os,time; os.setsid(); time.sleep(30)" & echo parent-done
HUNG after 8004ms (timeoutSeconds was 2)
```

The timeout fires and SIGKILLs the process group, but a grandchild that called
`setsid` is in a different group, survives, and keeps the pipe open. `close` never
fires, so the promise never settles and **the turn is wedged permanently**. This is
reachable by ordinary shell usage — `npm run dev &`, a test that backgrounds a
server, `docker compose up &`.

It is not fixed by the group kill, because the process that holds the pipe is
deliberately outside the group we kill.

### 2. Output past 8 MiB vanishes silently

`if (stdout.length < MAX_OUTPUT_BYTES) stdout += ...` drops the excess with no
marker, no artifact, and the tail discarded. For a build or a test run the tail is
usually the part that matters. The model sees output that simply stops, with
nothing to distinguish "the command finished" from "we discarded 40 MB".

Note also that `stdout.length` counts UTF-16 code units, so the nominal 8 MiB is
up to 16 MiB of heap per stream, twice over.

### 3. Multi-byte characters are corrupted at chunk boundaries

`chunk.toString("utf8")` decodes each chunk independently. Stream chunk boundaries
are arbitrary byte offsets, so a 3-byte `€` (`E2 82 AC`) split across two chunks
becomes two U+FFFD. Verified: chunk boundary at 8191 → `"\uFFFDb"` with per-chunk
decoding, `"€"` with `StringDecoder` or `setEncoding("utf8")`.

### 4. There is no artifact

Nothing recoverable. The spillover design needs a file the harness owns; today the
full output only ever existed as a string in the parent.

## Design

### The mechanism

```
child.stdout ──┐
               ├─► Transform (byte counter) ─► WriteStream ─► spill file
child.stderr ──┘
```

with `detached: true` so the child leads its own process group and
`process.kill(-pid, "SIGKILL")` reaches its grandchildren — which the existing
code already does correctly.

**Completion never depends on `'close'`.** Resolve on `finished(writeStream)`
raced against the existing timeout, and treat `'exit'` as advisory. `'close'` is
the one event that can be withheld indefinitely by an unrelated process, so
depending on it is the bug. Nothing else needs it: with a `WriteStream` in the
chain there is no pipe for a grandchild to hold.

Backpressure is handled by `stream.pipeline()`, which the Node docs describe as
abstracting "the handling of backpressure and backpressure-related errors" and
which also propagates stream `'error'` — the `pipe()` docs warn the writable is
*not* closed automatically on a readable error, which is a leak if wired by hand.

**Raw buffers, never decoded.** `Buffer` chunks go straight through the
`Transform` to the file; decoding happens once, at read-back, on a whole window.
This sidesteps the multibyte problem entirely and keeps the counter honest —
`chunk.length` is bytes. The common bug here is counting
`Buffer.byteLength(chunk.toString())`, which inflates on split multibyte
characters because each becomes a 3-byte U+FFFD; `octocode` has exactly that bug.

**SIGKILL, not SIGTERM, on a volume breach.** Node's own docs warn the delivered
signal "may not actually terminate the process". A resource cap is not a
cooperative cancellation. TERM stays for timeout and abort, where cleanup matters.

### Rejected: fd redirection

The other approach is to hand the child the file descriptor directly —
`stdio: ["ignore", fd, fd]` — so the kernel writes the file and no JavaScript ever
touches the bytes. It is genuinely simpler and it does fix the hang: measured,
`close` fires in **5 ms** even with a `setsid` grandchild, versus hanging
indefinitely through a pipe.

It was rejected on one measured ground. A byte cap then requires polling
`fstat`, and a fast producer outruns the poll:

```
poll 250ms, cap 32 MiB -> wrote 119 MiB   (87 MiB overshoot)
poll  50ms, cap 32 MiB -> wrote  40 MiB   ( 8 MiB overshoot)
```

`yes` sustains roughly 500 MB/s, so the overshoot is `rate × interval` and cannot
be made small without polling so fast that a busy event loop misses it. The
`Transform` counter gives an exact figure for free. (The alternative — accept the
overshoot — is what Claude Code does, and it is why their producer kill is 5 GB:
coarse enough that overshoot is noise.)

### Two-tier cap

Because counting is exact, one number is enough, and it splits cleanly:

| Tier | Threshold | Action |
|---|---|---|
| Producer | **2 GiB** | SIGKILL the group. A backstop against filling the disk, not a routine event. |
| Artifact | **16 MiB** | Truncate the file after the fact. Matches the per-file cap in the spillover design. |

The producer threshold is deliberately far above the artifact cap. Reference
implementations run the same ratio (Claude Code: 5 GB kill, 64 MiB artifact).

### Memory

Bounded by construction: `2 × highWaterMark` (≤ 128 KiB) in the pipeline
regardless of output size, versus 8 MiB per stream today. Verified with 800 MB
through a similar pipeline: parent `heapUsed` held at 5.1 MB.

### Constants

| | Value | Was |
|---|---|---|
| Producer kill | 2 GiB | none (unbounded, capped only after buffering) |
| Artifact cap | 16 MiB | 8 MiB in-memory, silently dropped |
| Drain / completion | resolved on `finished(stream)`, raced against the existing timeout | awaited `'close'` — **could hang forever** |
| Kill signal on breach | SIGKILL to the process group | SIGKILL to the group (unchanged, already correct) |
| Kill signal on timeout/abort | SIGKILL to the group | unchanged |

## Constants that do not change

`detached: true`, the process-group SIGKILL, the stdin-`"ignore"` fix, and the
`CI`/`PAGER` environment are all already correct and stay.

## Out of scope

- **Memory cgroups.** Claude Code bounds a child's *own* memory with
  `CLAUDE_CODE_TOOL_MEMORY_LIMIT` on Linux. There is no portable equivalent —
  `RLIMIT_AS` does not exist on macOS (`setrlimit failed: invalid argument`,
  verified) and `ulimit -v` stays `unlimited`. Worth adding for Linux, but it is a
  different mechanism and the runaway-output case does not need it, since a fast
  producer is throttled by backpressure rather than by memory.
- **`RLIMIT_FSIZE` as an output cap.** Verified useless: it scopes to *files*,
  and 100 MB to a pipe under `ulimit -f 1` exits 0 with no effect. It would only
  work if the child did its own redirection, which we cannot wrap universally.
- **Live output streaming to the UI.** The `Transform` is positioned to support it
  later; nothing consumes it today, and adding it is a UX decision, not a
  correctness one.

## Test plan

- A command whose grandchild calls `setsid` and holds stdout **completes** rather
  than hanging. This is the regression test for the bug above, and it must use a
  real detached grandchild, not a mock.
- Output over the producer threshold is killed and `exitCode` reports the signal.
- The artifact is truncated to the per-file cap and the result says so.
- Parent `heapUsed` stays bounded when a command emits far more than the cap.
- A multi-byte character straddling a chunk boundary survives into the artifact
  and into the returned window.
- stdout and stderr stay separately addressable.
- Timeout and abort still terminate the whole process group, and now settle the
  promise even when a grandchild survives.
- Partial output from a killed command is preserved, not discarded.
