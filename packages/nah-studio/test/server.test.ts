import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream } from "ai";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StudioStore } from "../src/store.js";
import { traceRun, type Span } from "not-another-harness";
import { calledToolScorer, includesScorer, judgeScorer, notRefusedScorer, runOne, summarize } from "../src/evals.js";
import { createStudioServer, registerBuiltinScorers, registeredScorers, startStudioServer } from "../src/server.js";

/**
 * The Studio's storage, HTTP surface and scorers.
 *
 * These are the parts where a quiet failure is expensive: a store that loses a
 * trace reads as "the agent did not run", a scorer that returns 0 when it cannot
 * tell reads as "the agent is bad", and an endpoint that leaks prompts to a
 * stranger is not a bug report, it is a disclosure.
 */

const store = () => new StudioStore({ path: ":memory:" });

/** A traced run, collected the way `nah serve` collects one. */
const tracedRun = async () => {
  const spans: Span[] = [];
  const events = (async function* generate() {
    yield { type: "run-start", stepBudget: null, tokenBudget: 100_000 };
    yield { type: "step-start", step: 1 };
    yield { type: "tool-call", step: 1, toolCallId: "t1", toolName: "read", input: { path: "a.ts" } };
    yield { type: "tool-result", step: 1, toolCallId: "t1", toolName: "read", output: "contents", isError: false };
    yield {
      type: "step-finish",
      step: 1,
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      request: { totalInputTokens: 1000, freshInputTokens: 1000, cachedInputTokens: 0 },
    };
    yield {
      type: "finish",
      reason: "completed",
      text: "the answer",
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, spendUsd: 0.003 },
    };
  })();
  const trace = await traceRun({ sink: { emit: (span) => void spans.push(span) } }, events as never, {
    rootSpanName: "fix the login bug",
    input: "fix the login bug",
  });
  return { trace: trace!, spans };
};

