/**
 * Evaluations: run a dataset against the agent and score what comes back.
 *
 * The hard part of evaluating an agent is that its output is not a function of its
 * input, so a pass/fail assertion is either brittle or absent. Two mechanisms
 * here address that, and the second is the important one:
 *
 * 1. **Rule scorers** for things that are objectively true — the answer contains
 *    the build id it was given, the tool it needed was called, the file it was
 *    asked to change actually changed. Cheap, deterministic, and a diff between
 *    two runs means something changed.
 * 2. **A judge scorer** for everything else, where one model grades another. This
 *    is the only way to score "did it answer the question that was asked" without
 *    writing a parser, and its output is inherently noisy. So the judge sees the
 *    rubric, the question and the answer, and is asked for a score *and a reason*;
 *    a score with no reason is not reviewable, and an eval nobody trusts is
 *    worse than no eval because it looks like evidence.
 *
 * Runs are recorded with their dataset version, so a score can be traced back to
 * the exact cases that produced it.
 */
import { generateText, type LanguageModel } from "ai";

import type { ExperimentResult, ScoreRecord } from "./store.js";

export type ScoreContext = {
  input: string;
  expected?: string;
  output: string;
  /** Tool names the run called, in order. */
  toolsCalled: string[];
  /** Files the run wrote or edited, repo-relative. */
  filesChanged: string[];
  traceId?: string;
};

export type Scorer = {
  id: string;
  name: string;
  description?: string;
  /** `rule` needs no model; `judge` needs one. */
  kind: "rule" | "judge";
  score(context: ScoreContext): Promise<ScoreRecord>;
};

/**
 * The one rule worth having by default.
 *
 * Declined rather than zero when the scorer cannot tell, because a scorer that
 * returns 0 for "I don't know" drags an average down with numbers that mean
 * nothing, and the average is the number people quote.
 */
export const includesScorer = (needles: string[], id = "includes"): Scorer => ({
  id,
  name: `includes: ${needles.join(", ")}`,
  description: "The answer states the value the question supplied.",
  kind: "rule",
  async score({ output }) {
    const lower = output.toLowerCase();
    const hits = needles.filter((needle) => lower.includes(needle.toLowerCase()));
    if (hits.length === 0) {
      return { scorerId: id, score: 0, reason: `none of ${needles.join(", ")} appear in the answer` };
    }
    return {
      scorerId: id,
      score: hits.length / needles.length,
      reason: `found ${hits.join(", ")}${hits.length < needles.length ? `, missing ${needles.filter((n) => !hits.includes(n)).join(", ")}` : ""}`,
    };
  },
});

export const calledToolScorer = (toolName: string, id = `called-tool:${toolName}`): Scorer => ({
  id,
  name: `called tool: ${toolName}`,
  description: "The agent used the tool the task required.",
  kind: "rule",
  async score({ toolsCalled }) {
    const count = toolsCalled.filter((name) => name === toolName).length;
    return {
      scorerId: id,
      score: count > 0 ? 1 : 0,
      reason: count > 0 ? `called ${toolName} ${count} time(s)` : `never called ${toolName}`,
    };
  },
});

export const mentionsFileScorer = (file: string, id = `touched:${file}`): Scorer => ({
  id,
  name: `changed file: ${file}`,
  description: "The run edited the file the task named.",
  kind: "rule",
  async score({ filesChanged }) {
    const touched = filesChanged.some((path) => path === file || path.endsWith(`/${file}`));
    return { scorerId: id, score: touched ? 1 : 0, reason: touched ? `changed ${file}` : `never changed ${file}` };
  },
});

