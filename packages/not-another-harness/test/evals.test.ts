import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV2 } from "ai/test";
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import { afterEach, describe, expect, it } from "vitest";
import { runAgent } from "../src/agent.js";
import { createNodeEnvironment } from "../src/node.js";
import { createCodingTools } from "../src/tools.js";

const usage = { inputTokens: 80, outputTokens: 16, totalTokens: 96 };
const call = (toolName: string, input: unknown, id: string): (() => ReturnType<typeof simulateReadableStream<LanguageModelV2StreamPart>>) =>
  () => simulateReadableStream<LanguageModelV2StreamPart>({ chunks: [
    { type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) },
    { type: "finish", finishReason: "tool-calls", usage },
  ] });
const answer = (text: string) => () => simulateReadableStream<LanguageModelV2StreamPart>({ chunks: [
  { type: "text-start", id: "answer" },
  { type: "text-delta", id: "answer", delta: text },
  { type: "text-end", id: "answer" },
  { type: "finish", finishReason: "stop", usage },
] });

const modelFor = (streams: Array<() => ReturnType<typeof simulateReadableStream<LanguageModelV2StreamPart>>>) => {
  let index = 0;
  return new MockLanguageModelV2({
    doStream: async () => ({ stream: streams[Math.min(index++, streams.length - 1)]!() }),
  });
};

describe("real-task harness evaluations", () => {
  let workspace = "";
  afterEach(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  it.each([
    {
      id: "targeted bug fix",
      seed: { "format.ts": "export const formatName = (name: string) => name.trim().toLowerCase();\n" },
      plan: [call("read", { path: "format.ts" }, "read"), call("edit", { path: "format.ts", old_string: "name.trim().toLowerCase()", new_string: "(name ?? '').trim().toLowerCase()" }, "edit"), answer("Handled missing names safely.")],
      check: async (root: string) => expect(await readFile(path.join(root, "format.ts"), "utf8")).toContain("name ?? ''"),
    },
    {
      id: "add a focused test fixture",
      seed: { "math.ts": "export const add = (a: number, b: number) => a + b;\n" },
      plan: [call("write", { path: "math.test.ts", content: "import { expect, it } from 'vitest';\nimport { add } from './math';\nit('adds negative values', () => expect(add(-2, 1)).toBe(-1));\n" }, "write"), answer("Added a negative-number regression test.")],
      check: async (root: string) => expect(await readFile(path.join(root, "math.test.ts"), "utf8")).toContain("add(-2, 1)"),
    },
    {
      id: "preserve surrounding code during refactor",
      seed: { "profile.ts": "export const display = (name: string) => name.trim();\nexport const role = 'member';\n" },
      plan: [call("read", { path: "profile.ts" }, "read"), call("edit", { path: "profile.ts", old_string: "name.trim()", new_string: "name.trim().replace(/\\s+/g, ' ')" }, "edit"), answer("Normalized repeated whitespace.")],
      check: async (root: string) => {
        const contents = await readFile(path.join(root, "profile.ts"), "utf8");
        expect(contents).toContain("replace(/\\s+/g, ' ')");
        expect(contents).toContain("export const role = 'member'");
      },
    },
  ])("$id", async ({ seed, plan, check }) => {
    workspace = await mkdtemp(path.join(tmpdir(), "nah-eval-"));
    for (const [file, contents] of Object.entries(seed)) await writeFile(path.join(workspace, file), contents);
    const run = runAgent({
      model: modelFor(plan),
      prompt: `Complete evaluation task: ${Object.keys(seed)[0]}`,
      system: "You are a coding agent. Use tools to make the requested change.",
      tools: createCodingTools(createNodeEnvironment(workspace)),
      compaction: "off",
    });
    const result = await run.result;
    await check(workspace);
    expect(result.reason).toBe("completed");
    expect(result.steps).toBe(plan.length);
    expect(result.usage.totalTokens).toBe(plan.length * usage.totalTokens);
  });
});