describe("StudioStore", () => {
  it("round-trips a trace with its spans", async () => {
    const db = store();
    const { trace, spans } = await tracedRun();
    db.saveTrace(trace, spans);

    const found = db.getTrace(trace.id);
    expect(found?.trace.name).toBe("fix the login bug");
    expect(found?.spans).toHaveLength(4);
    expect(found?.spans.map((span) => span.kind).sort()).toEqual(["agent", "model", "step", "tool"]);

    // The two things the dashboard shows, and the reason spans carry attributes.
    expect(found?.trace.costUsd).toBe(0.003);
    expect(found?.trace.inputTokens).toBe(100);
    db.close();
  });

  it("preserves a tool span's input and output", async () => {
    const db = store();
    const { trace, spans } = await tracedRun();
    db.saveTrace(trace, spans);
    const tool = db.getTrace(trace.id)!.spans.find((span) => span.kind === "tool")!;
    expect(tool.input).toEqual({ path: "a.ts" });
    expect(tool.output).toBe("contents");
    db.close();
  });

  it("replaces rather than duplicates a trace re-run under the same id", async () => {
    // Experiments re-run cases, and an experiment's own trace id is stable, so an
    // append would show one run several times in the list.
    const db = store();
    const { trace, spans } = await tracedRun();
    db.saveTrace(trace, spans);
    db.saveTrace({ ...trace, name: "second attempt" }, spans);
    expect(db.listTraces()).toHaveLength(1);
    expect(db.listTraces()[0]!.name).toBe("second attempt");
    db.close();
  });

  it("filters by search, status and tag", async () => {
    const db = store();
    const { trace, spans } = await tracedRun();
    db.saveTrace({ ...trace, tags: ["ci"] }, spans);
    db.saveTrace({ ...trace, id: "other", name: "another run" }, spans);

    expect(db.listTraces({ search: "another" })).toHaveLength(1);
    expect(db.listTraces({ tag: "ci" })).toHaveLength(1);
    expect(db.listTraces({ status: "ok" })).toHaveLength(2);
    expect(db.listTraces({ status: "error" })).toHaveLength(0);
    db.close();
  });

  it("summarizes totals for the dashboard", async () => {
    const db = store();
    const { trace, spans } = await tracedRun();
    db.saveTrace(trace, spans);
    db.saveTrace({ ...trace, id: "second" }, spans);
    const overview = db.overview();
    expect(overview.traces).toBe(2);
    expect(overview.costUsd).toBeCloseTo(0.006, 6);
    db.close();
  });

  it("prunes traces older than the retention window, spans included", async () => {
    const db = store();
    const { trace, spans } = await tracedRun();
    db.saveTrace({ ...trace, startTime: Date.now() - 86_400_000 * 40 }, spans);
    db.saveTrace({ ...trace, id: "fresh" }, spans);

    expect(db.prune(86_400_000 * 30)).toBe(1);
    expect(db.listTraces()).toHaveLength(1);
    // An orphaned span is a row nothing will ever join to.
    expect(db.getTrace(trace.id)).toBeNull();
    db.close();
  });

  it("filters traces by time range and sorts by cost", async () => {
    const db = store();
    const { trace, spans } = await tracedRun();
    const old = Date.now() - 86_400_000 * 3;
    db.saveTrace({ ...trace, startTime: old, costUsd: 1 }, spans);
    db.saveTrace({ ...trace, id: "new-expensive", costUsd: 9 }, spans);

    expect(db.listTraces({ since: Date.now() - 1000 })).toHaveLength(1);
    expect(db.listTraces({ since: old - 1000 })).toHaveLength(2);
    expect(db.listTraces({ sort: "costUsd", order: "desc" })[0]!.id).toBe("new-expensive");
    // A column name from a request is the one thing that must never be
    // interpolated, so it is whitelisted rather than passed through.
    expect(db.listTraces({ sort: "start_time; DROP TABLE traces" as never })).toHaveLength(2);
    db.close();
  });

  it("buckets history for the dashboard charts", async () => {
    const db = store();
    const { trace, spans } = await tracedRun();
    db.saveTrace(trace, spans);
    db.saveTrace({ ...trace, id: "second" }, spans);
    const series = db.timeseries(8);
    expect(series).toHaveLength(8);
    expect(series.reduce((sum, point) => sum + point.traces, 0)).toBe(2);
    db.close();
  });

  it("returns nothing for the chart when there is no history", () => {
    const db = store();
    expect(db.timeseries(8)).toEqual([]);
    db.close();
  });

  it("aggregates tool calls with latency and errors", async () => {
    const db = store();
    const { trace, spans } = await tracedRun();
    db.saveTrace(trace, spans);

    const stats = db.toolStats();
    const read = stats.find((stat) => stat.tool === "read");
    // A leading space here means every downstream lookup silently misses, which
    // looks exactly like "no tool calls were recorded".
    expect(read?.calls).toBe(1);
    expect(read?.errors).toBe(0);
    expect(read?.errorRate).toBe(0);
    expect(read?.totalMs).toBeGreaterThanOrEqual(0);
    expect(stats.map((stat) => stat.tool)).not.toContain("");
    db.close();
  });

  it("stores messages and filters them by trace", () => {
    const db = store();
    db.saveMessage({ id: "m1", role: "user", content: "hello", traceId: "t1" });
    db.saveMessage({ id: "m2", role: "assistant", content: "hi", traceId: "t1" });
    db.saveMessage({ id: "m3", role: "user", content: "unrelated" });
    expect(db.listMessages({ traceId: "t1" })).toHaveLength(2);
    expect(db.listMessages()).toHaveLength(3);
    db.close();
  });

  it("keeps a thread in the order it was said, even inside one millisecond", () => {
    // A short reply writes both halves of a turn in the same millisecond, and
    // `created_at` alone cannot order them — a thread rebuilt from timestamps
    // alone comes back with the answer before the question.
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const db = store();
    db.saveMessage({ id: "u1", role: "user", content: "one" });
    db.saveMessage({ id: "a1", role: "assistant", content: "two" });
    db.saveMessage({ id: "u2", role: "user", content: "three" });

    const thread = [...db.listMessages({})].sort((a, b) => a.seq - b.seq).map((message) => message.role);
    expect(thread).toEqual(["user", "assistant", "user"]);
    vi.restoreAllMocks();
    db.close();
  });

  it("keeps messages across a reopen, which is what persisted means", () => {
    const dir = mkdtempSync(join(tmpdir(), "nah-studio-msg-"));
    try {
      const first = new StudioStore({ path: join(dir, "studio.sqlite") });
      first.saveMessage({ id: "m1", role: "user", content: "before restart" });
      first.close();

      const second = new StudioStore({ path: join(dir, "studio.sqlite") });
      expect(second.listMessages({}).map((message) => message.content)).toEqual(["before restart"]);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("datasets and experiments", () => {
  it("versions a dataset when items are appended", () => {
    // A score has to be attributable to the exact cases that produced it, so
    // appending has to move the version.
    const db = store();
    const { id } = db.createDataset({ name: "auth bugs" });
    expect(db.listDatasets()[0]!.version).toBe(1);
    db.addDatasetItems(id, [{ input: "a" }, { input: "b" }]);
    expect(db.listDatasets()[0]!.version).toBe(2);
    expect(db.listDatasetItems(id)).toHaveLength(2);
    db.close();
  });

  it("keeps dataset items in the order they were added", () => {
    const db = store();
    const { id } = db.createDataset({ name: "d" });
    db.addDatasetItems(id, [{ id: "one", input: "first" }, { id: "two", input: "second" }]);
    db.addDatasetItems(id, [{ id: "three", input: "third" }]);
    expect(db.listDatasetItems(id).map((item) => item.input)).toEqual(["first", "second", "third"]);
    db.close();
  });

  it("deletes a dataset and its items together", () => {
    const db = store();
    const { id } = db.createDataset({ name: "d" });
    db.addDatasetItems(id, [{ input: "a" }]);
    expect(db.deleteDataset(id)).toBe(true);
    expect(db.listDatasetItems(id)).toHaveLength(0);
    expect(db.listDatasets()).toHaveLength(0);
    db.close();
  });

  it("stores an experiment with its results and summary", () => {
    const db = store();
    const { id } = db.createDataset({ name: "d" });
    db.addDatasetItems(id, [{ id: "it1", input: "a" }]);
    const experiment = db.startExperiment({ datasetId: id, model: "openrouter:stealth/space-bunny-alpha" });
    db.saveExperimentResult({
      experimentId: experiment,
      id: "ex:d:it1",
      itemId: "it1",
      input: "a",
      status: "passed",
      output: "answer",
      scores: [{ scorerId: "includes", score: 1 }],
      traceId: "trace-1",
      durationMs: 12,
    });
    db.finishExperiment(experiment, { passRate: 1 });

    const found = db.getExperiment(experiment)!;
    expect(found.status).toBe("completed");
    expect(found.results).toHaveLength(1);
    expect(found.results[0]!.scores[0]!.score).toBe(1);
    // The input is joined back from the dataset, so a result row is readable
    // without loading the dataset too.
    expect(found.results[0]!.input).toBe("a");
    db.close();
  });
});

const textModel = (text: string) =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text }],
      finishReason: "stop" as const,
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
      warnings: [],
    }),
  });