/** Refuses to score a refusal, which is often the correct answer. */
export const notRefusedScorer = (id = "not-refused"): Scorer => ({
  id,
  name: "did not refuse",
  description: "The agent attempted the task rather than declining it.",
  kind: "rule",
  async score({ output }) {
    const refusal = /\b(i (can'?t|cannot|am unable to|won'?t)|i'?m not able to|as an ai)\b/i.test(output);
    return {
      scorerId: id,
      score: refusal ? 0 : 1,
      reason: refusal ? "the answer reads as a refusal" : "the agent attempted the task",
    };
  },
});

export const JUDGE_SYSTEM = `You score one answer to one question against a rubric.

Reply with a single JSON object and nothing else:
{"score": <number between 0 and 1>, "reason": "<one or two sentences, citing the specific part of the answer that decided it>"}`;

const judgeInstruction = (rubric: string) => `Rubric:
${rubric}

Score how well the ANSWER satisfies the rubric, given the QUESTION. Judge only the answer: do not reward length, confidence, or effort. An answer that declines when it should have acted scores 0, and so does one that claims work it did not do. If the answer is right but for a different reason than the rubric expects, give it partial credit rather than 0 or 1. No prose, no code fences.`;

/**
 * A model grading another model.
 *
 * Deliberately plain `generateText` with JSON recovery rather than
 * `generateObject`, for the same reason the memory extractor is: models without
 * structured-output support throw `AI_NoObjectGeneratedError`, and a judge that
 * silently fails every time is a score column full of zeros that reads as "the
 * agent is bad at this".
 */
export const judgeScorer = (options: {
  id: string;
  name: string;
  rubric: string;
  model: LanguageModel;
  maxOutputTokens?: number;
}): Scorer => ({
  id: options.id,
  name: options.name,
  description: options.rubric,
  kind: "judge",
  async score({ input, output }) {
    const result = await generateText({
      model: options.model,
      system: JUDGE_SYSTEM,
      prompt: [
        "<question>",
        input,
        "</question>",
        "<answer>",
        output,
        "</answer>",
      ].join("\n"),
      maxOutputTokens: options.maxOutputTokens ?? 400,
    });

    const slice = (() => {
      const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(result.text)?.[1] ?? result.text;
      const start = fenced.indexOf("{");
      if (start < 0) return null;
      let depth = 0;
      let inString = false;
      for (let index = start; index < fenced.length; index += 1) {
        const char = fenced[index]!;
        if (inString) {
          if (char === "\\") index += 1;
          else if (char === '"') inString = false;
          continue;
        }
        if (char === '"') inString = true;
        else if (char === "{") depth += 1;
        else if (char === "}") {
          depth -= 1;
          if (depth === 0) return fenced.slice(start, index + 1);
        }
      }
      return null;
    })();

    if (!slice) {
      // No score rather than a zero. A fabricated 0 reads as a real measurement.
      return { scorerId: options.id, score: 0, skipped: true, reason: "the judge did not return usable JSON" };
    }
    try {
      const parsed = JSON.parse(slice) as { score?: unknown; reason?: unknown };
      const raw = typeof parsed.score === "number" ? parsed.score : Number(parsed.score);
      if (!Number.isFinite(raw)) {
        return { scorerId: options.id, score: 0, skipped: true, reason: "the judge returned no numeric score" };
      }
      return {
        scorerId: options.id,
        // Clamped, because a judge that says 7 is reporting a feeling, and an
        // unbounded value would silently wreck every average it enters.
        score: Math.min(1, Math.max(0, raw)),
        reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      };
    } catch {
      return { scorerId: options.id, score: 0, skipped: true, reason: "the judge's reply was not valid JSON" };
    }
  },
});

export type RunOneInput = {
  id: string;
  input: string;
  expected?: string;
};

/** Attempts per item before it is reported as errored. */
const ITEM_ATTEMPTS = 3;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether a failure looks like the provider rather than the agent. */
const isTransient = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { isRetryable?: unknown; statusCode?: unknown; name?: unknown };
  if (candidate.isRetryable === true) return true;
  // 429, 502, 503, 504 are the provider telling us to come back, not that the
  // agent did badly.
  const status = Number(candidate.statusCode);
  return status === 429 || status === 502 || status === 503 || status === 504;
};

/**
 * Run one dataset item and score it.
 *
 * `execute` is supplied by the caller rather than assumed, so the same engine
 * serves both the CLI (which drives a real session) and a test (which drives a
 * stub) without a branch here.
 *
 * Retried on a provider-level failure. An eval that reports a transient 502 as a
 * failed agent is worse than one that takes a minute longer: the number gets
 * quoted, and it is measuring the provider's Tuesday.
 */
