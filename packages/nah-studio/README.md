# nah-studio

The dashboard for `nah`. Every agent on the machine, what each one did, and what
it cost.

Normally you do not install this yourself — type `/studio` inside `nah` and it is
installed on first use, started in the background, and opened in a browser. The
command it runs is `nah serve`, and it works on its own too, which is the case
that matters when several agents are running and none of them is at your terminal.

```sh
npx nah-studio                      # 127.0.0.1:4111, watching this directory
nah-studio --port 0                 # any free port; the real one is printed
nah-studio --host 0.0.0.0           # on the network — needs NAH_STUDIO_TOKEN
nah-studio --no-publish             # invisible to agents; nothing reports to it
```

| Flag | What it does |
| --- | --- |
| `--port <n>` | Port to listen on (default 4111) |
| `--host <addr>` | Address to bind (default 127.0.0.1) |
| `--cwd <dir>` | Where the built-in chat agent works (default: cwd) |
| `--model <spec>` | `provider:model-id` for the chat tab and evaluations |
| `--db <path>` | SQLite file (default `~/.nah/studio/studio.sqlite`) |
| `--nah-bin <path>` | The `nah` to launch agents with (default: the one on PATH) |
| `--no-publish` | Do not write `~/.nah/studio.json`, so no agent finds this Studio |

## How agents get here

There is no registration step and nothing to configure in the agent. The Studio
writes `~/.nah/studio.json` when it starts — its URL, its pid, and the `nah` that
started it — and every `nah` session on the machine reads that file once, at
startup.

A session that finds a live Studio registers itself (`POST /api/agents`) and pushes
each finished turn to `POST /api/traces` with its spans. A session that finds
nothing sends nothing anywhere. That is the whole opt-in: telemetry is off unless
a dashboard asked for it by existing.

One row per process. Two sessions in one repository are two agents, because
"is anything running right now" is a question a merged row cannot answer. The
friendly name defaults to the directory's name, and `NAH_AGENT_NAME` overrides it —
which is how an agent the Studio launched gets named for the row already on screen.

**Status is inferred, never waited for.** The column records what an agent last
said about itself, and the online dot is decided at read time from how long ago
that was. Nothing writes "offline": a machine that sleeps, or a process that was
killed, cannot file that report.

## Starting agents

Give the Studio a directory and a task and it runs a real `nah` process with one
prompt, captures its output line by line, and watches it like any other agent —
which is the point, because the agent reports itself and pushes its own traces
rather than being driven through a private channel. One prompt per launch, so a
launch is a task with an end and the status column stays honest.

`--nah-bin` matters more than it looks. A global `nah` from npm and a `nah` built
from a checkout produce different traces, so the Studio launches the build that
started it — `/studio` records it in the endpoint file — rather than whatever
happens to be first on PATH.

## The built-in agent

The chat tab and evaluations run an agent assembled by `nah` itself, published as
the `nah/agent` subpath: the same system prompt, the same tools, the same model
resolution and the same memory as the agent in your terminal, with one difference —
every mutating tool is refused.

That is deliberate. A dashboard that assembled its own copy of the agent would be
debugging a different program from the one you use, and its traces would be
evidence about the wrong thing.

Each request gets a fresh state: an HTTP request has no transcript to inherit, and
a turn carrying the previous one's history could answer a question about a file it
never read.

## Views

| View | What it answers |
| --- | --- |
| **Agents** | Who is running, what each has cost, its output; start one from here |
| **Overview** | Volume, error rate, spend, median latency, runs over time |
| **Traces** | Every run, filterable; a span waterfall and inspector behind each |
| **Tools** | Per-tool call counts, error rates, p50 and p95 latency |
| **Evaluations** | Datasets, scorers, experiments with live progress and score spread |
| **Chat** | Talk to the read-only agent; the run is traced like any other |

⌘1–⌘6 moves between them. The agent selector in the header scopes every view, not
just the list — a summary of everything shown next to a filter that says otherwise
is how a dashboard starts lying.

Updates arrive over `GET /api/stream`. The interval polling still in the code is a
floor for a stream a proxy has blocked, not the mechanism.

## Security

- Loopback by default. `0.0.0.0` requires `NAH_STUDIO_TOKEN`, and without one the
  server refuses anything that is not from loopback — the store holds prompts, file
  paths and tool output.
- The token is written to `~/.nah/studio.json` at mode 0600, and an agent that gets
  a 401 gets a warning naming the problem rather than silence.
- Credential-shaped values are redacted before anything is written, and every span
  is size-limited: a trace is a debugging aid, and an unbounded one is a liability.
- An agent can be stopped only by the machine it runs on, and only if this Studio
  started it.

## Development

```sh
pnpm --filter nah-studio build       # UI into dist/ui, then the server into dist/
pnpm --filter nah-studio test
pnpm --filter nah-studio dev         # the UI with HMR on :4112, proxying /api

# develop the UI against a Studio that is already running
pnpm --filter nah-studio dev
```

`dist/` holds both halves of the product: `cli.js` and the `dist/ui` files the
server reads relative to itself. One published package, no copy step between two.