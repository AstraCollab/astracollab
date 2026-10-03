# NAH

NAH (Not Another Harness) is a terminal coding agent that works in your current project. It can inspect files, search code, edit files, run shell commands, track token usage, and resume conversations from local session files.

## Requirements

- Node.js 22.19 or newer (the interactive UI is built on
  [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui),
  the same TUI library Pi ships)
- An API key for a supported model provider
- macOS Keychain, Linux Secret Service (`secret-tool`), or Windows DPAPI for securely saved provider keys

## Install

```sh
npm install --global @astracollab/nah
nah --help
```

## Start

Run `nah` from the repository you want it to work in:

```sh
cd path/to/your-project
nah
```

On first use, enter `/provider` and choose Anthropic, OpenAI, or OpenRouter. NAH stores the key in the platform credential store. You can also provide a key through the corresponding environment variable, such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY`. Then use `/model` to search and choose a model.

Give NAH a task when starting if you prefer:

```sh
nah "Trace the login flow and summarize its failure cases"
```

Interactive sessions start in `ask` mode: NAH asks before edit, write, or shell actions. Use `/permissions readonly` to block changes, or `/permissions yolo` to allow them without asking.

### Sessions

Each run of `nah` starts a **new** session in its own file, so a fresh run never
silently appends onto the previous one's transcript. The first run in a directory
uses `<id>.jsonl`; later runs get `<id>-2`, `<id>-3`, and so on.

| Invocation | Behaviour |
| --- | --- |
| `nah` | New session, empty transcript |
| `nah -c` | Resume the most recently modified session for this directory |
| `nah --session <id>` | Resume exactly that session |
| `nah --session <path>` | Resume a session file at an explicit path |

Resuming replays the earlier turns into the transcript pane, so the history is
visible before you type. `/session list` shows every session for the directory
with timestamps; `/branch <name>` forks the current one.

### Commands

Type `/` at the prompt to open the command modal. The list filters as you type
(`/mod` narrows to `/model` and `/mode`); press Enter to insert a command. Once a
command name is settled, no list is shown — arguments are typed freely and the
result appears when you press Enter.

`/model` with no argument opens the searchable model list; `/model <provider:model-id>`
switches directly. These two (and `/provider`) take over the terminal with their own
full-screen UI, so they are unavailable while a turn is streaming. `/studio` does
too — installing the dashboard asks a question — but the dashboard itself runs in
the background, so the session is back before the next prompt.

### Interrupting a stuck turn

`Ctrl-C` stops the running turn and says so; press it again to exit. That
escalation matters: if a tool stops responding, a single `Ctrl-C` would
otherwise leave you trapped in the interface with no keyboard way out, forcing a
kill — which leaves the terminal in the alternate screen with raw mode still on.

On `SIGTERM`, `SIGHUP`, or an uncaught error, NAH restores raw mode, the
cursor, bracketed paste, the keyboard protocol, **mouse reporting**, and the main
screen before it dies. Mouse reporting matters most: a terminal left in
SGR-mouse mode sends `ESC[<35;col;rowM` on every pointer move, and the shell
prints those numbers as text until the tab is closed.

Only `SIGKILL` or a crash of the machine itself cannot be intercepted. If a
terminal ends up wedged, run `reset` — or, to undo just the mouse modes:

```sh
printf '\033[?1000l\033[?1002l\033[?1003l\033[?1006l'
```

If your terminal mishandles SGR mouse reports, `NAH_NO_MOUSE=1 nah` disables
mouse tracking entirely. You lose drag-select and wheel scrolling; `Cmd+C` copy
still works.

### Copying

Drag to select text in the transcript and release, and it is copied to the system
clipboard. `Cmd+C` (or `Ctrl+Shift+C`) copies the current selection; plain `Ctrl+C`
still aborts the turn.

Copying goes through the platform clipboard — the native helper the UI library
ships, falling back to `pbcopy` / `wl-copy` / `xclip` / `xsel` / `clip`. If none of
those can copy, the UI says so instead of claiming success. (The alternative, an
OSC 52 escape sequence, is silently ignored by Terminal.app and by tmux without
clipboard passthrough, which is why it cannot be trusted to report success.)

### Steering

You do not have to wait for a turn to finish. While the agent is working, the prompt
at the bottom is still live — type a correction and press Enter, and it is delivered
at the next step boundary (the model call already streaming is never cut off). Submitting
a `/command` mid-turn queues it until the turn settles.

The input sits in its own region below the transcript, so streamed output can never
land on the line you are typing. `Ctrl-C` aborts the running turn (and exits when idle);
`Ctrl-D` exits on an empty prompt.

This layout requires an alternate-screen TUI, so it is used only when stdin and stdout
are both a TTY. Pipes, CI, and dumb terminals keep the line-oriented renderer, as does
`--no-tui`.

## Commands

| Command | What it does |
| --- | --- |
| `/model` | Search available models; `/model provider:model-id` switches directly |
| `/provider` | Save or switch provider credentials |
| `/permissions <mode>` | Choose `ask`, `yolo`, or `readonly` for file and shell changes |
| `/diff` | Review current workspace changes |
| `/undo` | Restore the last turn’s file changes |
| `/session list` | List saved sessions for the current directory |
| `/session new` | Start a separate session for this directory |
| `/session off` | Stop saving the current session |
| `/branches`, `/branch <name>` | List, create, or switch session branches |
| `/task` | Show the saved task plan and checks |
| `/compact` | Compact the current transcript |
| `/memory` | Inspect Cognitive Memory state (L0-L3 cache, pre-staged items, self-model) |
| `/cogmem` | Connect the hosted Cognitive Memory service, or switch back to the local store |
| `/tensions` | View unresolved contradictions; `/tensions resolve <id>` marks resolved |
| `/studio` | Open the dashboard of every agent on this machine; `status`, `stop`, `url` |
| `/telemetry on\|off` | Report this session's turns to a running studio, or stop |
| `/clear` | Clear the active transcript |
| `/help`, `/quit` | Show commands or exit |

When you quit, NAH prints a resume command. To resume from the same project directory:

```sh
nah --session <session-id>
```

Session IDs are scoped to the current directory. You can also pass a specific session file path to `--session`.

## Command-line options

```sh
nah --continue                       # resume the default session for this directory
nah --session <id-or-file>            # resume a selected session
nah --model openrouter:provider/model # choose a model at startup
nah --permissions readonly "Review this code"
nah --no-session                      # do not persist this run
nah --no-tui                          # force the line renderer instead of the TUI
nah --print "Summarize this project"   # run once and exit
nah --mode json "Summarize this project" # emit JSONL events
nah --cwd /path/to/project "Explain this code"
nah serve                            # the dashboard, from a shell (same as /studio)
nah serve --port 5000
nah serve status | stop | url
```

Print and JSON modes allow mutating tools by default because they cannot prompt interactively. Pass `--permissions readonly` when a non-interactive run must not make changes.

## Memory

Nah keeps a small cognitive memory per working directory, so facts you teach it
survive into later sessions.

- Facts, preferences and conventions are extracted from each turn with the same
  model that runs the turn, plus deterministic pattern matching so a plainly
  stated fact is captured even if the model refuses or hedges.
- Memories live in a SQLite database at `~/.nah/memory/<cwd-hash>.sqlite` and reload on the next run. A memory file from an earlier version is imported once and kept alongside as `.json.imported`. No native dependency: it uses `node:sqlite`, which Node has shipped since 22.5.
- Each turn gets a one-line **index** of the hot cache. A full body is only
  spent when a deterministic trigger earns it: you name an identifier (URL,
  hostname, path, `SCREAMING_SNAKE`, camelCase token) that is not in the visible
  transcript and a memory matches it. This is the index/body split Claude Code
  and Letta use, so recall stays cheap and the prompt is not stuffed with
  distractors. Only the hot cache is indexed; anything demoted or archived is
  reachable through `recall` and never appears on its own.
- The agent also has a `recall` tool to search memory on demand when the index
  is not enough. Ranking is deterministic and in-process, so recall does not
  depend on which model you use.
- `/memory` shows what was injected on each turn, why, and at what token cost.
- Nothing is learned from a turn where you asked a question. A restatement of
  something already held is folded into it rather than duplicated, with one
  deliberate exception: if merging would drop part of what you said, both
  statements are kept.

`--no-session` keeps the run in memory only, `NAH_MEMORY_NOPERSIST=1` disables
the memory store on its own, and `NAH_MEMORY_DEBUG=1` traces extraction,
promotion and persistence per turn.

### Studio

`/studio` opens a dashboard of every agent on the machine: which are running, what
each one did, and what it cost.

```sh
nah                       # then, inside the session
/studio                   # installs the studio if needed, starts it, opens a browser
```

The Studio is a separate package, [`nah-studio`](../nah-studio), installed the
first time you ask for it and then running in the background. It outlives the
session that started it, so you can go back to work with the dashboard open — a
monitoring tool that stops working the moment you type is not one.

```sh
/studio status            # where it is, whether it is answering, which version
/studio stop              # stop it
/studio url               # print the URL, for a machine with no browser
nah serve                 # the same thing from a shell
nah serve --port 5000
nah serve stop
```

**Telemetry is opt-in by construction.** The Studio publishes itself at
`~/.nah/studio.json`; a session that finds that file reports to it, and a session
that does not find it sends nothing anywhere. There is no telemetry switch to
remember and no traffic when the dashboard is not running. `/telemetry off` opts
out and remembers it, and `NAH_TELEMETRY=off` opts out for one session.

While the Studio is up, every `nah` session on the machine registers itself and
pushes its traces: one row per process, with the working directory, the model, the
version, and what it has run. Two sessions in one repository are two agents,
because "is anything running right now" is a question a merged row cannot answer.

The Studio can also start agents: give it a directory and a task, and it runs a
real `nah` process with one prompt, captures its output line by line, and watches
it the same way it watches everything else. Nothing privileged is involved — the
agent reports itself, exactly like one you started by hand.

The built-in agent behind the chat tab and evaluations is assembled by `nah`
itself, from this package's own prompt, tools and memory, with mutating tools
refused. Debugging a different agent than the one you use would make every trace
in the dashboard evidence about the wrong program; it is published as the
`nah/agent` subpath for exactly that reason.

Six views:

| View | What it answers |
| --- | --- |
| **Agents** | Who is running, what each one has cost, and its output |
| **Overview** | Volume, error rate, spend, median latency, runs over time |
| **Traces** | Every run, filterable by range, status and tag; sortable; a span waterfall and inspector behind each |
| **Tools** | Per-tool call counts, error rates, p50 and p95 latency |
| **Evaluations** | Datasets, scorers, run controls with live progress, per-scorer means, score spread, and two experiments side by side |
| **Chat** | Talk to the read-only agent; the run is traced like any other |

⌘1–⌘6 (or ctrl on other platforms) moves between views, and the agent selector in
the header scopes every one of them to a single agent.

Updates arrive over `GET /api/stream` as server-sent events, so the list of agents
is current when a turn finishes rather than up to ten seconds after. The interval
polling that remains is a floor under a stream that a proxy has blocked, not the
mechanism.

Every run is a trace: one root span, a span per model step, a child span per tool
call, and one per compaction. Token counts, prompt size, cache hit rate and spend
are attributes on those spans, so the questions worth asking — which step was
slow, what did that tool receive, did this run cost 1 cent or 90 — have an answer
that is a query rather than a scroll.

The recorder is a consumer of the same event stream the TUI renders, so tracing
cannot change what the agent does, and `traceRun` works on any `runAgent` result.
It lives in `not-another-harness` next to the loop.

Two defaults worth knowing:

- **The agent runs read-only.** Mutating tools are refused, because a debugging UI
  that can be talked into editing your repository through a browser form is not a
  debugging tool.
- **Credential-shaped values are redacted before anything is written.** Spans carry
  prompts and tool arguments, and a pasted key in a prompt is ordinary.

### Evaluations

A dataset of cases, a set of scorers, and a run that executes each case and scores
it. Rule scorers (`includes`, `calledTool`, `mentionsFile`, `notRefused`) are
deterministic, so a score that moves means something changed. `judgeScorer` grades
an answer with a model against a rubric and is required to give a reason; a scorer
that cannot answer returns *skipped* rather than zero, because a fabricated zero
reads as a measurement.

```ts
import { calledToolScorer, includesScorer, judgeScorer, notRefusedScorer } from "nah-studio/evals";

const scorers = [
  notRefusedScorer(),
  includesScorer(["ZQ7X4M2K"]),
  calledToolScorer("read"),
  judgeScorer({ id: "relevancy", name: "relevancy", rubric: "answers the question asked", model }),
];
```

Results carry the trace id, so any row in the results table opens the run that
produced it. A provider-level failure is retried and reported as `errored` with no
scores rather than as a failed agent, because the number gets quoted.

### API

The Studio serves its own API; the table below is what an agent needs, and the
rest lives in [`nah-studio`](../nah-studio).

| Route | Purpose |
| --- | --- |
| `POST /api/agents` | Register or heartbeat. One route for both, because a client cannot know whether the Studio it found is one it has already met |
| `POST /api/traces` | Ingest `{ agent?, trace, spans }`. Idempotent per trace id, and it registers the agent if that was skipped |
| `GET /api/agents` | Every agent with its own totals, status and last-seen |
| `POST /api/agents/launch`, `/api/agents/:id/stop`, `/api/agents/:id/logs` | Start an agent, stop one this Studio started, read its output |
| `GET /api/stream` | Server-sent events: agent appeared, agent moved, trace landed, line printed |
| `GET /api/traces`, `GET /api/traces/:id` | Trace list (search, status, tag, agent, since/until, sort) and one trace with its spans |
| `GET /api/overview?buckets=N&agentId=` | Totals plus a bucketed series for the charts |
| `GET /api/tools?agentId=` | Per-tool call counts, error rates and latency percentiles |
| `GET /api/info` | What this server is: version, directory, whether it can start agents |
| `GET/POST /api/messages` | The conversation log |
| `GET/POST /api/datasets`, `/items` | Eval cases |
| `GET /api/scorers` | Registered scorers |
| `POST /api/experiments`, `GET /api/experiments/:id` | Start an experiment (returns immediately; it runs in the background) and read one |
| `POST /api/chat` | Send a message to the read-only agent |

The store is SQLite at `~/.nah/studio/studio.sqlite` (`node:sqlite`, no native
build), and a store written by an older build is migrated in place on open.

Set `NAH_STUDIO_TOKEN` before binding `0.0.0.0`: without a token the server
refuses anything that is not from loopback, because the store holds prompts, file
paths and tool output. A Studio started by `/studio` is loopback-only by default
and needs no token, so a first run does not involve one.

An agent can only be stopped by the machine it is running on, and only if the
Studio started it. A browser button is not consent to kill somebody's terminal.

## Hosted memory, with `/cogmem`

Memory runs in-process by default, against a SQLite file in your home directory.
`/cogmem setup` points it at the hosted
[Cognitive Memory](https://cogmem.astracollab.app) service instead, which is the
same cognitive layer behind an API — same four tiers, same index/body split, same
deterministic recall — so what the model sees does not change. Only where the
memories are stored does.

```sh
nah
> /cogmem setup      # service URL, then where the key comes from
> /cogmem            # which backend is live, and whether it is reachable
> /cogmem local      # back to the local store, with everything still there
```

| Subcommand | What it does |
| --- | --- |
| `/cogmem` | Show the backend in use, the key source, tier counts, and any failure |
| `/cogmem setup` | Choose the service URL and a key, verify both, then switch |
| `/cogmem key` | Replace the stored key without redoing the whole setup |
| `/cogmem on` / `/cogmem off` | Enable or disable hosted memory, keeping the connection |
| `/cogmem local` | Switch back to the local store |
| `/cogmem import` | Copy the local store's memories into the service, after confirming |
| `/cogmem forget` | Remove the stored key |

Three things worth knowing before you switch:

- **The local store is never touched.** Switching back restores it intact, and
  nothing is copied anywhere until you run `/cogmem import` and confirm it.
- **The key can come from three places.** `COGNITIVE_MEMORY_KEY` in the
  environment wins if it is set; otherwise the platform credential store is used,
  the same place provider keys live. On macOS the key goes to the Keychain; on
  Linux and Windows you paste it with input hidden and it is written to Secret
  Service or DPAPI. `COGNITIVE_MEMORY_URL` overrides the service URL the same way.
- **A service that is down does not break turns.** The prompt block is skipped
  and the failure is reported in `/cogmem` and `/memory` rather than swallowed —
  an agent that silently forgets everything is worse than one that says it could
  not reach memory. The same applies at startup: hosted memory that has no
  reachable key falls back to the local store and prints why.

In hosted mode the service does the extraction, so the turns you have are sent to
it to learn from. That is the trade for not running a model call per turn on your
own provider.

### Identifying the app to OpenRouter

Requests to OpenRouter carry attribution headers, which is what makes usage show
up against this app in the OpenRouter dashboard rather than as anonymous traffic:

```
X-Title: nah
HTTP-Referer: https://nah.astracollab.com
```

Forks and self-hosts can rename themselves without touching code:

```sh
export NAH_APP_NAME=nah-fork
export NAH_APP_URL=https://your-host.example
```

## Run from the monorepo

```sh
pnpm install
pnpm --filter not-another-harness build
pnpm --filter @astracollab/nah build
pnpm --filter @astracollab/nah exec nah --help
```

The executable package is `@astracollab/nah`; the SDK runtime is documented separately in [`not-another-harness`](../not-another-harness/README.md).