export const runOne = async (options: {
  item: RunOneInput;
  scorers: Scorer[];
  execute: (input: RunOneInput) => Promise<{ output: string; toolsCalled: string[]; filesChanged: string[]; traceId?: string }>;
}): Promise<ExperimentResult> => {
  const started = Date.now();
  let attempts = 0;
  let produced: Awaited<ReturnType<typeof options.execute>> | undefined;
  let lastError: unknown;
  for (;;) {
    attempts += 1;
    try {
      produced = await options.execute(options.item);
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      // Only the last attempt's message is kept: three stacked provider errors
      // would bury the one that explains the failure.
      if (attempts >= ITEM_ATTEMPTS || !isTransient(error)) break;
      await wait(500 * 2 ** (attempts - 1));
    }
  }

  if (lastError !== undefined) {
    return {
      id: options.item.id,
      itemId: options.item.id,
      input: options.item.input,
      status: "error",
      error: lastError instanceof Error ? lastError.message : String(lastError),
      attempts,
      // An errored run is not scored. Zeros here would read as "the agent did
      // badly" when the truth is "the harness fell over".
      scores: [],
      durationMs: Date.now() - started,
    };
  }

  if (!produced) throw new Error("unreachable: a run that did not throw must have produced output");
  const context: ScoreContext = {
    input: options.item.input,
    ...(options.item.expected === undefined ? {} : { expected: options.item.expected }),
    output: produced.output,
    toolsCalled: produced.toolsCalled,
    filesChanged: produced.filesChanged,
    ...(produced.traceId === undefined ? {} : { traceId: produced.traceId }),
  };

  const scores: ScoreRecord[] = [];
  for (const scorer of options.scorers) {
    try {
      scores.push(await scorer.score(context));
    } catch (error) {
      scores.push({
        scorerId: scorer.id,
        score: 0,
        skipped: true,
        reason: `scorer threw: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const usable = scores.filter((score) => !score.skipped);
  const mean = usable.length === 0 ? 0 : usable.reduce((sum, score) => sum + score.score, 0) / usable.length;
  // Below 0.5 is "failed" rather than "scored low", because a half-credit average
  // is not a thing anyone acts on.
  const status = usable.length === 0 ? "failed" : mean >= 0.5 ? "passed" : "failed";

  return {
    id: options.item.id,
    itemId: options.item.id,
    input: options.item.input,
    status,
    output: produced.output,
    scores,
    attempts,
    ...(produced.traceId === undefined ? {} : { traceId: produced.traceId }),
    durationMs: Date.now() - started,
  };
};

/**
 * Aggregate scores into the shape a comparison needs.
 *
 * Skipped scorers are excluded from the mean, and counted separately, so a judge
 * that failed to answer does not look like a judge that scored badly.
 */
export const summarize = (results: ExperimentResult[]): Record<string, unknown> => {
  const byScorer = new Map<string, { total: number; count: number; skipped: number; reasons: string[] }>();
  let passed = 0;
  let errored = 0;
  let durationMs = 0;

  for (const result of results) {
    if (result.status === "passed") passed += 1;
    if (result.status === "error") errored += 1;
    durationMs += result.durationMs;
    for (const score of result.scores) {
      const entry = byScorer.get(score.scorerId) ?? { total: 0, count: 0, skipped: 0, reasons: [] };
      if (score.skipped) entry.skipped += 1;
      else {
        entry.total += score.score;
        entry.count += 1;
      }
      if (score.reason) entry.reasons.push(score.reason);
      byScorer.set(score.scorerId, entry);
    }
  }

  return {
    items: results.length,
    passed,
    failed: results.length - passed - errored,
    errored,
    passRate: results.length === 0 ? 0 : Number((passed / results.length).toFixed(4)),
    durationMs,
    scorers: Object.fromEntries(
      [...byScorer].map(([id, entry]) => [
        id,
        {
          mean: entry.count === 0 ? null : Number((entry.total / entry.count).toFixed(4)),
          scored: entry.count,
          skipped: entry.skipped,
          // A couple of reasons, so the number can be argued with.
          reasons: entry.reasons.slice(0, 3),
        },
      ]),
    ),
  };
};