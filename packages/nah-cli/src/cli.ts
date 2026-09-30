import { HELP_TEXT, parseCliArgs } from "./args.js";
import { defaultSessionFile, withFileInclusions } from "./context.js";
import { parsePermissionMode, type PermissionMode } from "./permissions.js";
import { makeState, renderTurn, startRepl } from "./repl.js";
import { runTurn, resumeSession } from "./session.js";

// Inlined at build time by vite define (keeps dist/cli.js self-contained).
declare const __NAH_VERSION__: string;
const pkg = { version: typeof __NAH_VERSION__ === "string" ? __NAH_VERSION__ : "0.0.0" };

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

  const stdin = await readStdin();
  let prompt = args.prompt ?? "";
  if (stdin) {
    prompt = [...(prompt ? [prompt] : []), "", stdin].join("\n").trim();
  }
  prompt = await withFileInclusions(args.cwd, args.files, prompt);

  const sessionPath = args.sessionPath ?? defaultSessionFile(args.cwd);

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
      noSession: args.noSession,
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
        const turn = runTurn(state, prompt);
        await renderTurn(turn.events);
        await turn.done;
        process.stdout.write("\n");
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
    noSession: args.noSession,
    permissions,
    sandbox: args.sandbox,
  });
  try {
    if (args.continueSession || args.sessionPath) {
      await resumeSession(state);
    }

    const turn = runTurn(state, prompt);
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
