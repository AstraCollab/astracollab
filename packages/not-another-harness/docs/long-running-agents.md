# Long-running agents

How to remove the step ceiling without removing the ceiling.

## The problem

`runAgent` defaulted to `maxTokens: 400_000`. A run that hit it stopped
mid-task: no final message, no commit, no statement of what was left. The
budget was doing the job of a safety rail, but it was wired to the wrong
signal, so it fired during normal work.

The log that prompted this work ended like this:

```
◆ read resolvewise/lib/hooks/useDisputeStateMachine.ts
  ⋯ compacted 35 messages (1134 chars)
◆ write resolvewise/lib/hooks/useTheme.ts
◆ read resolvewise/components/marketing/LandingPage.tsx
  max-tokens · 402296 tokens
```

Six planned steps, two complete. Nothing handed off.

## Why 400k was the wrong number

`maxTokens` was a **cumulative** budget compared against `usage.totalTokens`,
which accumulates across every step. But every step re-sends the whole
transcript, so cumulative input grows *quadratically* with step count. Thirty
steps averaging 13k input tokens each bills ~400k.

The 400k cap was therefore a ~30-step cap wearing a token costume. Raising it to
800k buys 60 steps and doubles the bill. **It was never a context limit** — the
run above never came close to one. It was a spend counter mislabelled as a
context counter.

Two budgets were being conflated:

| Budget | Question it answers | Axis |
| --- | --- | --- |
| Context | Will the next request fit in the model's window? | per-request |
| Spend | Has this run cost too much? | cumulative |

They have different triggers, different remedies, and different failure
modes. Merging them means the only lever is "stop", and stopping is the worst
possible response to a full context window, because a full context window is
*fixable*.

## Three bugs found on the way

These were found while diagnosing the above. Each is independently worth fixing
and each made long runs more expensive than they needed to be.

### 1. Most cache breakpoints were being discarded

`withCachedToolSchemas` marked *every* tool with a `cacheControl` marker.
Anthropic allows **four breakpoints per request**; the AI SDK enforces this in
`CacheControlValidator` and silently drops the rest, emitting a warning that
nothing in this codebase reads.

Verified on the wire against `@ai-sdk/anthropic@2.0.107`, with the eleven tools
a real `nah` session registers:

```
top-level cache_control: {"type":"ephemeral","ttl":"5m"}
read, list, grep, edit              → MARKED
write, outline, bash, glob,
recall, task_ledger, delegate_task  → uncached
```

Seven of eleven tool schemas were re-billed at full price on every step of
every run, permanently. The two breakpoints that survived on tools were also in
the wrong place — see below.

### 2. The transcript tail had no breakpoint at all

`TAIL_CACHE_BREAKPOINTS = 2` was declared in `cache.ts` and referenced
nowhere. Its doc comment described the right idea:

> Anthropic allows a small number of cache breakpoints per request. Two are
> spent on the system prompt and tool definitions, leaving the transcript to
> grow its own at the tail.

The idea was never implemented. Only the *static* prefix — system prompt and
tool schemas — was cached. The transcript, which is the only part that grows,
was re-read at full price on every single step. For a long run that is the
dominant cost, and it is exactly the cost that compounds quadratically.

### 3. The compaction trigger read the wrong usage field

`agent.ts` tracked `lastRequestTokens` from `stepUsage.inputTokens`. Under
prompt caching, Anthropic reports `input_tokens` as only the tokens *after* the
last breakpoint — the cached prefix is reported separately as
`cache_read_input_tokens`, which the AI SDK surfaces as `cachedInputTokens`.

So once caching worked, `lastRequestTokens` collapsed toward the size of the
newest few blocks and `compactAtTokens: 120_000` would silently never fire.
The harness would have stopped compacting precisely when compaction mattered.
`cachedInputTokens` was available on the SDK's usage type and read nowhere in
this package.

## Three more found while implementing

These only surfaced once the changes above were under test, which is a decent
argument for writing the tests first next time.

### 4. `compactKeepRecent: 2` could never compact

`compactMessages` guarded with `messages.length <= tailStart + 2`. Because
`alignTailToToolBoundary` returns `length - keepRecent` for an aligned tail,
that guard reduces to `keepRecent <= 2` — so at `keepRecent: 2` it was
unconditionally true, at *every* transcript length. And `runAgent` floors the
option at 2, so the smallest value a caller could legally pass silently disabled
compaction entirely. Replaced with a direct expression of the intent (`tailStart
< 2`), which asks whether the middle has anything in it.

