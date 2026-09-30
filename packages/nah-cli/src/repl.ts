import * as readline from "node:readline/promises";

import type { HarnessEvent } from "@astracollab/not-another-harness";

import { buildNahSystemPrompt, defaultSessionFile, withFileInclusions } from "./context.js";
import { resolveModel } from "./model.js";
import { createApprover, parsePermissionMode, type PermissionMode } from "./permissions.js";
import { c, toolLabel, usageLine } from "./render.js";
import { runTurn, type SessionState } from "./session.js";

const REPL_HELP = `Slash commands:
  /help                 Show this help
  /model <spec>         Switch model (e.g. /model openai:gpt-5.2)
  /permissions [mode]   ask | yolo | readonly (gate edit/write/bash)
  /stats                Tokens used this session
  /clear                Drop the transcript (start fresh)
  /session new|off      New JSONL session file / stop persisting
  /compact              Force transcript compaction (truncate mode)
  /quit                 Exit (Ctrl-C also aborts the current turn)

Everything else is sent to the agent. Prefix files with @ to include them.`;

/** Render one turn to stdout: streamed text + one line per tool call. */
export const renderTurn = async (
  events: AsyncIterable<HarnessEvent>,
  out: NodeJS.WriteStream = process.stdout,
): Promise<void> => {
  let textOpen = false;
  const nl = () => {
    if (textOpen) {
      out.write("\n");
      textOpen = false;
    }
  };

  for await (const e of events) {
    switch (e.type) {
      case "text-delta":
        out.write(e.text);
        textOpen = true;
        break;
      case "tool-call":
        nl();
        out.write(`${c.cyan("●")} ${c.bold(toolLabel(e.toolName, e.input))}\n`);
        break;
      case "tool-result": {
        if (!e.isError) {
          break;
        }
        out.write(`  ${c.red("✕")} ${c.dim(e.output.split("\n")[0]?.slice(0, 120) ?? "error")}\n`);
        break;
      }
      case "compacted":
        nl();
        out.write(
          c.dim(`  ⤓ compacted transcript (−${e.droppedMessages} messages, kept ${e.keptMessages})\n`),
        );
        break;
      case "step-finish":
        break; // per-step usage stays quiet; /stats has the totals
      case "finish":
        nl();
        out.write(`${c.dim(usageLine(e.usage) + (e.reason === "completed" ? "" : ` · ${e.reason}`))}\n`);
        break;
      case "error":
        nl();
        out.write(`${c.red("error:")} ${e.error instanceof Error ? e.error.message : String(e.error)}\n`);
        break;
      default:
        break;
    }
  }
};

type SlashResult = "handled" | "quit" | "not-a-command";

export const handleSlashCommand = async (
  input: string,
  state: SessionState,
  cwd: string,
  out: NodeJS.WriteStream = process.stdout,
): Promise<SlashResult> => {
  const [cmd, ...rest] = input.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();

  switch (cmd) {
    case "help":
      out.write(`${REPL_HELP}\n`);
      return "handled";
    case "quit":
    case "exit":
      return "quit";
    case "clear":
      state.messages = [];
      out.write(c.dim("(transcript cleared — session file untouched)\n"));
      return "handled";
    case "stats":
      out.write(
        c.dim(
          `${state.turns} turns · ${usageLine(state.totalUsage)} · ${state.messages.length} messages`,
        ) + "\n",
      );
      return "handled";
    case "model": {
      if (!arg) {
        out.write(c.dim(`current model: ${state.model.spec}\n`));
        return "handled";
      }
      try {
        state.model = await resolveModel(arg);
        out.write(c.dim(`model → ${state.model.spec}\n`));
      } catch (e) {
        out.write(c.red(e instanceof Error ? e.message : String(e)) + "\n");
      }
      return "handled";
    }
    case "permissions": {
      if (!arg) {
        out.write(c.dim(`permissions: ${state.permissions}\n`));
        return "handled";
      }
      const mode = parsePermissionMode(arg);
      if (!mode) {
        out.write(c.red("usage: /permissions ask|yolo|readonly") + "\n");
        return "handled";
      }
      state.permissions = mode;
      out.write(c.dim(`permissions → ${mode}\n`));
      return "handled";
    }
    case "session": {
      if (arg === "off") {
        state.store = null;
        out.write(c.dim("(session persistence off for this process)\n"));
        return "handled";
      }
      if (arg === "new") {
        const p = `${defaultSessionFile(cwd)}`.replace(/\.jsonl$/, `-${Date.now()}.jsonl`);
        const { createJsonlSessionStore } = await import("@astracollab/not-another-harness");
        state.store = createJsonlSessionStore(p);
        state.messages = [];
        out.write(c.dim(`new session → ${p}\n`));
        return "handled";
      }
      out.write(c.red("usage: /session new | off") + "\n");
      return "handled";
    }
    case "compact": {
      const { compactMessages } = await import("@astracollab/not-another-harness");
      const compacted = await compactMessages({
        model: state.model.model,
        system: state.system,
        messages: state.messages,
        keepRecent: 6,
        mode: "truncate",
      });
      if (!compacted) {
        out.write(c.dim("(nothing to compact yet)\n"));
      } else {
        state.messages = compacted.messages;
        out.write(c.dim(`compacted −${compacted.droppedMessages} messages\n`));
      }
      return "handled";
    }
    default:
      if (cmd) {
        out.write(c.red(`unknown command /${cmd} — /help`) + "\n");
        return "handled";
      }
      return "not-a-command";
  }
};

