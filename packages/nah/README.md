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
full-screen UI, so they are unavailable while a turn is streaming.

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
| `/tensions` | View active knowledge tensions (contradictions); `/tensions resolve <id>` marks resolved |
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
```

Print and JSON modes allow mutating tools by default because they cannot prompt interactively. Pass `--permissions readonly` when a non-interactive run must not make changes.

## Run from the monorepo

```sh
pnpm install
pnpm --filter @astracollab/not-another-harness build
pnpm --filter @astracollab/nah build
pnpm --filter @astracollab/nah exec nah --help
```

The executable package is `@astracollab/nah`; the SDK runtime is documented separately in [`@astracollab/not-another-harness`](../not-another-harness/README.md).