### 5. `providerMetadata` is a promise

Cache *write* tokens are not on the SDK's usage type at all; they arrive as
`providerMetadata.anthropic.cacheCreationInputTokens`. The first implementation
read that property synchronously off the `streamText` result — where it is a
`Promise` — so it returned `0` on every run and no test noticed, because a
budget that under-counts cache writes still looks roughly right. Now awaited,
and pinned by a test that asserts the exact dollar figure.

### 6. The system prompt was never actually cached

`cacheOptions()` and `contextManagementOptions()` both return a bag keyed on the
provider name, and `runAgent` combined them with a plain object spread:

```ts
{ ...cacheOptions(...), ...contextManagementOptions(...) }
```

Every bag is keyed on `"anthropic"`, so the spread keeps only the *last* bag's
settings and discards the other's. The request-level `cacheControl` was silently
dropped on every run, because context editing is always configured — so the
system prompt has never been cached. Nothing errored; the request simply stopped
being cheap.

Only the wire-level check caught this: every unit test asserted one half of the
merge and neither asked about the other. Worth remembering that "two provider
options both set" is exactly the case a merge test has to construct.

## Verification

Checked against the real provider rather than the SDK's types, by intercepting
the HTTP body for an 11-tool session — the same tool set a real `nah` turn
registers:

```
tool markers:   1  -> delegate_task   (the last tool; covers all 11)
tail markers:   1  (the moving transcript breakpoint)
top-level:      {"type":"ephemeral","ttl":"1h"}
context_management: present
TOTAL:          3   (budget 4)
```

Before this work the same session emitted 11 tool markers, of which 4 survived
and 7 were discarded, and no top-level marker at all.

## Design

Four changes. The ordering is deliberate: caching first, because it is what
makes a long run affordable, and affordability is the prerequisite for
everything else.

### Change 1 — Cache the thing that grows

Two rules replace "mark everything":

1. **One breakpoint on the last tool definition.** A breakpoint marks a prefix,
   so marking the final tool caches the entire tool block. Marking all eleven
   spends the budget to say the same thing eleven times, and loses.
2. **A moving breakpoint on the transcript tail.** The tail is where the
   repetition is. As the conversation grows, the breakpoint follows it, so each
   step reads back the previous step's prefix instead of re-billing it.

Together: one breakpoint on tools, one on the transcript tail, one on the system
prompt. Three of four, leaving headroom.

The tail breakpoint must move *with* the transcript, not be pinned to a fixed
index. A pinned breakpoint on a growing conversation falls outside Anthropic's
20-block lookback window after enough turns and silently stops hitting — the
failure documented in their caching guide, where a 35-block turn finds no
matching prior write.

**Why 1h TTL.** The cache lifetime is measured from the *start* of the request
that writes or reads it, not the end of its response. A step that takes four
minutes to stream consumes four minutes of the five-minute window, so the next
request starts with an expired cache. Long agent steps are exactly the case
where 5m is wrong. 1h writes cost 2× base instead of 1.25× and reads at 0.1×,
so it breaks even after two reads.

### Change 2 — Two budgets, honestly named

`maxContextTokens` replaces the context half of the old `maxTokens`: a
per-request ceiling checked against the model's actual window. When the next
request would not fit, the response is to compact, not to stop.

`maxSpendUsd` is the cumulative safety rail. It is denominated in dollars
because "tokens" was the original sin — a token is not a fixed cost, and a
cache read costs a tenth of a fresh input token. Counting raw tokens makes a
well-cached run look as expensive as a badly-cached one.

Spend is therefore accumulated from the cache-aware usage breakdown:

```
spend += (cachedInputTokens + cacheCreationInputTokens) * readRate
       + freshInputTokens * writeRate
       + outputTokens * outputRate
```

with rates supplied per model. This makes a run that caches well look
*cheaper*, which is the truth, and it means the rail fires on money rather than
on an arbitrary token count.

The dollar rail also *clamps output length* rather than only terminating: the
dollars left, minus the cost of the input about to be sent, are converted into
the output tokens they can buy. A step that can only afford a short answer gets
one instead of being truncated mid-sentence or overspending and then stopping.

`maxTokens` remains for compatibility, is now **off by default**, and is
documented as deprecated. When set explicitly it still works.

