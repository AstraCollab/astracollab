import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createCodingTools, runAgent } from "@astracollab/not-another-harness";
import { createNodeEnvironment } from "@astracollab/not-another-harness/node";
import { resolveModel } from "../src/model.js";

const selectedModel = process.env.NAH_EVAL_MODEL;
const requestedTasks = process.env.NAH_EVAL_TASKS?.split(",").map((task) => task.trim()).filter(Boolean);
const repeatValue = process.env.NAH_EVAL_REPEATS ?? "3";
const repeatCount = /^\d+$/.test(repeatValue) ? Number(repeatValue) : Number.NaN;

type LiveTask = {
  id: string;
  prompt: string;
  seed: Record<string, string>;
  verify: string;
};

const tasks: LiveTask[] = [
  {
    id: "clamp-boundaries",
    seed: { "math.mjs": "export const clamp = (value, min, max) => value;\n" },
    prompt: "Implement clamp in math.mjs. Return the input constrained inclusively to [min, max]. Throw RangeError when min > max. Throw TypeError unless value, min, and max are finite numbers. Do not add dependencies. Inspect the file first, then implement the smallest correct change.",
    verify: [
      "import assert from 'node:assert/strict';",
      "import { clamp } from './math.mjs';",
      "assert.equal(clamp(5, 0, 3), 3);",
      "assert.equal(clamp(-2, 0, 3), 0);",
      "assert.equal(clamp(2, 0, 3), 2);",
      "assert.equal(clamp(0, 0, 3), 0);",
      "assert.equal(clamp(3, 0, 3), 3);",
      "assert.throws(() => clamp(0, 2, 1), RangeError);",
      "assert.throws(() => clamp(NaN, 0, 1), TypeError);",
      "assert.throws(() => clamp(0, -Infinity, 1), TypeError);",
    ].join("\n"),
  },
  {
    id: "strict-port-parser",
    seed: { "config.mjs": "export const parsePort = (raw) => Number.parseInt(raw, 10) || 3000;\n" },
    prompt: "Fix parsePort in config.mjs. Undefined returns the default 3000. Otherwise accept only a string containing a canonical decimal integer from 1 through 65535. Throw TypeError for non-string inputs, and RangeError for empty, malformed, zero, negative, or out-of-range strings. Do not add dependencies.",
    verify: [
      "import assert from 'node:assert/strict';",
      "import { parsePort } from './config.mjs';",
      "assert.equal(parsePort(undefined), 3000);",
      "assert.equal(parsePort('1'), 1);",
      "assert.equal(parsePort('65535'), 65535);",
      "for (const raw of ['', '0', '-1', '65536', '3000abc', '03', ' 3']) assert.throws(() => parsePort(raw), RangeError, raw);",
      "for (const raw of [null, 3000, true]) assert.throws(() => parsePort(raw), TypeError);",
    ].join("\n"),
  },
  {
    id: "name-normalization",
    seed: { "name.mjs": "export const formatName = (first, last) => first + ' ' + last;\n" },
    prompt: "Update formatName in name.mjs to accept optional first and last name values. Treat null or undefined as empty, trim each value, collapse internal whitespace to single spaces, join the non-empty parts with one space, and return 'Anonymous' when both parts are empty. Do not add dependencies.",
    verify: [
      "import assert from 'node:assert/strict';",
      "import { formatName } from './name.mjs';",
      "assert.equal(formatName(' Ada  ', '  Lovelace '), 'Ada Lovelace');",
      "assert.equal(formatName('Ada', undefined), 'Ada');",
      "assert.equal(formatName(null, 'Lovelace'), 'Lovelace');",
      "assert.equal(formatName('  ', null), 'Anonymous');",
      "assert.equal(formatName(undefined, undefined), 'Anonymous');",
    ].join("\n"),
  },
];

const evalTasks = requestedTasks?.length ? tasks.filter((task) => requestedTasks.includes(task.id)) : tasks;
const defaultMetricsPath = fileURLToPath(new URL("../../not-another-harness/evals/live-results.jsonl", import.meta.url));
const metricsPath = path.resolve(process.env.NAH_EVAL_RESULTS ?? defaultMetricsPath);
const runId = `${new Date().toISOString()}-${process.pid}`;
const runRecords: Array<Record<string, unknown>> = [];
let workingTreeDirty = false;
const revision = process.env.GITHUB_SHA ?? process.env.NAH_EVAL_REVISION ?? (() => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  }
  catch { return "unknown"; }
})();
try {
  workingTreeDirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
} catch { /* A source revision may be supplied outside a git checkout. */ }

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const toolCallCount = (messages: Array<{ content: unknown }>): number => messages.reduce((total, message) => {
  if (!Array.isArray(message.content)) return total;
  return total + message.content.filter((part) => part && typeof part === "object" && "type" in part && part.type === "tool-call").length;
}, 0);

