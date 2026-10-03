/**
 * Tool-input sanitisers.
 *
 * ## Why these live here and not in the harness
 *
 * Every one of these is a workaround for a *model* emitting input the schema
 * rejects, not a capability the harness is missing. The harness should not know
 * that one provider in particular writes `"True"` for a boolean — that is a fact
 * about the traffic, and it changes monthly. So the sanitisers sit between the
 * model and the tool, and the harness keeps validating strictly.
 *
 * ## Why they are not optional
 *
 * A tool call rejected by its own schema is a failed step: the model gets an
 * error, retries, and often emits the same malformed field again. Every case here
 * was observed in production traffic, and each one turned a working agent into a
 * looping one.
 */
import type { ToolSet } from "ai";

/** `"True"`, `"false"`, `"null"`, `"undefined"`, and blanks all mean "absent". */
const BLANK = new Set(["", "null", "undefined", "nil", "none"]);

export const isBlank = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  (typeof value === "string" && BLANK.has(value.trim().toLowerCase()));

/**
 * A boolean from whatever the model felt like sending.
 *
 * Python-style capitals are the common case: some models emit JSON-ish `True` /
 * `False` / `None` because that is what their training data looks like, and a
 * strict `z.boolean()` rejects the lot.
 */
export const coerceOptionalBoolean = (value: unknown): boolean | undefined => {
  if (isBlank(value)) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (text === "true" || text === "yes" || text === "y" || text === "1") return true;
    if (text === "false" || text === "no" || text === "n" || text === "0") return false;
  }
  return undefined;
};

/** A number from `"20"`, `"1.5"` or a real number. Blank is absent, not zero. */
export const coerceOptionalNumber = (value: unknown): number | undefined => {
  if (isBlank(value)) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" || typeof value === "boolean") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

/** A string, with blanks becoming absent. Numbers are stringified, not dropped. */
export const coerceOptionalString = (value: unknown): string | undefined => {
  if (isBlank(value)) return undefined;
  if (typeof value === "string") {
    const text = value.trim();
    return text.length > 0 ? text : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
};

/** Keys whose values are absent when `undefined`, rather than set to it. */
type Shape = Record<string, (value: unknown) => unknown>;

const applyShape = (raw: unknown, shape: Shape): unknown => {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const out = { ...(raw as Record<string, unknown>) };
  for (const [key, coerce] of Object.entries(shape)) {
    const value = coerce(out[key]);
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out;
};

/** A raw string that is really JSON is parsed rather than rejected. */
const parseIfJson = (raw: unknown): unknown => {
  if (typeof raw !== "string") return raw;
  const text = raw.trim();
  if (!text.startsWith("{")) return raw;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return raw;
  }
};

export const sanitiseExecuteInput = (raw: unknown): unknown =>
  applyShape(raw, { background: coerceOptionalBoolean, tail: coerceOptionalNumber, timeout: coerceOptionalNumber, cwd: coerceOptionalString });

export const sanitiseWriteInput = (raw: unknown): unknown =>
  applyShape(parseIfJson(raw), { append: coerceOptionalBoolean, leading_newline: coerceOptionalBoolean });

export const sanitiseEditInput = (raw: unknown): unknown =>
  applyShape(raw, { old_string: coerceOptionalString, new_string: coerceOptionalString });

export const sanitiseReadInput = (raw: unknown): unknown => applyShape(raw, { start: coerceOptionalNumber, end: coerceOptionalNumber });

/**
 * `listFiles` receives `path` and, separately, `pattern`.
 *
 * Models mirror one into the other — `path: "/workspace/repo"` and
 * `pattern: "/workspace/repo"` — and a directory is not a valid glob. Left alone
 * it fails with an unhelpful error next to unrelated stream-writer failures; the
 * two are impossible to tell apart from a log.
 */
export const sanitiseListFilesInput = (raw: unknown): unknown => {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const out = { ...(raw as Record<string, unknown>) };
  const pattern = coerceOptionalString(out.pattern);
  const path = coerceOptionalString(out.path);
  if (pattern !== undefined) out.pattern = pattern;
  if (path !== undefined) out.path = path;
  // Only a `pattern` that is exactly the path is wrong. A genuine glob is left
  // alone, because guessing which one a model meant is how a working filter
  // becomes a silent full-directory listing.
  if (pattern !== undefined && path !== undefined && pattern === path && !/[*?[\]{}]/.test(pattern)) {
    delete out.pattern;
  }
  return out;
};

/** Per-tool sanitisers, applied before the tool's own schema sees the input. */
export type ToolSanitisers = Record<string, (raw: unknown) => unknown>;

const TOOL_SANITISERS: ToolSanitisers = {
  execute_command: sanitiseExecuteInput,
  bash: sanitiseExecuteInput,
  write_file: sanitiseWriteInput,
  write: sanitiseWriteInput,
  edit_file: sanitiseEditInput,
  edit: sanitiseEditInput,
  read_file: sanitiseReadInput,
  read: sanitiseReadInput,
  list_files: sanitiseListFilesInput,
  glob: sanitiseListFilesInput,
};

/** Every sanitiser, for a tool this table has never heard of. */
const GENERIC: ToolSanitisers = {
  execute_command: sanitiseExecuteInput,
  bash: sanitiseExecuteInput,
  write_file: sanitiseWriteInput,
  write: sanitiseWriteInput,
  edit_file: sanitiseEditInput,
  edit: sanitiseEditInput,
  read_file: sanitiseReadInput,
  read: sanitiseReadInput,
  list_files: sanitiseListFilesInput,
  glob: sanitiseListFilesInput,
};

export const sanitiserFor = (toolName: string): ((raw: unknown) => unknown) | undefined =>
  TOOL_SANITISERS[toolName] ?? GENERIC[toolName];

/**
 * Wrap a tool map so every call is sanitised before its schema runs.
 *
 * Two properties worth stating, because both were ways the old per-tool wrapper
 * went wrong:
 *
 * - **The schema is not relaxed.** Input is coerced, not the validator, so a
 *   genuinely wrong call still fails instead of reaching a tool.
 * - **A sanitiser that throws does not take the turn down.** It falls through to
 *   the raw input, because a bad heuristic must not be a worse failure than the
 *   bug it was written for.
 */
export const wrapToolsWithSanitisers = (tools: ToolSet, extra: ToolSanitisers = {}): ToolSet => {
  const out: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    const sanitise = extra[name] ?? sanitiserFor(name);
    if (!sanitise) {
      out[name] = tool;
      continue;
    }
    const inner = tool as { execute?: (input: unknown, options: unknown) => unknown };
    if (typeof inner.execute !== "function") {
      out[name] = tool;
      continue;
    }
    out[name] = {
      ...tool,
      execute: async (input: unknown, options: unknown) => {
        let prepared = input;
        try {
          prepared = sanitise(input);
        } catch {
          prepared = input;
        }
        return inner.execute!(prepared, options);
      },
    } as ToolSet[string];
  }
  return out;
};