### Change 3 — Read the whole usage breakdown

`lastRequestTokens` becomes:

```ts
lastRequestTokens =
  inputTokens + (cachedInputTokens ?? 0) + (cacheCreationInputTokens ?? 0);
```

This is the true size of the request that was sent, which is the only honest
input to "will the next one fit". It also fixes the compaction trigger, which
previously saw near-zero once caching worked.

The estimator in `estimate.ts` stays as the fallback for providers that report
no usage at all.

### Change 4 — Degrade instead of stopping

Every hard stop now runs one final step first, instructing the model to wrap
up: commit what works, update the task ledger, state precisely what remains.

The failure this addresses is documented and severe. Anthropic's long-running
harness work describes an agent that ran out of context mid-implementation,
leaving a half-finished feature that the next session had to guess about —
"this happens **even with compaction**". And "premature victory", where a later
agent sees partial progress and declares the job done, is one of their two
dominant real-world failure modes.

A wrap-up step costs one request and converts every hard stop from data loss
into a resumable state. It is the single highest-value change per line of code
in this document.

It fires on `max-tokens`, `max-steps`, and abort. It does not fire on
`completed` (the model already answered) or `error` (there is nothing to wrap
up). It is bounded to a single step so it cannot itself loop, and it is
skipped when the caller has aborted, because a user who pressed Escape does not
want a farewell message.

## On model summarization

Kept, but demoted and hardened.

The case for removing it is real: compaction is lossy, and the failure modes
are documented. Anthropic's own long-running-harness post says flatly that
"compaction isn't sufficient". Measured work on constraint decay (arXiv
2606.22528) found policy-violation rates rising from 0% to 30% after a single
compaction, reaching 59% for some models — and pinning the invariants outside
the lossy step restores it to 0%.

The case for keeping it is that it is the only provider-agnostic mechanism
available. Server-side context editing exists on Anthropic and nowhere else,
and it clears tool output rather than summarizing, which does not solve the
problem of a transcript that is large because of *reasoning*, not because of
bulky `bash` output.

So the ordering becomes: **elide first, summarize last.**

1. `pruneOldToolResults` — rule-based, lossless where it matters, no model
   call. Cheapest and safest.
2. Server-side `clear_tool_uses_20250919` where the provider supports it.
3. Model summarization as the last resort, at a high trigger, with invariants
   pinned.

Pinning is the part worth generalizing. The harness already preserves the
durable task ledger verbatim through compaction, which is the right instinct
applied to exactly one artifact. The same treatment should extend to whatever
else the caller marks as non-negotiable — the original task, acceptance
criteria, the user's stated constraints. That is the specific intervention the
constraint-decay research identifies as restoring violation rates to zero.

The default compaction trigger also rises. `compactAtTokens: 120_000` against a
1M window is aggressive: it compacts when the model still has room to think,
which is exactly when compaction does the most damage. Context rot is real but
it is a gradient, not a cliff, and retrieval degrades well before 1M — so a
high trigger with cheap elision underneath beats a low trigger with lossy
summarization on top.

## What is deliberately not here

- **Sub-agent delegation.** Already present (`delegate_task`), already bounded
  at 20 steps / 120k tokens. It remains the right tool for *fan-out* work. It
  is not a substitute for a long-running loop, because the parent still has to
  hold the result.
- **A durable on-disk task ledger as the source of truth.** The strongest
  pattern in Anthropic's long-running work is a `feature_list.json` with every
  item `"passes": false`, which agents may only flip after end-to-end
  verification. This harness has `task_ledger`, and it is close. Making it
  authoritative — rather than something the model is asked to keep updated — is
  the natural next piece of work, and it is a product decision rather than a
  harness one.
- **Server-side compaction (`compact_20260112`).** Available in the installed
  SDK and a better fit than client-side summarization, since the API owns the
  summary and the signatures. Not wired up here because it is Anthropic-only
  and beta-gated; the client-side path remains the portable floor.
- **`task_budget`.** Also in the installed SDK (`providerOptions.anthropic.
  taskBudget`, min 20k). It gives the model a visible countdown so it paces
  itself and finishes gracefully rather than being severed. It complements
  `maxSpendUsd` — ours is the hard rail, theirs is the model's own judgement —
  and would make change 4 less necessary on models that support it. Worth
  wiring once the spend accounting above is trusted.