describe.skipIf(!selectedModel)("live coding-agent evaluations", () => {
  if (selectedModel && (!Number.isInteger(repeatCount) || repeatCount < 1 || repeatCount > 20)) {
    throw new Error("NAH_EVAL_REPEATS must be an integer from 1 to 20");
  }
  if (selectedModel && evalTasks.length === 0) {
    throw new Error(`NAH_EVAL_TASKS selected no known tasks. Available tasks: ${tasks.map((task) => task.id).join(", ")}`);
  }
  if (selectedModel && requestedTasks?.some((id) => !tasks.some((task) => task.id === id))) {
    throw new Error(`Unknown NAH_EVAL_TASKS id. Available tasks: ${tasks.map((task) => task.id).join(", ")}`);
  }

  afterAll(async () => {
    if (!selectedModel || runRecords.length === 0) return;
    for (const task of evalTasks) {
      const records = runRecords.filter((record) => record.taskId === task.id);
      if (records.length === 0) continue;
      const numbers = (key: string) => records.map((record) => record[key]).filter((value): value is number => typeof value === "number");
      const summary = {
        schemaVersion: 1,
        recordType: "task_summary",
        runId,
        recordedAt: new Date().toISOString(),
        revision,
        workingTreeDirty,
        model: selectedModel,
        taskId: task.id,
        attempts: records.length,
        passes: records.filter((record) => record.pass === true).length,
        passRate: records.filter((record) => record.pass === true).length / records.length,
        medianSteps: median(numbers("steps")),
        medianToolCalls: median(numbers("toolCalls")),
        medianInputTokens: median(numbers("inputTokens")),
        medianOutputTokens: median(numbers("outputTokens")),
        medianTotalTokens: median(numbers("totalTokens")),
        medianElapsedMs: median(numbers("elapsedMs")),
        estimatedUsage: records.some((record) => record.estimatedUsage === true),
      };
      await appendFile(metricsPath, `${JSON.stringify(summary)}\n`, "utf8");
      process.stdout.write(`[nah-eval-summary] ${JSON.stringify(summary)}\n`);
    }
  });

  it.each(evalTasks.flatMap((task) => Array.from({ length: repeatCount }, (_, index) => ({ task, repetition: index + 1 }))))(
    "$task.id repetition $repetition",
    async ({ task, repetition }) => {
      const workspace = await mkdtemp(path.join(tmpdir(), "nah-live-eval-"));
      const record: Record<string, unknown> = {
        schemaVersion: 1,
        runId,
        recordedAt: new Date().toISOString(),
        revision,
        workingTreeDirty,
        model: selectedModel,
        taskId: task.id,
        repetition,
        repetitions: repeatCount,
        pass: false,
        reason: "not_run",
        steps: 0,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedUsage: true,
        elapsedMs: 0,
        checkExitCode: null,
        checkOutput: "",
      };
      const startedAt = Date.now();
      try {
        for (const [file, contents] of Object.entries(task.seed)) await writeFile(path.join(workspace, file), contents);
        const model = await resolveModel(selectedModel);
        const run = runAgent({
          model: model.model,
          system: "You are a careful coding agent. Inspect existing code, make the requested change, and use tools to inspect your result. Be conservative and do not rewrite unrelated code.",
          prompt: task.prompt,
          tools: createCodingTools(createNodeEnvironment(workspace)),
          maxSteps: 12,
          compaction: "off",
        });
        const result = await run.result;
        record.reason = result.reason;
        record.steps = result.steps;
        record.toolCalls = toolCallCount(result.messages);
        record.inputTokens = result.usage.inputTokens;
        record.outputTokens = result.usage.outputTokens;
        record.totalTokens = result.usage.totalTokens;
        record.estimatedUsage = result.usage.estimated ?? false;

        await writeFile(path.join(workspace, "verify.mjs"), task.verify);
        const check = await createNodeEnvironment(workspace).exec("node verify.mjs", { timeoutSeconds: 15 });
        record.checkExitCode = check.exitCode;
        record.checkOutput = `${check.stdout}${check.stderr ? `\n${check.stderr}` : ""}`.trim().slice(-4000);
        record.pass = result.reason === "completed" && check.exitCode === 0;
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error);
      } finally {
        record.elapsedMs = Date.now() - startedAt;
        await mkdir(path.dirname(metricsPath), { recursive: true });
        await appendFile(metricsPath, `${JSON.stringify(record)}\n`, "utf8");
        runRecords.push(record);
        process.stdout.write(`[nah-eval] ${JSON.stringify(record)}\n`);
        await rm(workspace, { recursive: true, force: true });
      }
      expect(record.pass, `Evaluation failed; metrics appended to ${metricsPath}: ${JSON.stringify(record)}`).toBe(true);
    },
    180_000,
  );
});
