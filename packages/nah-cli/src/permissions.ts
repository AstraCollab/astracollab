import * as readline from "node:readline/promises";

import { c, toolLabel } from "./render.js";

export type PermissionMode = "ask" | "yolo" | "readonly";

/**
 * Approval policy for mutating tools (edit/write/bash):
 *  - readonly: always deny
 *  - yolo:     always allow
 *  - ask:      prompt in the terminal; "a" remembers per-tool for the session
 */
export const createApprover = (
  getMode: () => PermissionMode,
  out: NodeJS.WriteStream = process.stdout,
) => {
  const alwaysAllow = new Set<string>();
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
      if (!isTTY) {
        // No terminal to ask on — deny rather than hang.
        return false;
      }
      const label = toolLabel(toolName, input);
      const rl = readline.createInterface({ input: process.stdin, output: out });
      try {
        const answer = (
          await rl.question(
            `${c.yellow("!")} ${c.bold(label)} ${c.dim("— allow? [y/N/a(lways)]")} `,
          )
        )
          .trim()
          .toLowerCase();
        if (answer === "a") {
          alwaysAllow.add(permissionScope);
          out.write(c.dim(`(always allowing ${label} this session)`));
          return true;
        }
        return answer === "y" || answer === "yes";
      } finally {
        rl.close();
      }
    } finally {
      release();
    }
  };

  return async (toolName: string, input: unknown): Promise<boolean> => {
    const mode = getMode();
    if (mode === "readonly") {
      out.write(c.dim(`  ✕ blocked (readonly mode): ${toolLabel(toolName, input)}\n`));
      return false;
    }
    const permissionScope = scopeKey(toolName, input);
    if (mode === "yolo" || alwaysAllow.has(permissionScope)) {
      return true;
    }
    return ask(toolName, input, permissionScope, process.stdout.isTTY === true);
  };
};

export const parsePermissionMode = (raw: string | undefined): PermissionMode | null => {
  const v = raw?.trim().toLowerCase();
  if (v === "ask" || v === "yolo" || v === "readonly") {
    return v;
  }
  return null;
};