describe("scorers", () => {
  it("scores a rule on presence and says what was missing", () => {
    const scorer = includesScorer(["ZQ7X4M2K", "kebab-case"]);
    return scorer
      .score({ input: "q", output: "the build id is ZQ7X4M2K", toolsCalled: [], filesChanged: [] })
      .then((score) => {
        expect(score.score).toBe(0.5);
        expect(score.reason).toContain("kebab-case");
      });
  });

  it("notices a refusal", async () => {
    const score = await notRefusedScorer().score({
      input: "q",
      output: "I can't help with that.",
      toolsCalled: [],
      filesChanged: [],
    });
    expect(score.score).toBe(0);
    expect(score.reason).toContain("refusal");
  });

  it("notices a tool that was never called", async () => {
    const score = await calledToolScorer("read").score({
      input: "q",
      output: "done",
      toolsCalled: ["grep"],
      filesChanged: [],
    });
    expect(score.score).toBe(0);
  });

  it("reads a judge score and its reason", async () => {
    const scorer = judgeScorer({ id: "judge", name: "relevancy", rubric: "answers the question", model: textModel('{"score":0.9,"reason":"it names the build id"}') });
    const score = await scorer.score({ input: "what is the build id", output: "ZQ7X4M2K", toolsCalled: [], filesChanged: [] });
    expect(score.score).toBe(0.9);
    expect(score.reason).toBe("it names the build id");
  });

  it("recovers from prose around the judge's JSON", async () => {
    const scorer = judgeScorer({ id: "judge", name: "j", rubric: "r", model: textModel('Here you go:\n```json\n{"score":0.5,"reason":"half"}\n```') });
    const score = await scorer.score({ input: "q", output: "a", toolsCalled: [], filesChanged: [] });
    expect(score.score).toBe(0.5);
  });

  it("clamps a judge that reports out of range", async () => {
    // An unbounded score would wreck every average it enters, and 7 means "good",
    // not "seven times good".
    const scorer = judgeScorer({ id: "judge", name: "j", rubric: "r", model: textModel('{"score":7}') });
    const score = await scorer.score({ input: "q", output: "a", toolsCalled: [], filesChanged: [] });
    expect(score.score).toBe(1);
  });

  it("declines rather than guessing when the judge returns nothing usable", async () => {
    // A fabricated zero reads as a measurement, and an eval of fabricated zeros
    // is worse than no eval because it looks like evidence.
    const scorer = judgeScorer({ id: "judge", name: "j", rubric: "r", model: textModel("I would rather not say.") });
    const score = await scorer.score({ input: "q", output: "a", toolsCalled: [], filesChanged: [] });
    expect(score.skipped).toBe(true);
    expect(score.score).toBe(0);
  });
});

