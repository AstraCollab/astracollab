/**
 * Suppress re-reads of lines this run has already fetched.
 *
 * The transcript re-sends everything on every step, so a line read twice is
 * paid for twice directly and again on every later request. Observed on a real
 * design-system port: `read Dashboard.tsx` with `offset: 700` and no limit read
 * to end of file, and the very next call asked for `offset: 950` - already
 * inside the range just fetched, costing a step and ~2k tokens for nothing.
 *
 * Deliberately invalidated by anything that can change a file. A cache that
 * served a stale read after `git checkout` would be far worse than the duplicate
 * it prevents, so the window closes the moment a mutating tool runs. That still
 * covers the case worth fixing: consecutive reads, which is exactly where the
 * redundancy happens.
 */
import { DEFAULT_CAPS } from "./caps.js";

type ToolLike = Record<string, unknown>;

const isExecutable = (tool: unknown): tool is { execute: (input: unknown, ctx: unknown) => Promise<unknown> } =>
  typeof tool === "object" &&
  tool !== null &&
  typeof (tool as { execute?: unknown }).execute === "function";

/** Tools that can change a file, which closes the coverage window. */
const MUTATING = new Set(["write", "edit", "multi_edit", "bash", "task_ledger", "delegate_task"]);

type Range = { start: number; end: number; body: unknown };

export type ReadCoverage = {
  /** Tool map to hand to the model, with redundant reads suppressed. */
  tools: ToolLike;
  /** Reads answered from what was already fetched. */
  readonly servedFromCache: number;
  /** Reads that had to go to the filesystem. */
  readonly performed: number;
};

/** The notice the read tool appends, which goes stale once the range is cached. */
const NOTICE = /\n\[truncated:[^\]]*\]\s*$/;

const requestedRange = (input: unknown): { path: string; start: number; end: number } | null => {
  const args = (input ?? {}) as { path?: unknown; offset?: unknown; limit?: unknown };
  if (typeof args.path !== "string" || args.path.length === 0) return null;
  const start = typeof args.offset === "number" && args.offset >= 1 ? Math.floor(args.offset) : 1;
  const limit =
    typeof args.limit === "number" && args.limit >= 1
      ? Math.floor(args.limit)
      : DEFAULT_CAPS.read.maxLines;
  return { path: args.path, start, end: start + limit - 1 };
};

export const createReadCoverage = (tools: ToolLike): ReadCoverage => {
  /** path -> ranges fetched, newest last. Cleared wholesale on a mutation. */
  const covered = new Map<string, Range[]>();
  let servedFromCache = 0;
  let performed = 0;

  const wrapped: ToolLike = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!isExecutable(tool)) {
      wrapped[name] = tool;
      continue;
    }
    wrapped[name] = {
      ...tool,
      execute: async (input: unknown, ctx: unknown) => {
        if (MUTATING.has(name)) {
          covered.clear();
          return tool.execute(input, ctx);
        }
        if (name !== "read") return tool.execute(input, ctx);

        const range = requestedRange(input);
        if (range) {
          const hit = (covered.get(range.path) ?? []).find(
            (entry) => range.start >= entry.start && range.end <= entry.end,
          );
          if (hit) {
            servedFromCache += 1;
            const body = typeof hit.body === "string" ? hit.body.replace(NOTICE, "") : hit.body;
            // Says where the lines came from, so a later `offset` the model
            // derives from a stale truncation notice is not misled by it.
            return `${body}\n[cached: lines ${hit.start}-${hit.end} of ${range.path} were already read in this run]`;
          }
        }

        performed += 1;
        const result = await tool.execute(input, ctx);
        if (range) {
          const entries = covered.get(range.path) ?? [];
          entries.push({ start: range.start, end: range.end, body: result });
          covered.set(range.path, entries);
        }
        return result;
      },
    };
  }

  return {
    tools: wrapped,
    get servedFromCache() {
      return servedFromCache;
    },
    get performed() {
      return performed;
    },
  };
};