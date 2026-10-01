# NAH

NAH (Not Another Harness) is a terminal coding agent that works in your current project. It can inspect files, search code, edit files, run shell commands, track token usage, and resume conversations from local session files.

## Requirements

- Node.js 20.6 or newer
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
