import { describe, expect, it } from "vitest";

import type { Orchestrator } from "not-another-harness";

import { createDelegationTools } from "../src/delegation.js";
import { toolLabel } from "../src/render.js";
import { composeTurnRequest } from "../src/session.js";
import type { SessionState } from "../src/session.js";

const baseState = (over: Partial<SessionState> = {}): SessionState =>
  ({
    system: "base system",
    tools: {},
    messages: [],
    cwd: "/repo",
    workspace: null as never,
    activeFileChanges: null,
    activeShellCommands: null,
    undoHistory: [],
    sessionBasePath: null,
    taskLedger: null,
    discoveredChecks: [],
    store: null,
    model: null,
    providerStatus: null,
    totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    contextUsedTokens: 0,
    contextUsageEstimated: false,
    lastOutputTokens: 0,
    turns: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheHitRate: 0,
    spendUsd: 0,
    permissions: "yolo",
    ...over,
  }) as unknown as SessionState;

/** Delegation is registered without a sandbox, so a tool map is enough to say so. */
const withDelegation = (extra: Record<string, unknown> = {}) =>
  baseState({ tools: { delegate_task: {}, ...extra } as unknown as SessionState["tools"] });

describe("the read-only path is the one the model reaches for first", () => {
  it("names the explore tool before the editing ones", () => {
    // The gap this closes: the only delegate we had always spun a git worktree
    // and always implied editing. So "find where X does Y" — the step before any
    // code is written, and the most common one — had no cheap route, and a
    // worktree plus a diff for a question is overhead with nothing to show for
    // it. Claude Code's most-used subagent is exactly this shape for that reason.
    const { system } = composeTurnRequest(
      withDelegation({ delegate_tasks: {}, delegate_explore: {} }),
      "find where the auth check happens",
      "",
    );
    const explore = system.indexOf("delegate_explore");
    const single = system.indexOf("delegate_task ");
    const batch = system.indexOf("delegate_tasks are for children that actually change files");
    expect(explore).toBeGreaterThan(-1);
    expect(explore).toBeLessThan(single);
    expect(explore).toBeLessThan(batch);
  });

  it("tells the model explore cannot edit, and that it may verify by running", () => {
    const { system } = composeTurnRequest(
      withDelegation({ delegate_explore: {} }),
      "why is this slow",
      "",
    );
    // The restriction that survived measurement is the one on the editors. The
    // shell came back because a child that could not run anything cheerfully
    // reported a plausible cause it had never checked — and the parent then ran
    // the same commands itself to check, which is the context the delegation was
    // supposed to save.
    expect(system).toContain("no edit or write tool");
    expect(system).toContain("check its own answer");
    expect(system).toContain("depth quick");
  });

  it("points at the batch explore call when it is available", () => {
    // The gap this closes: delegate_explore's own description told the model it
    // could hand over several questions at once while offering no way to do it,
    // so a fan-out meant N sequential calls each waiting on the last.
    const { system } = composeTurnRequest(
      withDelegation({ delegate_explores: {} }),
      "trace where auth, billing, and sessions each check in",
      "",
    );
    expect(system).toContain("delegate_explores");
    expect(system).toContain("do not depend on each other");
  });

  it("labels an explore call as read-only in the transcript", () => {
    // "delegate in isolated worktree" on a tool that has no worktree is the kind
    // of detail that sends the next reader looking for a diff that does not exist.
    expect(toolLabel("delegate_explore", { title: "trace the loader" })).toBe(
      "explore read-only: trace the loader",
    );
  });

  it("marks which children in a batch explore were the cheap ones", () => {
    // The depth is the only thing that distinguishes a fan-out that was chosen
    // from one that was accidental, so the transcript has to carry it — otherwise
    // the cost of a call is only visible in the transcript after it is spent.
    expect(
      toolLabel("delegate_explores", {
        questions: [
          { title: "find the loader", depth: "quick" },
          { title: "trace every caller", depth: "thorough" },
        ],
      }),
    ).toBe("explore 2 questions: find the loader (quick), trace every caller");
  });
});

describe("the plan-to-sub-agents path is the one the model is told about", () => {
  it("points at the batch call, not just the single one", () => {
    // The gap this closes: a plan is several independent pieces, and delegating
    // them one call at a time means waiting for each child in turn — the fan-out
    // the orchestrator exists for would never happen on its own.
    const { system } = composeTurnRequest(withDelegation({ delegate_tasks: {} }), "implement the plan", "");
    expect(system).toContain("spin up sub-agents");
    expect(system).toContain("delegate_tasks");
    expect(system).toContain("delegate_task");
  });

  it("keeps the isolation constraints, and does not make them nah-local", () => {
    const { system } = composeTurnRequest(withDelegation(), "implement the plan", "");
    expect(system).toContain("committed");
    expect(system).toContain("merged automatically");
    expect(system).toContain("At most 3 children run at once");
  });

  it("tells the model to keep dependent work itself", () => {
    const { system } = composeTurnRequest(withDelegation(), "implement the plan", "");
    expect(system).toContain("depend on each other");
  });

  it("says nothing about delegation when the tools are not registered", () => {
    // A sandboxed session has no delegation tools, and telling the model about a
    // capability it cannot call is a plan it cannot follow.
    const { system } = composeTurnRequest(baseState(), "implement the plan", "");
    expect(system).not.toContain("delegate");
  });

  it("leaves the system half byte-identical across turns", () => {
    // The delegation guidance rides in the system prefix, so it has to be pure.
    const first = composeTurnRequest(withDelegation(), "one", "");
    const second = composeTurnRequest(withDelegation(), "two", "");
    expect(second.system).toBe(first.system);
  });
});

