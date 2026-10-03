import { describe, expect, it } from "vitest";

import { logImplementTurn, resolveImplementStepCap, resolveStepCap, turnLogEnabled } from "../src/turn-log.js";
import { withExtraTools } from "../src/tools.js";
import { buildCodingTools } from "../src/coding-agent.js";

/**
 * Turn logging, step ceilings, and the tool-map seam.
 *
 * The ceilings and the log are ports of client behaviour. `withExtraTools` is the
 * seam the two inline client tools need: they stay in the client repo because they
 * depend on the code index, pgvector and the codebase-profile schema, and only the
 * registration has to change.
 */

const env = (values: Record<string, string>) => values;

describe("resolveStepCap", () => {
  it("falls back when unset", () => {
    expect(resolveStepCap({ env: env({}), fallback: 60 })).toBe(60);
  });

  it("clamps to a deliberate range rather than trusting the value", () => {
    expect(resolveStepCap({ env: env({ CODING_AGENT_MAX_STEPS: "2" }) })).toBe(8);
    expect(resolveStepCap({ env: env({ CODING_AGENT_MAX_STEPS: "9999" }) })).toBe(120);
    expect(resolveStepCap({ env: env({ CODING_AGENT_MAX_STEPS: "25" }) })).toBe(25);
  });

  it("treats a typo as unset rather than as unbounded", () => {
    // The failure this avoids: `Number("abc")` is NaN and a run with no ceiling
    // looks exactly like a run that is simply still going.
    expect(resolveStepCap({ env: env({ CODING_AGENT_MAX_STEPS: "abc" }), fallback: 60 })).toBe(60);
    expect(resolveStepCap({ env: env({ CODING_AGENT_MAX_STEPS: "Infinity" }), fallback: 60 })).toBe(60);
    expect(resolveStepCap({ env: env({ CODING_AGENT_MAX_STEPS: "" }), fallback: 60 })).toBe(60);
  });

  it("honours a custom variable and bounds", () => {
    expect(resolveStepCap({ env: env({ OTHER: "30" }), variable: "OTHER" })).toBe(30);
    expect(resolveStepCap({ env: env({ OTHER: "30" }), variable: "OTHER", max: 20 })).toBe(20);
  });
});

describe("resolveImplementStepCap", () => {
  it("lowers the ceiling when the turn opens with a profile", () => {
    // The preamble has already done the orientation work steps would otherwise
    // spend on it.
    expect(resolveImplementStepCap({ hasProfilePreamble: true, env: env({ CODING_AGENT_MAX_STEPS: "80" }) })).toBe(20);
    expect(resolveImplementStepCap({ hasProfilePreamble: false, env: env({ CODING_AGENT_MAX_STEPS: "80" }) })).toBe(80);
  });

  it("does not raise a ceiling the operator lowered", () => {
    expect(resolveImplementStepCap({ hasProfilePreamble: true, env: env({ CODING_AGENT_MAX_STEPS: "10" }) })).toBe(10);
  });
});

describe("turnLogEnabled", () => {
  it("is off unless asked for", () => {
    expect(turnLogEnabled(env({}))).toBe(false);
    expect(turnLogEnabled(env({ CODING_AGENT_TELEMETRY_LOG: "0" }))).toBe(false);
    expect(turnLogEnabled(env({ CODING_AGENT_TELEMETRY_LOG: "true" }))).toBe(true);
    expect(turnLogEnabled(env({ CODING_AGENT_TELEMETRY_LOG: "ON" }))).toBe(true);
  });
});

describe("logImplementTurn", () => {
  const result = {
    text: "All done.",
    reason: "completed",
    steps: 3,
    messages: [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "t1", toolName: "read", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", toolName: "read", output: "a" }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "t2", toolName: "bash", input: { command: "pnpm test" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "t2", toolName: "bash", output: "ok" }] },
    ],
    usage: { inputTokens: 900, outputTokens: 120, totalTokens: 1020, cachedInputTokens: 400, spendUsd: 0.02 },
  } as never;

  it("says nothing unless it is switched on", () => {
    const lines: unknown[] = [];
    logImplementTurn({ workflow: "w", mode: "implement", result, sink: (l) => lines.push(l) });
    expect(lines).toHaveLength(0);
  });

  it("reports the figures the harness already computed", () => {
    const lines: Array<[string, Record<string, unknown>]> = [];
    logImplementTurn({
      workflow: "agent-ticket-pr",
      mode: "implement",
      result,
      enabled: true,
      durationMs: 4200,
      sink: (line, detail) => lines.push([line, detail as Record<string, unknown>]),
    });

    const [line, detail] = lines[0]!;
    expect(line).toBe("[coding-agent] implement turn");
    expect(detail).toMatchObject({
      workflow: "agent-ticket-pr",
      reason: "completed",
      steps: 3,
      durationMs: 4200,
      tools: ["read", "bash"],
      // The count, not the commands themselves: the commands are in the trace.
      commandCount: 1,
      inputTokens: 900,
      outputTokens: 120,
      cachedInputTokens: 400,
      spendUsd: 0.02,
    });
    expect(detail.summaryChars).toBe("All done.".length);
  });
});

describe("the tool-map seam", () => {
  const envStub = {
    readFile: async () => "",
    writeFile: async () => {},
    exists: async () => false,
    readdir: async () => [],
    grep: async () => "",
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  } as never;

  const clientTool = { description: "a client tool", execute: async () => "ran" } as never;

  it("keeps the harness tools and adds the client's", () => {
    const tools = withExtraTools(buildCodingTools({ environment: envStub, approve: async () => true }), {
      codebase_semantic_search: clientTool,
      write_codebase_profile: clientTool,
    });
    expect(Object.keys(tools)).toContain("read");
    expect(Object.keys(tools)).toContain("bash");
    expect(Object.keys(tools)).toContain("codebase_semantic_search");
    expect(Object.keys(tools)).toContain("write_codebase_profile");
  });

  it("lets a client tool override a harness tool of the same name", () => {
    // The escape hatch matters: a workspace with a different `list` or a
    // repo-specific `grep` should not need the harness changed. The key stays —
    // what changes is which tool is behind it.
    const replacement = { description: "client list", execute: async () => "ran" } as never;
    const tools = withExtraTools(buildCodingTools({ environment: envStub, approve: async () => true }), {
      list: replacement,
    });
    expect((tools.list as { description: string }).description).toBe("client list");
    expect(Object.keys(tools)).toContain("read");
  });

  it("sanitises a client tool too", () => {
    // Otherwise the sanitisers would protect the harness's tools and quietly skip
    // the two that matter most for this client.
    const tools = withExtraTools(
      buildCodingTools({ environment: envStub, approve: async () => true }),
      { read_file: clientTool },
    );
    expect(tools.read_file).toBeDefined();
  });
});