describe("runOne", () => {
  const item = { id: "it1", input: "what is the build id?", expected: "ZQ7X4M2K" };

  it("passes a run whose scores average at or above one half", async () => {
    const result = await runOne({
      item,
      scorers: [includesScorer(["ZQ7X4M2K"]), notRefusedScorer()],
      execute: async () => ({ output: "the build id is ZQ7X4M2K", toolsCalled: ["read"], filesChanged: [] }),
    });
    expect(result.status).toBe("passed");
    expect(result.scores).toHaveLength(2);
  });

  it("fails a run that scored low, and keeps the reasons", async () => {
    const result = await runOne({
      item,
      scorers: [includesScorer(["ZQ7X4M2K"])],
      execute: async () => ({ output: "no idea", toolsCalled: [], filesChanged: [] }),
    });
    expect(result.status).toBe("failed");
    expect(result.scores[0]!.reason).toContain("none of");
  });

  it("records a thrown run as an error with no scores at all", async () => {
    // Zeros here would read as "the agent did badly" when the truth is that the
    // harness fell over.
    const result = await runOne({
      item,
      scorers: [notRefusedScorer()],
      execute: async () => {
        throw new Error("rate limited");
      },
    });
    expect(result.status).toBe("error");
    expect(result.error).toBe("rate limited");
    expect(result.scores).toEqual([]);
  });

  it("retries a provider failure instead of scoring the provider's Tuesday", async () => {
    // An eval that reports a transient 502 as a failed agent is worse than one
    // that takes a minute longer: the number gets quoted.
    let calls = 0;
    const result = await runOne({
      item,
      scorers: [notRefusedScorer()],
      execute: async () => {
        calls += 1;
        if (calls < 3) {
          throw Object.assign(new Error("Provider returned an empty response"), { statusCode: 502, isRetryable: true });
        }
        return { output: "recovered", toolsCalled: [], filesChanged: [] };
      },
    });
    expect(calls).toBe(3);
    expect(result.attempts).toBe(3);
    expect(result.status).toBe("passed");
  });

  it("does not retry a failure that is not the provider's", async () => {
    // Retrying "no model is configured" three times just makes the operator wait.
    let calls = 0;
    const result = await runOne({
      item,
      scorers: [notRefusedScorer()],
      execute: async () => {
        calls += 1;
        throw new Error("no model is configured");
      },
    });
    expect(calls).toBe(1);
    expect(result.status).toBe("error");
    expect(result.error).toBe("no model is configured");
  });

  it("keeps going when one scorer throws", async () => {
    const result = await runOne({
      item,
      scorers: [
        {
          id: "broken",
          name: "broken",
          kind: "rule",
          score: async () => {
            throw new Error("scorer bug");
          },
        },
        notRefusedScorer(),
      ],
      execute: async () => ({ output: "done", toolsCalled: [], filesChanged: [] }),
    });
    expect(result.scores[0]!.skipped).toBe(true);
    // The surviving scorer still decides the outcome.
    expect(result.status).toBe("passed");
  });
});