describe("a fan-out reads as one decision in the transcript", () => {
  it("leads with the count, because that is what the call was for", () => {
    const label = toolLabel("delegate_tasks", {
      tasks: [{ title: "extract parser" }, { title: "cover parser" }, { title: "rename export" }],
    });
    expect(label).toContain("delegate 3 subtasks in isolated worktrees");
    expect(label).toContain("extract parser");
  });

  it("does not crash on a malformed argument list", () => {
    expect(() => toolLabel("delegate_tasks", {})).not.toThrow();
    expect(() => toolLabel("delegate_tasks", { tasks: "nope" })).not.toThrow();
  });

  it("still labels a single delegation", () => {
    expect(toolLabel("delegate_task", { title: "extract parser" })).toBe("delegate in isolated worktree: extract parser");
  });
});

describe("an explore child hands back a bounded answer", () => {
  /** A child that found plenty and wrote all of it down, which is the case that used to fill the parent's window. */
  const verboseChild = (title: string) => ({
    title,
    status: "done" as const,
    steps: 4,
    toolCalls: 9,
    durationMs: 12,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimated: false },
    text: "FOUND-IT ".repeat(1_000),
  });

  const tools = (
    children: ReturnType<typeof verboseChild>[],
  ) =>
    createDelegationTools({
      orchestrator: {
        run: async (spec: { title: string }) => verboseChild(spec.title),
        runAll: async (specs: { title: string }[]) => specs.map((s) => verboseChild(s.title)),
      } as unknown as Orchestrator,
      approve: async () => true,
    });

  /** Just the answer text of each child, with headers, metrics and separators excluded. */
  const answers = (result: string): string[] =>
    result
      .split("Child report:")
      .slice(1)
      .map((chunk) => chunk.split("Delegated task:")[0]!.trim());

  it("caps a quick child's answer harder than a thorough one, since quick owes the reader less", async () => {
    const t = tools([]);
    const quick = await t.delegate_explore!.execute!({ title: "a", question: "q", depth: "quick" }, {} as never);
    const thorough = await t.delegate_explore!.execute!({ title: "a", question: "q", depth: "thorough" }, {} as never);
    expect(answers(String(quick))[0]!.length).toBeLessThan(answers(String(thorough))[0]!.length);
  });

  it("keeps the child's actual finding in what it hands back", async () => {
    const t = tools([]);
    const quick = await t.delegate_explore!.execute!({ title: "a", question: "q", depth: "quick" }, {} as never);
    expect(String(quick)).toContain("FOUND-IT");
  });

  it("caps at Anthropic's documented distilled return rather than a tighter guess of ours", async () => {
    const t = tools([]);
    const quick = await t.delegate_explore!.execute!({ title: "a", question: "q", depth: "quick" }, {} as never);
    const thorough = await t.delegate_explore!.execute!({ title: "a", question: "q", depth: "thorough" }, {} as never);
    // "often 1,000-2,000 tokens" of condensed summary, at ~4 chars/token. The
    // first cut of this was 1_200/2_500 — a token figure read as a character
    // figure, which ran ~3x tighter than the guidance and clipped answers the
    // guidance describes as normal. These exact values are the regression guard.
    expect(answers(String(quick))[0]!.length).toBe(4_000);
    expect(answers(String(thorough))[0]!.length).toBe(8_000);
  });

  it("tells the parent that declining is a correct outcome, not a failure to use the tool", () => {
    const t = tools([]);
    const description = String(t.delegate_explore!.description);
    // The description otherwise only ever argues FOR delegating. Measured on the
    // live eval that pushed the delegation rate from 52% to 100% — but that
    // fixture is a read-only sweep where delegating is always right, so 100%
    // there cannot distinguish good judgement from having removed the model's
    // exit. Without this the tool can only say yes.
    expect(description).toMatch(/declin/i);
    expect(description).toMatch(/scale/i);
  });

  it("caps each child in a fan-out at its own depth, not at the batch's widest", async () => {
    const t = tools([]);
    const mixed = String(
      await t.delegate_explores!.execute!(
        {
          questions: [
            { title: "quick", question: "q", depth: "quick" as const },
            { title: "thorough", question: "q", depth: "thorough" as const },
          ],
        },
        {} as never,
      ),
    );
    // Without positional caps the thorough sibling would lift the quick one's ceiling
    // too, and the batch would report two full-size answers for a task that owes one.
    const perChild = mixed.split("Child report:").slice(1).map((s) => s.length);
    expect(perChild[0]).toBeLessThan(perChild[1]!);
  });

  it("keeps a six-child fan-out proportional to the answers, not to the child's transcript", async () => {
    const t = tools([]);
    const one = String(await t.delegate_explore!.execute!({ title: "a", question: "q", depth: "thorough" }, {} as never));
    const six = String(
      await t.delegate_explores!.execute!(
        {
          questions: Array.from({ length: 6 }, (_, i) => ({ title: `q${i}`, question: "q", depth: "thorough" as const })),
        },
        {} as never,
      ),
    );
    // Six children each wrote a 9k-char report; the parent should see six capped
    // answers, not six transcripts. The child pays for the searching either way.
    // The ceiling is Anthropic's documented 1,000-2,000 token distilled return
    // (~4k/~8k chars), not a tighter guess of ours — see EXPLORE_REPORT_CHARS.
    const perChild = answers(six);
    expect(perChild).toHaveLength(6);
    for (const answer of perChild) expect(answer.length).toBeLessThanOrEqual(8_000);
    expect(answers(one)[0]!.length).toBe(8_000);
    expect(perChild.reduce((n, a) => n + a.length, 0)).toBe(6 * 8_000);
  });
});