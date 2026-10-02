/**
 * `nah-studio` — the dashboard.
 *
 * Normally started by `/studio` inside `nah`, which installs this package if it
 * is not there and opens the result. Runnable on its own too, because the case
 * that matters is a machine with several agents on it and nobody at the terminal
 * that happened to start them.
 */
import { runServe } from "./run.js";

const HELP = `nah-studio — the nah dashboard. Watches agents, traces, evaluations and chat.

Usage:
  nah-studio                  Start on 127.0.0.1:4111 for this directory
  nah-studio --port 0         Pick a free port (the real one is printed)
  nah-studio --host 0.0.0.0   Listen on the network (requires NAH_STUDIO_TOKEN)

Options:
  --port <n>          Port to listen on (default 4111)
  --host <addr>       Address to bind (default 127.0.0.1)
  --cwd <dir>         Directory the built-in agent works in (default cwd)
  --model <spec>      provider:model-id for the chat tab and evals
  --db <path>         SQLite file (default ~/.nah/studio/studio.sqlite)
  --nah-bin <path>    The nah to launch agents with (default: the one on PATH)
  --no-publish        Do not write ~/.nah/studio.json, so no agent finds this
  -h, --help          Show this help
  -v, --version       Show version

Environment:
  NAH_STUDIO_TOKEN    Required for every request when not bound to loopback
`;

export type CliArgs = {
  help: boolean;
  version: boolean;
  port?: number;
  host?: string;
  cwd: string;
  model?: string;
  dbPath?: string;
  nahBin?: string;
  noPublish: boolean;
};

/** Hand-rolled, like the CLI it sits beside: a dozen flags do not need a parser. */
export const parseArgs = (argv: string[], env: NodeJS.ProcessEnv = process.env): CliArgs => {
  const args: CliArgs = { help: false, version: false, cwd: process.cwd(), noPublish: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "-v":
      case "--version":
        args.version = true;
        break;
      case "--port":
        args.port = Number.parseInt(argv[++index] ?? "", 10);
        break;
      case "--host":
        args.host = argv[++index];
        break;
      case "--cwd":
        args.cwd = argv[++index] ?? args.cwd;
        break;
      case "--model":
      case "-m":
        args.model = argv[++index];
        break;
      case "--db":
        args.dbPath = argv[++index];
        break;
      case "--nah-bin":
        args.nahBin = argv[++index];
        break;
      case "--no-publish":
        args.noPublish = true;
        break;
      default:
        // An unknown flag is an error rather than a shrug: this command is
        // scripted by `/studio`, and a silently ignored flag would leave it
        // pointing the agents at the wrong place.
        if (flag?.startsWith("-")) throw new Error(`unknown option ${flag}`);
    }
  }
  // A port that is not a number is a mistake worth naming, not a NaN that fails
  // later inside `listen` with a message about address resolution.
  if (args.port !== undefined && !Number.isInteger(args.port)) throw new Error(`--port must be a number`);
  if (!args.model && env.NAH_MODEL) args.model = env.NAH_MODEL;
  return args;
};

const main = async (): Promise<number> => {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
    return 2;
  }

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${typeof __NAH_STUDIO_VERSION__ === "string" ? __NAH_STUDIO_VERSION__ : "0.0.0"}\n`);
    return 0;
  }

  const handle = await runServe({
    cwd: args.cwd,
    ...(args.port === undefined ? {} : { port: args.port }),
    ...(args.host === undefined ? {} : { host: args.host }),
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.dbPath === undefined ? {} : { dbPath: args.dbPath }),
    ...(args.nahBin === undefined ? {} : { nahBin: args.nahBin }),
    ...(args.noPublish ? { noPublish: true } : {}),
  });

  // Blocked rather than left to the event loop: the server is the process, and
  // exiting on the first signal with the database still open is how a WAL file
  // ends up needing recovery.
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
  await handle.close();
  return 0;
};

declare const __NAH_STUDIO_VERSION__: string;

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`nah-studio: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