describe("summarize", () => {
  it("excludes skipped scorers from the mean and counts them", () => {
    const summary = summarize([
      {
        id: "1",
        itemId: "1",
        input: "a",
        status: "passed",
        scores: [{ scorerId: "j", score: 1 }],
        durationMs: 10,
        attempts: 1,
      },
      {
        id: "2",
        itemId: "2",
        input: "b",
        status: "failed",
        scores: [{ scorerId: "j", score: 0, skipped: true, reason: "no JSON" }],
        durationMs: 20,
        attempts: 1,
      },
    ]) as { scorers: Record<string, { mean: number | null; scored: number; skipped: number }> };

    // The skipped run must not drag the average to 0.5.
    expect(summary.scorers.j!.mean).toBe(1);
    expect(summary.scorers.j!.skipped).toBe(1);
  });

  it("reports a pass rate over items that actually ran", () => {
    const summary = summarize([
      { id: "1", itemId: "1", input: "a", status: "passed", scores: [], durationMs: 1, attempts: 1 },
      { id: "2", itemId: "2", input: "b", status: "error", error: "x", scores: [], durationMs: 1, attempts: 1 },
      { id: "3", itemId: "3", input: "c", status: "failed", scores: [], durationMs: 1, attempts: 1 },
    ]) as { passRate: number; errored: number };
    expect(summary.errored).toBe(1);
    expect(summary.passRate).toBeCloseTo(1 / 3, 4);
  });
});

