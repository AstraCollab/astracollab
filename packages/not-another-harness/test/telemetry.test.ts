import { describe, expect, it } from "vitest";

import { memorySink, traceRun, type Span } from "../src/telemetry.js";
import type { HarnessEvent, HarnessUsage } from "../src/types.js";

/**
 * The recorder, driven by the event stream a real run produces.
 *
 * The two things worth protecting are the ones that are easy to get subtly wrong
 * and hard to notice: cost attribution per step (the stream reports cumulative
 * usage, so a naive reader bills every step for the whole run) and redaction
 * (spans carry prompts and tool arguments, which routinely contain credentials).
 */

const stream = (events: HarnessEvent[]): AsyncIterable<HarnessEvent> => {
  return (async function* generate() {
    for (const event of events) yield event;
  })();
};

const usage = (over: Partial<HarnessUsage> = {}): HarnessUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  ...over,
});

const step = (n: number, over: Partial<HarnessUsage> = {}, request = {}) =>
  ({
    type: "step-finish",
    step: n,
    usage: usage(over),
    request: { totalInputTokens: 1000, freshInputTokens: 900, cachedInputTokens: 100, ...request },
  }) as unknown as HarnessEvent;

/** A three-step run with a tool call in the first step. */
const run = (over: { spendUsd?: number } = {}): HarnessEvent[] => [
  { type: "run-start", stepBudget: null, tokenBudget: 400_000 } as HarnessEvent,
  { type: "step-start", step: 1 },
  { type: "tool-call", step: 1, toolCallId: "t1", toolName: "read", input: { path: "src/a.ts" } },
  { type: "tool-result", step: 1, toolCallId: "t1", toolName: "read", output: "file contents", isError: false },
  step(1, { inputTokens: 100, outputTokens: 20, totalTokens: 120 }, { totalInputTokens: 1000, freshInputTokens: 1000, cachedInputTokens: 0 }),
  { type: "step-start", step: 2 },
  step(2, { inputTokens: 250, outputTokens: 50, totalTokens: 300, cachedInputTokens: 600 }, { totalInputTokens: 1000, freshInputTokens: 400, cachedInputTokens: 600 }),
  { type: "step-start", step: 3 },
  step(3, { inputTokens: 450, outputTokens: 100, totalTokens: 550, cachedInputTokens: 1500 }, { totalInputTokens: 1000, freshInputTokens: 100, cachedInputTokens: 900 }),
  {
    type: "finish",
    reason: "completed",
    text: "done",
    usage: usage({
      inputTokens: 450,
      outputTokens: 100,
      totalTokens: 550,
      cachedInputTokens: 1500,
      spendUsd: over.spendUsd,
    }),
  } as HarnessEvent,
];

const byKind = (spans: Span[], kind: string): Span[] => spans.filter((span) => span.kind === kind);
const find = (spans: Span[], name: string): Span | undefined => spans.find((span) => span.name === name);

describe("span shape", () => {
  it("builds a root span with a model span and tool span under each step", async () => {
    const sink = memorySink();
    const trace = await traceRun({ sink }, stream(run()));

    expect(trace).not.toBeNull();
    expect(byKind(sink.spans, "agent")).toHaveLength(1);
    expect(byKind(sink.spans, "step")).toHaveLength(3);
    expect(byKind(sink.spans, "model")).toHaveLength(3);
    expect(byKind(sink.spans, "tool")).toHaveLength(1);

    // The waterfall has to nest: tool under step, step under run. A flat list is
    // a list of events, not a trace.
    const tool = find(sink.spans, "tool: read")!;
    const step1 = find(sink.spans, "step 1")!;
    expect(tool.parentId).toBe(step1.id);
    expect(step1.parentId).toBe(trace!.rootSpanId);
    expect(trace!.rootSpanId).not.toBe(tool.parentId);
  });

  it("gives every span the same trace id and a closed end time", async () => {
    const sink = memorySink();
    const trace = await traceRun({ sink }, stream(run()));
    for (const span of sink.spans) expect(span.traceId).toBe(trace!.id);
    for (const span of sink.spans) expect(span.endTime).not.toBeNull();
    expect(trace!.endTime).not.toBeNull();
  });

  it("names the root span from the context and keeps tags on it only", async () => {
    const sink = memorySink();
    const trace = await traceRun({ sink, tags: ["ci"] }, stream(run()), {
      rootSpanName: "eval case 3",
      input: "please fix the login bug",
      model: "openrouter:stealth/space-bunny-alpha",
    });

    expect(trace!.name).toBe("eval case 3");
    expect(trace!.tags).toEqual(["ci"]);
    const root = byKind(sink.spans, "agent")[0]!;
    expect(root.attributes["gen_ai.request.model"]).toBe("openrouter:stealth/space-bunny-alpha");
    expect(root.input).toBe("please fix the login bug");
  });
});

