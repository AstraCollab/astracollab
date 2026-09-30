export type CliMode = "interactive" | "print" | "json";

export type CliArgs = {
  mode: CliMode;
  /** Initial prompt text (positional args joined). */
  prompt?: string;
  /** @file inclusions to prepend to the first prompt. */
  files: string[];
  /** provider:model spec, e.g. "anthropic:claude-sonnet-4-5". */
  model?: string;
  /** Continue the most recent session for this cwd. */
  continueSession: boolean;
  sessionPath?: string;
  noSession: boolean;
  cwd: string;
  /** Approval policy override for mutating tools. */
  permissions?: string;
  /** -y / --yolo: allow all tool calls without prompting. */
  yolo: boolean;
  /** Run in a Blaxel cloud sandbox instead of the local FS (optional sandbox name). */
  sandbox?: string | true;
  showHelp: boolean;
  showVersion: boolean;
};

const HELP = `nah — not another harness, the CLI. A fast, minimal coding-agent terminal.

Usage:
  nah                       Start the interactive session
  nah "fix the flaky test"  Start with an initial prompt
  nah -p "msg"              Print mode: run once, print the answer, exit
  nah --mode json "msg"     Print JSONL events to stdout, then exit
  nah @src/a.ts "explain"   Include file contents in the first prompt
  git diff | nah -p "review this"

Options:
  -p, --print           Print mode (non-interactive)
  --mode text|json      Output mode (text = interactive UI when a TTY)
  -m, --model <spec>    provider:model (anthropic:*, openai:*, openai-compatible:*)
  -c, --continue        Continue the most recent session for this directory
  --session <path>      Load a specific session file
  --no-session          In-memory only; nothing is persisted
  -y, --yolo            Allow all tool calls without prompting
  --permissions <mode>  ask | yolo | readonly (default: ask interactive, yolo in print/json)
  --sandbox [name]      Run in a Blaxel cloud sandbox (needs BL_API_KEY + BL_WORKSPACE)
  --cwd <dir>           Working directory (default: cwd)
  -h, --help            Show this help
  -v, --version         Show version

Slash commands (interactive):
  /help /model /stats /compact /clear /session /quit
`;

export const parseCliArgs = (
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): CliArgs => {
  const args: CliArgs = {
    mode: "interactive",
    files: [],
    continueSession: false,
    noSession: false,
    yolo: false,
    cwd: process.cwd(),
    showHelp: false,
    showVersion: false,
  };
  const positional: string[] = [];

  let stopOptions = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (stopOptions) {
      positional.push(a);
      continue;
    }
    if (a === "--") {
      stopOptions = true;
      continue;
    }
    if (a.startsWith("@") && a.length > 1) {
      args.files.push(a.slice(1));
      continue;
    }
    switch (a) {
      case "-h":
      case "--help":
        args.showHelp = true;
        break;
      case "-v":
      case "--version":
        args.showVersion = true;
        break;
      case "-p":
      case "--print":
        args.mode = "print";
        break;
      case "--mode": {
        const m = argv[++i];
        if (m === "json") {
          args.mode = "json";
        }
        break;
      }
      case "-m":
      case "--model":
        args.model = argv[++i];
        break;
      case "-c":
      case "--continue":
        args.continueSession = true;
        break;
      case "--session":
        args.sessionPath = argv[++i];
        break;
      case "--no-session":
        args.noSession = true;
        break;
      case "-y":
      case "--yolo":
        args.yolo = true;
        break;
      case "--permissions":
        args.permissions = argv[++i];
        break;
      case "--sandbox": {
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          args.sandbox = next;
          i += 1;
        } else {
          args.sandbox = true;
        }
        break;
      }
      case "--cwd":
        args.cwd = argv[++i] ?? args.cwd;
        break;
      default:
        positional.push(a);
    }
  }

  if (positional.length > 0) {
    args.prompt = positional.join(" ");
  }
  // Pi behavior: non-TTY stdin/stdout without an explicit mode → print mode.
  if (args.mode === "interactive" && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    args.mode = "print";
  }
  void env;
  return args;
};

export const HELP_TEXT = HELP;
