import { describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";

import { runAgent } from "../src/agent.js";
import { createNodeEnvironment } from "../src/node.js";
import { createCodingTools } from "../src/tools.js";
import { finishReason, v4Usage } from "./helpers/ai.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const bashStream = (id: string, command: string) =>
  simulateReadableStream<LanguageModelV4StreamPart>({
    chunkDelayInMs: 0,
    chunks: [
      {
        type: "tool-call",
        toolCallId: id,
        toolName: "bash",
        input: JSON.stringify({ command }),
      },
      {
        type: "finish",
        finishReason: finishReason("tool-calls"),
        usage: v4Usage({ input: 10, output: 1 }),
      },
    ],
  });

describe("bash tool cannot hang", () => {
  it("does not block on a command that reads stdin", async () => {
    const env = createNodeEnvironment(process.cwd());
    // `sed` with no file argument reads stdin. With an open, unwritten stdin pipe
    // this blocked until the timeout — two minutes at the default.
    const started = Date.now();
    const res = await env.exec("sed -n '1p'", { timeoutSeconds: 20 });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(3000);
    expect(res.stderr).not.toContain("timed out");
    expect(res.stdout).toBe("");
  }, 30000);

  it("does not block on `cat` with no arguments", async () => {
    const env = createNodeEnvironment(process.cwd());
    const started = Date.now();
    await env.exec("cat", { timeoutSeconds: 20 });
    expect(Date.now() - started).toBeLessThan(3000);
  }, 30000);

  it("still returns a result when the timeout fires", async () => {
    const env = createNodeEnvironment(process.cwd());
    const res = await env.exec("sleep 30", { timeoutSeconds: 1 });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("timed out");
  }, 30000);

  it("does not leave grandchildren running after a timeout", async () => {
    const env = createNodeEnvironment(process.cwd());
    const marker = `nah-orphan-${process.pid}-${Date.now()}`;
    const file = `${process.env.TMPDIR ?? "/tmp"}/${marker}`;
    // A grandchild that would outlive the shell if only the shell were killed.
    await env.exec(`(sleep 3; touch ${file}) & wait`, { timeoutSeconds: 1 });
    await sleep(4000);
    const { existsSync } = await import("node:fs");
    // Process-group kill means the backgrounded subshell died too.
    expect(existsSync(file)).toBe(false);
  }, 30000);

  it("refuses to start when the signal is already aborted", async () => {
    const env = createNodeEnvironment(process.cwd());
    const controller = new AbortController();
    controller.abort();
    const res = await env.exec("echo nope", { signal: controller.signal });
    expect(res.stdout).not.toContain("nope");
    expect(res.exitCode).toBe(130);
  });
});

describe("aborting interrupts a running tool", () => {
  it("stops a long command promptly instead of waiting it out", async () => {
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => ({ stream: bashStream(`c${call++}`, "sleep 30") }),
    });
    const controller = new AbortController();
    const run = runAgent({
      model,
      system: "s",
      prompt: "go",
      tools: createCodingTools(createNodeEnvironment(process.cwd())),
      abortSignal: controller.signal,
      maxSteps: 5,
    });
    const consumer = (async () => {
      for await (const _ of run.events) {
        // drain
      }
    })();

    await sleep(600); // let the tool start
    const abortedAt = Date.now();
    controller.abort();

    const outcome = await Promise.race([
      run.result,
      sleep(5000).then(() => "still-hanging" as const),
    ]);
    await consumer;

    expect(outcome).not.toBe("still-hanging");
    if (outcome !== "still-hanging") {
      expect(outcome.reason).toBe("aborted");
      // The decisive part: it did not wait out the 30s sleep.
      expect(Date.now() - abortedAt).toBeLessThan(3000);
    }
  }, 30000);

  it("run.interrupt() also reaches an executing tool", async () => {
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => ({ stream: bashStream(`c${call++}`, "sleep 30") }),
    });
    const run = runAgent({
      model,
      system: "s",
      prompt: "go",
      tools: createCodingTools(createNodeEnvironment(process.cwd())),
      maxSteps: 5,
    });
    const consumer = (async () => {
      for await (const _ of run.events) {
        // drain
      }
    })();

    await sleep(600);
    run.interrupt();

    const outcome = await Promise.race([run.result, sleep(5000).then(() => "still-hanging" as const)]);
    await consumer;

    expect(outcome).not.toBe("still-hanging");
    if (outcome !== "still-hanging") expect(outcome.reason).toBe("aborted");
  }, 30000);
});