describe("cost attribution", () => {
  it("attributes each step its own usage, not the running total", async () => {
    // The stream reports cumulative usage. Step 3 is 200/50; if the recorder read
    // it directly, step 3 would appear to cost 450/100 and the sum would be
    // triple the real bill.
    const sink = memorySink();
    await traceRun({ sink }, stream(run()));

    const steps = byKind(sink.spans, "step");
    expect(steps.map((span) => [span.attributes["gen_ai.usage.input_tokens"], span.attributes["gen_ai.usage.output_tokens"]])).toEqual([
      [100, 20],
      [150, 30],
      [200, 50],
    ]);
  });

  it("records cache reads per step and the hit rate for the request", async () => {
    const sink = memorySink();
    await traceRun({ sink }, stream(run()));

    const steps = byKind(sink.spans, "step");
    // 600 of a 1000-token prompt was cached: the number worth watching.
    expect(steps[1]!.attributes["gen_ai.usage.cache_read_tokens"]).toBe(600);
    expect(steps[1]!.attributes["nah.request.cache_hit_rate"]).toBe(0.6);
    expect(steps[0]!.attributes["nah.request.cache_hit_rate"]).toBe(0);
  });

  it("puts total spend and the stop reason on the root only", async () => {
    const sink = memorySink();
    await traceRun({ sink }, stream(run({ spendUsd: 0.42 })));

    const root = byKind(sink.spans, "agent")[0]!;
    expect(root.attributes["nah.cost.usd"]).toBe(0.42);
    expect(root.attributes["nah.stop_reason"]).toBe("completed");
    expect(root.attributes["gen_ai.usage.input_tokens"]).toBe(450);
    // Per-step cost is not derivable without rates per step, and guessing would
    // put a wrong number on the most-looked-at number in the UI.
    expect(byKind(sink.spans, "step")[0]!.attributes["nah.cost.usd"]).toBeUndefined();
  });
});

describe("failure", () => {
  it("marks a tool span that reported an error in its result", async () => {
    const sink = memorySink();
    await traceRun(
      { sink },
      stream([
        { type: "step-start", step: 1 },
        { type: "tool-call", step: 1, toolCallId: "t1", toolName: "edit", input: {} },
        { type: "tool-result", step: 1, toolCallId: "t1", toolName: "edit", output: "ENOENT", isError: true },
        { type: "finish", reason: "completed", text: "gave up", usage: usage() },
      ]),
    );

    const tool = find(sink.spans, "tool: edit")!;
    expect(tool.status).toBe("error");
    expect(tool.attributes["nah.tool.error"]).toBe(true);
  });

  it("closes the root span when the run ends with an error", async () => {
    const sink = memorySink();
    const trace = await traceRun({ sink }, stream([{ type: "error", error: new Error("rate limited") } as HarnessEvent]));

    expect(trace!.status).toBe("error");
    expect(trace!.error?.message).toBe("rate limited");
    // An open root span would render as an agent still thinking.
    expect(trace!.endTime).not.toBeNull();
  });

  it("closes a run that stopped mid-stream with no finish event", async () => {
    const sink = memorySink();
    const trace = await traceRun(
      { sink },
      stream([{ type: "run-start", stepBudget: null, tokenBudget: 1 }, { type: "step-start", step: 1 }]),
    );
    expect(trace!.endTime).not.toBeNull();
    expect(byKind(sink.spans, "step")[0]!.endTime).not.toBeNull();
  });
});

