import { HELP_TEXT, parseCliArgs } from "./args.js";
import {
  allocateSessionFile,
  latestSessionFile,
  resolveSessionFile,
  withFileInclusions,
} from "./context.js";
import { parsePermissionMode, type PermissionMode } from "./permissions.js";
import { renderTurn, startRepl } from "./repl.js";
import { makeState } from "./state.js";
import { resolveInjection, runTurn, resumeSession } from "./session.js";
import { confirmOnStdout, currentNahBin, runStudioCommand } from "./studio-command.js";
import { startTuiHost } from "./tui/host.js";
import { ProcessTerminal } from "@earendil-works/pi-tui";

// Inlined at build time by vite define (keeps dist/cli.js self-contained).
declare const __NAH_VERSION__: string;
const pkg = { version: typeof __NAH_VERSION__ === "string" ? __NAH_VERSION__ : "0.0.0" };

/**
 * The alternate-screen TUI needs a real terminal and a writable frame buffer.
 * Anything else (CI, pipes, dumb terminals, `NO_COLOR` runs) keeps the
 * line-oriented renderer, which is also the escape hatch via --no-tui.
 */
const tuiAvailable = (noTui: boolean): boolean =>
  !noTui && Boolean(process.stdin.isTTY) && process.stdout.isTTY === true && process.env.TERM !== "dumb";

const readStdin = async (): Promise<string> => {
  if (process.stdin.isTTY) {
    return "";
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
};

const main = async (): Promise<number> => {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.showHelp) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (args.showVersion) {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }

  // `nah serve` is `/studio` from a shell: same command, same package, same
  // background process. It used to serve a bundled copy of the dashboard out of
  // this binary, which meant shipping a browser app inside a terminal agent and
  // making every dashboard change a CLI release.
  if (args.serve) {
    const env = { ...process.env, ...(args.servePort === undefined ? {} : { NAH_STUDIO_PORT: String(args.servePort) }) };
    await runStudioCommand(`/studio ${args.serveAction ?? ""}`, {
      cwd: args.cwd,
      out: process.stdout,
      confirm: confirmOnStdout,
      env,
      ...(currentNahBin() === undefined ? {} : { nahBin: currentNahBin() }),
    });
    return 0;
  }

  const stdin = await readStdin();
  let prompt = args.prompt ?? "";
  if (stdin) {
    prompt = [...(prompt ? [prompt] : []), "", stdin].join("\n").trim();
  }
  prompt = await withFileInclusions(args.cwd, args.files, prompt);

  // Session selection:
  //   --session <id|path>  load exactly that session
  //   -c / --continue     resume the most recent session for this cwd
  //   (neither)            start a NEW session in its own file
  const noSession = args.noSession;
  const sessionPath = noSession
    ? undefined
    : args.sessionPath
      ? resolveSessionFile(args.cwd, args.sessionPath)
      : args.continueSession
        ? await latestSessionFile(args.cwd)
        : await allocateSessionFile(args.cwd);

  // Interactive sessions gate mutating tools by default; print/json is yolo
  // (there's no way to answer prompts non-interactively — pass --permissions readonly to lock down).
  let permissions: PermissionMode = args.mode === "interactive" ? "ask" : "yolo";
  if (args.yolo) {
    permissions = "yolo";
  }
  const fromFlag = parsePermissionMode(args.permissions);
  if (fromFlag) {
    permissions = fromFlag;
  } else if (args.permissions) {
    process.stderr.write(`nah: invalid --permissions "${args.permissions}" (ask|yolo|readonly)\n`);
    return 2;
  }

  if (args.mode === "interactive") {
    const state = await makeState({
      cwd: args.cwd,
      modelSpec: args.model,
      sessionPath,
      noSession,
      permissions,
      sandbox: args.sandbox,
      allowUnconfiguredModel: true,
    });
    try {
      if (args.continueSession || args.sessionPath) {
        const resumed = await resumeSession(state);
        if (resumed) {
          process.stdout.write(`(resumed ${state.messages.length} messages)\n`);
        }
      }
      if (prompt) {
        // Memory is resolved before the request is composed, not inside runTurn,
        // which is synchronous. Without this the first turn of a session runs
        // with an empty memory block.
        const turn = runTurn(state, prompt, {}, await resolveInjection(state, prompt));
        await renderTurn(turn.events);
        await turn.done;
        process.stdout.write("\n");
      }
      if (tuiAvailable(args.noTui)) {
        await startTuiHost({ state, terminal: new ProcessTerminal() });
        return 0;
      }
      await startRepl(state);
      return 0;
    } finally {
      await state.destroySandbox?.().catch(() => undefined);
    }
  }

  // print / json: single shot
  if (!prompt) {
    process.stderr.write("nah: no prompt (print mode). Use -p \"...\" or pipe stdin.\n");
    return 2;
  }

  const state = await makeState({
    cwd: args.cwd,
    modelSpec: args.model,
    sessionPath,
    noSession,
    permissions,
    sandbox: args.sandbox,
  });
  try {
    if (args.continueSession || args.sessionPath) {
      await resumeSession(state);
    }

    const turn = runTurn(state, prompt, {}, await resolveInjection(state, prompt));
    if (args.mode === "json") {
      for await (const event of turn.events) {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      }
    } else {
      for await (const event of turn.events) {
        if (event.type === "text-delta") {
          process.stdout.write(event.text);
        }
      }
      process.stdout.write("\n");
    }
    const result = await turn.done;
    // This process exits in a moment, and a request cancelled by the exit would
    // lose the only trace it will ever produce. An interactive session does not
    // need this — nothing is waiting on it to exit.
    await state.studio?.settled();
    return result.reason === "error" ? 1 : 0;
  } finally {
    await state.destroySandbox?.().catch(() => undefined);
  }
};

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    process.stderr.write(`nah: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
