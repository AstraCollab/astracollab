import { HELP_TEXT, parseCliArgs } from "./args.js";
import { c } from "./render.js";
import {
  allocateSessionFile,
  latestSessionFile,
  resolveSessionFile,
  withFileInclusions,
} from "./context.js";
import { parsePermissionMode, type PermissionMode } from "./permissions.js";
import { renderTurn, startRepl } from "./repl.js";
import { makeState } from "./state.js";
import { flushStopNotice, resolveInjection, runTurn, resumeSession } from "./session.js";
import { confirmOnStdout, currentNahBin, runStudioCommand } from "./studio-command.js";
import { startTuiHost } from "./tui/host.js";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { McpClient } from "./mcp/client.js";
import {
  findMcpServerByUrl,
  getMcpServer,
  getMcpServers,
  setMcpServer,
} from "./nah-config.js";
import { getStoredCloudToken, storeCloudToken } from "./credentials.js";
import * as readline from "node:readline";
import { createInterface } from "node:readline/promises";

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

/** `nah mcp connect | list | tools <name>` — run and exit, no TTY required. */
const handleMcpCommand = async (action: string, cwd: string): Promise<number> => {
  const [verb, ...rest] = action.split(/\s+/);

  if (verb === "list") {
    const servers = await getMcpServers();
    const names = Object.keys(servers);
    if (names.length === 0) {
      process.stdout.write("No MCP servers registered. Run: nah mcp connect <name> <url>\n");
      return 0;
    }
    process.stdout.write("Registered MCP servers:\n");
    for (const name of names) {
      const config = servers[name];
      if (!config) continue;
      process.stdout.write(`  ${name} -> ${config.url}${config.organizationId ? ` (org ${config.organizationId})` : ""}\n`);
    }
    return 0;
  }

  if (verb === "connect") {
    const [name, url] = rest;
    if (!name || !url) {
      process.stderr.write("usage: nah mcp connect <name> <url>\n");
      return 2;
    }
    try {
      await setMcpServer(name, { url });
      process.stdout.write(`Registered MCP server ${name} -> ${url}\n`);
    } catch (error) {
      process.stderr.write(`nah: could not register server: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    // Offer to save a bearer token for this server.
    const token = await promptHidden("Cloud bearer token (leave blank to skip): ");
    if (token) {
      try {
        await storeCloudToken(name);
        process.stdout.write(c.dim("  bearer token saved to the device credential store\n"));
      } catch (error) {
        process.stderr.write(`nah: could not save token: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    return 0;
  }

  if (verb === "tools") {
    const [name] = rest;
    if (!name) {
      process.stderr.write("usage: nah mcp tools <name>\n");
      return 2;
    }
    const config = await getMcpServer(name);
    if (!config) {
      process.stderr.write(`nah: no MCP server registered as ${name}\n`);
      return 1;
    }
    const token = await getStoredCloudToken(config.organizationId ?? name);
    const client = new McpClient({ baseUrl: config.url, token: () => token });
    try {
      await client.initialize();
      const tools = await client.listTools();
      if (tools.length === 0) {
        process.stdout.write(`No tools exposed by ${name}\n`);
        return 0;
      }
      process.stdout.write(`Tools on ${name} (${config.url}):\n`);
      for (const tool of tools) {
        process.stdout.write(`  ${tool.name}: ${tool.description ?? "(no description)"}\n`);
      }
      return 0;
    } catch (error) {
      process.stderr.write(`nah: could not list tools: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  process.stderr.write(`nah: unknown mcp action "${action}" — connect | list | tools <name>\n`);
  return 2;
};

/** Hidden prompt for a bearer token (falls back to visible readline). */
const promptHidden = (question: string): Promise<string | undefined> => {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    const prompt = readline.createInterface({ input, output: process.stdout, terminal: false });
    return new Promise((resolve) => {
      prompt.question(question, (answer) => {
        prompt.close();
        resolve(answer.trim() || undefined);
      });
    });
  }
  return new Promise((resolve) => {
    let value = "";
    const finish = (secret?: string) => {
      input.off("keypress", onKeypress);
      input.setRawMode(false);
      process.stdout.write("\n");
      resolve(secret);
    };
    const onKeypress = (sequence: string, key: readline.Key) => {
      if (key.ctrl && key.name === "c") return finish();
      if (key.name === "return") return finish(value || undefined);
      if (key.name === "backspace") {
        value = Array.from(value).slice(0, -1).join("");
        process.stdout.write("\b \b");
        return;
      }
      if (!key.ctrl && !key.meta && sequence && sequence >= " " && sequence !== "\u007f") {
        value += sequence;
        process.stdout.write("•".repeat(Array.from(sequence).length));
      }
    };
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    input.on("keypress", onKeypress);
    process.stdout.write(question);
  });
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

  // `nah mcp connect | list | tools <name>` run and exit, no TTY required.
  if (typeof args.mcpCommand === "string") {
    return handleMcpCommand(args.mcpCommand, args.cwd);
  }

  // `--mcp <url>`: connect this session to an MCP server.
  let mcpClient: McpClient | null = null;
  if (args.mcp) {
    const found = await findMcpServerByUrl(args.mcp);
    const baseUrl = found ? found.config.url : args.mcp;
    const account = found?.config.organizationId ?? found?.name ?? args.mcp;
    const token = await getStoredCloudToken(account);
    mcpClient = new McpClient({ baseUrl, token: () => token });
    try {
      await mcpClient.initialize();
    } catch (error) {
      process.stderr.write(
        `nah: could not connect to MCP server ${args.mcp}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
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
      mcpClient,
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
        flushStopNotice(state, (line) => process.stdout.write(`${line}\n`));
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
    mcpClient,
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
    // stderr, because stdout is the event stream in --json and a line of prose
    // there corrupts it for anything parsing the output.
    flushStopNotice(state, (line) => process.stderr.write(`nah: ${line}\n`));
    // This process exits in a moment, and a request cancelled by the exit would
    // lose the only trace it will ever produce. An interactive session does not
    // need this — nothing is waiting on it to exit.
    await state.studio?.settled();
    // A run that stopped holding a call did not do the task, and a piped run has
    // nobody to answer the hold, so exiting 0 is the quiet failure this exists
    // to remove.
    return result.reason === "error" || result.reason === "awaiting-approval" ? 1 : 0;
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