describe("redaction and limits", () => {
  it("redacts credential-shaped keys in tool input and span input", async () => {
    // Spans are written to disk and read by anyone with the Studio open, and a
    // pasted key in a prompt is ordinary rather than exotic.
    const sink = memorySink();
    await traceRun(
      { sink },
      stream([
        { type: "step-start", step: 1 },
        {
          type: "tool-call",
          step: 1,
          toolCallId: "t1",
          toolName: "bash",
          input: { command: "curl -H 'auth' x", apiKey: "sk-live-abcdef", nested: { password: "hunter2" } },
        },
        { type: "tool-result", step: 1, toolCallId: "t1", toolName: "bash", output: "ok", isError: false },
        { type: "finish", reason: "completed", text: "done", usage: usage() },
      ]),
      { input: { userMessage: "here is my key sk-live-abcdef", token: "abc123" } },
    );

    const tool = find(sink.spans, "tool: bash")!;
    const input = tool.input as Record<string, unknown>;
    expect(input.apiKey).toBe("[redacted]");
    expect((input.nested as Record<string, unknown>).password).toBe("[redacted]");
    // The command itself is the useful part and must survive.
    expect(input.command).toContain("curl");
    expect(JSON.stringify(tool.input)).not.toContain("sk-live-abcdef");

    const root = byKind(sink.spans, "agent")[0]!;
    expect((root.input as Record<string, unknown>).token).toBe("[redacted]");
    expect((root.input as Record<string, unknown>).userMessage).toContain("sk-live-abcdef");
  });

  it("truncates a large payload instead of storing it whole", async () => {
    const sink = memorySink();
    await traceRun(
      { sink, limits: { maxStringLength: 20 } },
      stream([
        { type: "step-start", step: 1 },
        { type: "tool-call", step: 1, toolCallId: "t1", toolName: "read", input: { note: "x".repeat(500) } },
        { type: "tool-result", step: 1, toolCallId: "t1", toolName: "read", output: "y".repeat(500), isError: false },
        { type: "finish", reason: "completed", text: "done", usage: usage() },
      ]),
    );

    const tool = find(sink.spans, "tool: read")!;
    expect((tool.input as Record<string, unknown>).note).toContain("[500 chars]");
    expect((tool.output as string).length).toBeLessThan(60);
  });

  it("survives a cyclic tool argument", async () => {
    // Tool input is arbitrary objects from arbitrary code. A cycle here must not
    // take down the run that was merely being observed.
    const cyclic: Record<string, unknown> = { name: "a" };
    cyclic.self = cyclic;
    const sink = memorySink();
    const trace = await traceRun(
      { sink },
      stream([
        { type: "step-start", step: 1 },
        { type: "tool-call", step: 1, toolCallId: "t1", toolName: "weird", input: cyclic },
        { type: "tool-result", step: 1, toolCallId: "t1", toolName: "weird", output: "ok", isError: false },
        { type: "finish", reason: "completed", text: "done", usage: usage() },
      ]),
    );
    expect(trace).not.toBeNull();
    expect(JSON.stringify(find(sink.spans, "tool: weird")!.input)).toContain("circular");
  });

  it("can drop inputs and outputs entirely", async () => {
    const sink = memorySink();
    await traceRun(
      { sink, hideInput: true, hideOutput: true },
      stream([
        { type: "step-start", step: 1 },
        { type: "tool-call", step: 1, toolCallId: "t1", toolName: "read", input: { secretNote: "PII" } },
        { type: "tool-result", step: 1, toolCallId: "t1", toolName: "read", output: "user data", isError: false },
        { type: "finish", reason: "completed", text: "the answer", usage: usage() },
      ]),
      { input: "the question" },
    );

    expect(find(sink.spans, "tool: read")!.input).toBeUndefined();
    expect(find(sink.spans, "tool: read")!.output).toBeUndefined();
    // The timings still exist, so the trace is still worth keeping.
    expect(find(sink.spans, "tool: read")!.endTime).not.toBeNull();
  });
});

describe("sampling", () => {
  it("records nothing when sampling is off", async () => {
    const sink = memorySink();
    expect(await traceRun({ sink, sampling: { type: "never" } }, stream(run()))).toBeNull();
    expect(sink.spans).toHaveLength(0);
  });

  it("records nothing when sampling is off, even though the stream is read", async () => {
    const sink = memorySink();
    let pulled = 0;
    async function* counted(): AsyncIterable<HarnessEvent> {
      for (const event of run()) {
        pulled += 1;
        yield event;
      }
    }
    await traceRun({ sink, sampling: { type: "never" } }, counted());
    expect(pulled).toBe(0);
  });

  it("takes roughly the requested share at ratio sampling", async () => {
    const sink = memorySink();
    for (let index = 0; index < 200; index += 1) {
      await traceRun({ sink, sampling: { type: "ratio", probability: 0.25 } }, stream([{ type: "finish", reason: "completed", text: "", usage: usage() }]));
    }
    const kept = sink.spans.filter((span) => span.kind === "agent").length;
    // Hash-based, so this is deterministic across runs rather than a coin flip:
    // the assertion has to allow a band, not a point.
    expect(kept).toBeGreaterThan(30);
    expect(kept).toBeLessThan(70);
  });

  it("decides by trace id, so re-running the same trace samples the same way", async () => {
    const decisions: boolean[] = [];
    for (let index = 0; index < 2; index += 1) {
      const sink = memorySink();
      const trace = await traceRun(
        { sink, sampling: { type: "custom", sampler: ({ traceId }) => { decisions.push(traceId === "abc"); return traceId === "abc"; } } },
        stream([{ type: "finish", reason: "completed", text: "", usage: usage() }]),
      );
      expect(trace === null).toBe(decisions.at(-1) === false);
    }
  });

  it("keeps a caller-supplied trace id so an external trace can be joined", async () => {
    const sink = memorySink();
    const trace = await traceRun({ sink, traceId: "0af7651916cd43dd8448eb211c80319c" }, stream(run()));
    expect(trace!.id).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(sink.spans[0]!.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
  });
});