export const startRepl = async (state: SessionState): Promise<void> => {
  const out = process.stdout;
  out.write(`${c.bold("nah")} ${c.dim("— not another harness")} · ${c.dim(state.sandboxCwd ?? state.cwd)}\n`);
  out.write(c.dim(`model: ${state.model.spec} · permissions: ${state.permissions} · /help for commands`) + "\n\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: out,
    terminal: true,
    historySize: 500,
    prompt: c.magenta("nah ❯ "),
  });

  let abort: AbortController | null = null;
  const onSigint = () => {
    if (abort) {
      abort.abort();
      out.write(c.dim("\n(turn aborted)\n"));
    } else {
      rl.close();
    }
  };
  process.on("SIGINT", onSigint);

  rl.prompt();
  try {
    for await (const line of rl) {
      const input = line.trim();
      if (!input) {
        rl.prompt();
        continue;
      }
      if (input.startsWith("/")) {
        const r = await handleSlashCommand(input, state, state.cwd, out);
        if (r === "quit") {
          break;
        }
        rl.prompt();
        continue;
      }

      abort = new AbortController();
      const files = input.match(/@([^\s]+)/g)?.map((s) => s.slice(1)) ?? [];
      const prompt = await withFileInclusions(state.cwd, files, input.replace(/@[^\s]+/g, "").trim());
      const turn = runTurn(state, prompt, { signal: abort.signal });
      try {
        await renderTurn(turn.events, out);
        await turn.done;
      } catch (e) {
        out.write(c.red(e instanceof Error ? e.message : String(e)) + "\n");
      } finally {
        abort = null;
      }
      out.write("\n");
      rl.prompt();
    }
  } finally {
    process.off("SIGINT", onSigint);
    rl.close();
  }
};

/** Build a fresh session state (shared by print/json/interactive modes). */
export const makeState = async (opts: {
  cwd: string;
  modelSpec?: string;
  sessionPath?: string;
  noSession?: boolean;
  permissions?: PermissionMode;
  /** Blaxel sandbox name, or true to create an ephemeral one. */
  sandbox?: string | true;
  extraSystemAppend?: string;
}): Promise<SessionState> => {
  const model = await resolveModel(opts.modelSpec);
  const { createCodingTools, createJsonlSessionStore } = await import(
    "@astracollab/not-another-harness"
  );

  let envToolSource: Parameters<typeof createCodingTools>[0];
  let cwdLabel = opts.cwd;
  let destroySandbox: (() => Promise<void>) | undefined;
  if (opts.sandbox) {
    const { createBlaxelEnvironment } = await import("./sandbox.js");
    const bl = await createBlaxelEnvironment({
      sandboxName: opts.sandbox === true ? undefined : opts.sandbox,
    });
    envToolSource = bl.env;
    cwdLabel = `blaxel sandbox ${bl.sandboxName}`;
    destroySandbox = bl.destroy;
  } else {
    const { createNodeEnvironment } = await import("@astracollab/not-another-harness/node");
    envToolSource = createNodeEnvironment(opts.cwd);
  }

  const system =
    opts.sandbox != null
      ? [
          await buildSystemPromptFor(opts.cwd, cwdLabel),
          "",
          `You are working in a remote sandbox (repo at ${cwdLabel === opts.cwd ? opts.cwd : "/workspace/repo"}). Changes do not affect the local machine.`,
        ].join("\n")
      : await buildNahSystemPrompt(opts.cwd);

  const state: SessionState = {
    messages: [],
    system,
    cwd: opts.cwd,
    tools: {},
    store:
      opts.noSession || !opts.sessionPath ? null : createJsonlSessionStore(opts.sessionPath),
    model,
    totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turns: 0,
    permissions: opts.permissions ?? "yolo",
    sandboxCwd: cwdLabel,
    destroySandbox,
  };
  const approve = createApprover(() => state.permissions);
  state.tools = createCodingTools(envToolSource, { approveToolCall: approve, cwdLabel });
  return state;
};

const buildSystemPromptFor = async (cwd: string, label: string): Promise<string> => {
  const { buildSystemPrompt } = await import("@astracollab/not-another-harness");
  const { loadContextFiles } = await import("./context.js");
  return buildSystemPrompt({ cwdLabel: label, contextFiles: await loadContextFiles(cwd) });
};
