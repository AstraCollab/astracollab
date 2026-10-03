import * as readline from "node:readline/promises";

import { c, toolLabel } from "./render.js";

export type PermissionMode = "ask" | "yolo" | "readonly";

/**
 * Approval policy for gated tools (edit/write/bash/web_fetch):
 *  - readonly: always deny, except for the tools in {@link READONLY_ALLOWED}
 *  - yolo:     always allow
 *  - ask:      prompt in the terminal; "a" remembers per-tool for the session
 */
/** Asks the user a question and resolves with the raw answer. */
export type ApprovalPromptFn = (question: string) => Promise<string>;

/**
 * Gated tools that `readonly` still permits.
 *
 * `readonly` is a promise about the workspace: nothing on disk changes. Reaching
 * the network is not a change to the workspace, so blocking it here would deny a
 * read to buy no safety — and it would deny it to the agent that most needs it,
 * because the Studio's dashboard agent runs `readonly` and the read-only
 * review agent is exactly the one asked to check a claim against its docs.
 *
 * The tool stays gated either way, so `ask` mode still prompts for every fetch.
 * What `readonly` gives up is the prompt, not the decision.
 */
const READONLY_ALLOWED = new Set(["web_fetch"]);

/**
 * Whether `readonly` permits this gated tool.
 *
 * Exported for the second place that answers the question, which is the Studio's
 * read-only agent: it rebuilds the tool set with its own hard-deny approver, and
 * without this it would ship a `web_fetch` that is present in the schema and
 * refuses every call — which reads to the model as a broken tool rather than as a
 * policy, and costs a step to rediscover on every turn.
 */
export const isReadonlyAllowed = (toolName: string): boolean =>
	READONLY_ALLOWED.has(toolName);

export type Approver = ((toolName: string, input: unknown) => Promise<boolean>) & {
  /**
   * Replace the terminal prompt.
   *
   * The readline default cannot work inside the alternate-screen TUI: stdin is
   * already owned in raw mode, so a second reader competes for keystrokes, its
   * prompt overwrites the painted frame, and the answer never arrives — leaving
   * the tool promise unresolved and the agent hung. The TUI installs its own
   * prompt here instead.
   */
  setPrompt(prompt: ApprovalPromptFn | null): void;
};

export const createApprover = (
  getMode: () => PermissionMode,
  out: NodeJS.WriteStream = process.stdout,
): Approver => {
  const alwaysAllow = new Set<string>();
  let askFn: ((question: string) => Promise<string>) | null = null;

  const scopeKey = (toolName: string, input: unknown): string => {
    const args = (input ?? {}) as Record<string, unknown>;
    if (toolName === "edit" && typeof args.path === "string") {
      return `${toolName}:${args.path}:${String(args.old_string)}:${String(args.new_string)}:${String(args.replace_all)}`;
    }
    if (toolName === "write" && typeof args.path === "string") {
      return `${toolName}:${args.path}:${String(args.content)}`;
    }
    if (toolName === "bash" && typeof args.command === "string") {
      return `${toolName}:${args.command}`;
    }
    /**
     * Per-URL rather than per-tool.
     *
     * `web_fetch` gets a fresh URL on essentially every call, so an approval
     * scoped to one URL is the only scope that means anything for it — and it is
     * the scope that keeps approving a single host from silently approving every
     * host the model asks about next. This is the same split opencode draws when
     * it offers `once` / `always` for a `webfetch` permission keyed on the URL.
     */
    if (toolName === "web_fetch" && typeof args.url === "string") {
      return `${toolName}:${args.url}`;
    }
    return toolName;
  };
  // Queued: two parallel tool calls in one step must not fight over stdin.
  let pending: Promise<void> = Promise.resolve();

  const ask = async (toolName: string, input: unknown, permissionScope: string, isTTY: boolean): Promise<boolean> => {
    let release!: () => void;
    const prev = pending;
    pending = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      if (!isTTY && !askFn) {
        // No terminal to ask on — deny rather than hang.
        return false;
      }
      const label = toolLabel(toolName, input);
      const question = `${label} — allow? [y / n / a=always this tool / A=always this exact call]`;
      /**
       * Plain text, with the amber left to the renderer.
       *
       * The two hosts apply the surface differently and neither can accept a
       * coloured string. The TUI clamps each row to the terminal width and loses a
       * nested SGR escape to that clamp, leaving the fill bleeding onto the rows
       * below — the failure `commandBlock`'s comment warns about at length. Readline
       * pads nothing, so there is no full-width row to paint. So the string carries
       * no escape of its own and each host supplies the fill: the TUI through
       * `addApproval`, readline by wrapping here.
       *
       * The `!` used to be `c.yellow`. On an amber surface that is the one pairing
       * guaranteed to disappear, so the fill now carries the emphasis on its own.
       */
      const plain = `  ! ${label} — allow? [y / n / a=always this tool / A=always this exact call]`;
      const readlinePrompt = `${c.backgroundWarn(plain)} `;
      // Case matters: "a" trusts the tool, "A" trusts only this exact call.
      const raw = (
        askFn
          ? await askFn(question)
          : await askOnReadline(readlinePrompt)
      ).trim();
      const answer = raw.toLowerCase();
      // "a" trusts the *tool* for the rest of the session, which is what people
      // mean when they pick it. Scoping it to the exact command string meant a
      // fresh prompt for every slightly different invocation — an agent running
      // `git status` then `git log` then `git diff` asked three times, which read
      // as the choice not having been remembered at all.
      // "A" must be tested first: it lowercases to "a", so checking the
      // tool-wide branch first would silently widen it.
      if (raw === "A") {
        alwaysAllow.add(permissionScope);
        return true;
      }
      if (answer === "a") {
        alwaysAllow.add(toolName);
        return true;
      }
      return answer === "y" || answer === "yes";
    } finally {
      release();
    }
  };

  /** The readline prompt, used only when no host has installed its own. */
  const askOnReadline = async (prompt: string): Promise<string> => {
    const rl = readline.createInterface({ input: process.stdin, output: out });
    try {
      return await rl.question(prompt);
    } finally {
      rl.close();
    }
  };

  const approve = async (toolName: string, input: unknown): Promise<boolean> => {
    const mode = getMode();
    if (mode === "readonly") {
      if (isReadonlyAllowed(toolName)) return true;
      out.write(c.dim(`  ✕ blocked (readonly mode): ${toolLabel(toolName, input)}\n`));
      return false;
    }
    const permissionScope = scopeKey(toolName, input);
    if (mode === "yolo" || alwaysAllow.has(toolName) || alwaysAllow.has(permissionScope)) {
      return true;
    }
    return ask(toolName, input, permissionScope, process.stdout.isTTY === true);
  };

  approve.setPrompt = (prompt: ApprovalPromptFn | null) => {
    askFn = prompt;
  };
  return approve;
};

export const parsePermissionMode = (raw: string | undefined): PermissionMode | null => {
  const v = raw?.trim().toLowerCase();
  if (v === "ask" || v === "yolo" || v === "readonly") {
    return v;
  }
  return null;
};
