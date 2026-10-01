/**
 * Per-step de-duplication of identical tool calls.
 *
 * Models sometimes emit the same tool call twice in a single response. Nothing
 * can have changed between the two — they execute back to back within one step —
 * so the second is wasted work whose output also becomes permanent transcript
 * weight, replayed on every step after it.
 *
 * Observed on a real release-audit run: 61% of the shell commands were exact
 * duplicates. Each duplicate is charged once directly and again on every
 * subsequent step, so a few kilobytes of repeated output early in a long run
 * turns into tens of thousands of tokens by the end.
 *
 * Deliberately scoped to a single step: the same call in a later step may
 * legitimately need re-running after the agent has changed something.
 */

export type ToolLike = Record<string, unknown>;

const isExecutable = (tool: unknown): tool is { execute: (input: unknown, ctx: unknown) => Promise<unknown> } =>
  typeof tool === "object" &&
  tool !== null &&
  typeof (tool as { execute?: unknown }).execute === "function";

const keyFor = (name: string, input: unknown): string => {
  let serialised: string;
  try {
    serialised = JSON.stringify(input ?? null);
  } catch {
    // Non-serialisable input is rare; do not risk collapsing distinct calls.
    return "";
  }
  return `${name}\u0000${serialised}`;
};

export type StepDedupe = {
  /** Tool map to hand to the model, with de-duplication applied. */
  tools: ToolLike;
  /** Forget previous steps; duplicates are only collapsed within one step. */
  beginStep(): void;
  /** How many calls were served from the memo this step. */
  readonly skipped: number;
};

export const createStepDedupe = (tools: ToolLike): StepDedupe => {
  const seen = new Map<string, unknown>();
  let skipped = 0;

  const wrapped: ToolLike = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!isExecutable(tool)) {
      wrapped[name] = tool;
      continue;
    }
    wrapped[name] = {
      ...tool,
      execute: async (input: unknown, ctx: unknown) => {
        const key = keyFor(name, input);
        if (key) {
          if (seen.has(key)) {
            skipped += 1;
            return seen.get(key);
          }
        }
        const result = await tool.execute(input, ctx);
        if (key) seen.set(key, result);
        return result;
      },
    };
  }

  return {
    tools: wrapped,
    beginStep: () => {
      seen.clear();
      skipped = 0;
    },
    get skipped() {
      return skipped;
    },
  };
};