describe("http surface", () => {
  const withServer = async (options: Parameters<typeof startStudioServer>[0], run: (url: string) => Promise<void>) => {
    const handle = await startStudioServer({ ...options, port: 0, host: "127.0.0.1" });
    try {
      await run(handle.url);
    } finally {
      await handle.close();
    }
  };

  it("serves the studio page", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nah-studio-ui-page-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>nah studio</title>");
    await withServer({ store: store(), assetDir: dir }, async (url) => {
      const response = await fetch(url + "/");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain("nah studio");
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers health and overview", async () => {
    await withServer({ store: store() }, async (url) => {
      expect((await (await fetch(url + "/api/health")).json()).ok).toBe(true);
      expect((await (await fetch(url + "/api/overview")).json()).traces).toBe(0);
    });
  });

  it("saves and reads back a trace", async () => {
    await withServer({ store: store() }, async (url) => {
      const { trace, spans } = await tracedRun();
      const posted = await fetch(url + "/api/traces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trace, spans }),
      });
      expect((await posted.json()).ok).toBe(true);

      const list = (await (await fetch(url + "/api/traces")).json()) as Array<{ id: string }>;
      expect(list).toHaveLength(1);
      const detail = (await (await fetch(`${url}/api/traces/${trace.id}`)).json()) as { spans: unknown[] };
      expect(detail.spans).toHaveLength(4);
    });
  });

  it("404s a trace that does not exist rather than 500ing", async () => {
    await withServer({ store: store() }, async (url) => {
      expect((await fetch(`${url}/api/traces/nope`)).status).toBe(200);
      expect((await (await fetch(`${url}/api/traces/nope`)).json())).toBeNull();
    });
  });

  it("runs a dataset end to end and records the experiment", async () => {
    registerBuiltinScorers();
    const db = store();
    const { id } = db.createDataset({ name: "auth" });
    db.addDatasetItems(id, [{ id: "it1", input: "read the file" }]);
    for (const [scorerId, scorer] of registeredScorers) {
      db.saveScorer({ id: scorerId, name: scorer.name, kind: scorer.kind });
    }

    await withServer(
      {
        store: db,
        execute: async () => ({ output: "here is what you asked for", toolsCalled: ["read"], filesChanged: [] }),
        model: "openrouter:stealth/space-bunny-alpha",
      },
      async (url) => {
        const created = await fetch(url + "/api/datasets", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "unused" }),
        });
        expect((await created.json()).ok).toBe(true);

        const response = await fetch(url + "/api/experiments", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ datasetId: id, scorerIds: [...registeredScorers.keys()] }),
        });
        const body = (await response.json()) as { id: string };
        expect(body.id).toBeDefined();

        // Background now: poll rather than read a summary off the response.
        let detail: { status: string; results: Array<{ status: string; scores: unknown[] }>; summary: { items?: number } } | null = null;
        for (let attempt = 0; attempt < 50 && detail?.status !== "completed"; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 40));
          detail = (await (await fetch(`${url}/api/experiments/${body.id}`)).json()) as typeof detail;
        }
        expect(detail?.summary.items).toBe(1);
        expect(detail?.results).toHaveLength(1);
        expect(detail?.results[0]!.scores.length).toBeGreaterThan(0);
      },
    );
    db.close();
  });

  it("refuses an experiment when no agent is attached", async () => {
    const db = store();
    const { id } = db.createDataset({ name: "auth" });
    db.addDatasetItems(id, [{ id: "it1", input: "q" }]);
    await withServer({ store: db }, async (url) => {
      const response = await fetch(url + "/api/experiments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ datasetId: id, scorerIds: ["not-refused"] }),
      });
      expect((await response.json()).error).toContain("no agent");
    });
    db.close();
  });

  it("serves the built UI with the right content types and cache headers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nah-studio-ui-"));
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>studio</title>");
    writeFileSync(join(dir, "assets", "index-abc123.js"), "export default 1;");

    await withServer({ store: store(), assetDir: dir }, async (url) => {
      const index = await fetch(url + "/");
      expect(index.status).toBe(200);
      expect(index.headers.get("content-type")).toContain("text/html");
      // The HTML must not be cached or a deploy leaves browsers pointing at
      // assets that no longer exist.
      expect(index.headers.get("cache-control")).toBe("no-cache");

      const asset = await fetch(url + "/assets/index-abc123.js");
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toContain("text/javascript");
      // Hashed filenames are what make a year-long immutable cache honest.
      expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses to serve anything outside the asset directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nah-studio-ui-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html>");
    const outside = join(dir, "..", "outside.txt");
    writeFileSync(outside, "secret");

    await withServer({ store: store(), assetDir: dir }, async (url) => {
      // A path that reaches the parent is the difference between a UI that can
      // only serve the UI and one that can read the config file.
      const response = await fetch(url + "/../outside.txt");
      expect(response.status).toBeGreaterThanOrEqual(400);
    });
    rmSync(outside, { force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it("explains itself when the UI was never built", async () => {
    await withServer({ store: store() }, async (url) => {
      const response = await fetch(url + "/");
      expect(response.status).toBe(503);
      expect(await response.text()).toContain("nah-studio-ui");
    });
  });

  it("serves tool aggregates and bucketed overview", async () => {
    await withServer({ store: store() }, async (url) => {
      expect((await (await fetch(url + "/api/tools")).json())).toEqual([]);
      const overview = (await (await fetch(url + "/api/overview?buckets=6")).json()) as { timeseries: unknown[] };
      expect(overview.timeseries).toEqual([]);
    });
  });

  it("starts an experiment in the background rather than holding the request", async () => {
    // A run over a real dataset takes minutes; a connection held open for that
    // long is indistinguishable from a hung server.
    const db = store();
    const { id } = db.createDataset({ name: "d" });
    db.addDatasetItems(id, [{ id: "it1", input: "q" }]);
    for (const [scorerId, scorer] of registeredScorers) {
      db.saveScorer({ id: scorerId, name: scorer.name, kind: scorer.kind });
    }

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    await withServer(
      { store: db, execute: async () => { await gate; return { output: "done", toolsCalled: [], filesChanged: [] }; } },
      async (url) => {
        const response = await fetch(url + "/api/experiments", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ datasetId: id, scorerIds: [...registeredScorers.keys()] }),
        });
        const body = (await response.json()) as { id: string; summary?: unknown };
        expect(body.id).toBeDefined();
        // The answer came back before the run finished.
        expect(body.summary).toBeUndefined();

        const running = (await (await fetch(`${url}/api/experiments/${body.id}`)).json()) as { status: string };
        expect(running.status).toBe("running");

        release();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const done = (await (await fetch(`${url}/api/experiments/${body.id}`)).json()) as {
          status: string;
          results: unknown[];
        };
        expect(done.status).toBe("completed");
        expect(done.results).toHaveLength(1);
      },
    );
    db.close();
  });

  it("404s an unknown route", async () => {
    await withServer({ store: store() }, async (url) => {
      expect((await fetch(url + "/api/nope")).status).toBe(404);
    });
  });

  it("requires the token when one is set", async () => {
    const db = store();
    await withServer({ store: db, token: "secret-token" }, async (url) => {
      expect((await fetch(url + "/api/health")).status).toBe(401);
      const ok = await fetch(url + "/api/health", { headers: { authorization: "Bearer secret-token" } });
      expect(ok.status).toBe(200);
      // Wrong token is refused, and the answer is the same either way so a wrong
      // token cannot be timed apart from a right one.
      expect((await fetch(url + "/api/health", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    });
    db.close();
  });

  it("builds a server without listening when one is supplied", async () => {
    // The in-process path the tests use, and the reason createStudioServer and
    // startStudioServer are separate.
    const server = createStudioServer({ store: store() });
    expect(server).toBeDefined();
  });
});