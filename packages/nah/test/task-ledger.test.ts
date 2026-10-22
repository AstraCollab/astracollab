import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createJsonlSessionStore } from "not-another-harness";
import { afterEach, describe, expect, it } from "vitest";
import { createTaskLedgerTool } from "../src/task-ledger.js";
import type { SessionState } from "../src/session.js";

describe("durable task ledger", () => {
  let directory = "";
  afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

  it("requires discovered commands and records real execution outcomes before completion", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "nah-task-ledger-"));
    const store = createJsonlSessionStore(path.join(directory, "session.jsonl"));
    const results = [
      { stdout: "type error", stderr: "", exitCode: 1 },
      { stdout: "typecheck passed", stderr: "", exitCode: 0 },
    ];
    const state = {
      taskLedger: null,
      discoveredChecks: [],
      activeFileChanges: null,
      store,
      workspace: {
        exists: async (file: string) => ["package.json", "pnpm-lock.yaml"].includes(file),
        readFile: async () => JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }),
        exec: async () => results.shift()!,
      },
    } as unknown as SessionState;
    const approvals: unknown[] = [];
    const ledgerTool = createTaskLedgerTool(state, async (name, input) => { approvals.push([name, input]); return true; }) as unknown as {
      execute: (input: unknown, context: unknown) => Promise<string>;
    };
    const invoke = (input: unknown) => ledgerTool.execute(input, {});

    const prematurePlan = await invoke({ action: "plan", goal: "Feature", steps: ["Implement"], checks: [{ description: "Typecheck", command: "CI=true pnpm run typecheck" }] });
    expect(prematurePlan).toContain("discover_checks");
    const found = await invoke({ action: "discover_checks" });
    expect(found).toContain("CI=true pnpm run typecheck");
    await invoke({ action: "plan", goal: "Feature", steps: ["Implement"], checks: [{ description: "Typecheck", command: "CI=true pnpm run typecheck" }] });
    expect(await invoke({ action: "status", status: "completed" })).toContain("Cannot complete task");

    const failed = await invoke({ action: "run_check", id: "1" });
    expect(failed).toContain("failed (exit 1");
    expect(state.taskLedger?.checks[0]?.status).toBe("failed");
    await invoke({ action: "step", id: "1", status: "completed" });
    expect(await invoke({ action: "status", status: "completed" })).toContain("1 acceptance check(s) remain");

    const passed = await invoke({ action: "run_check", id: "1" });
    expect(passed).toContain("passed (exit 0");
    await invoke({ action: "status", status: "completed" });
    expect(approvals).toHaveLength(2);
    expect((approvals[0] as [string])[0]).toBe("bash");

    const restored = await createJsonlSessionStore(path.join(directory, "session.jsonl")).loadTaskLedger();
    expect(restored?.status).toBe("completed");
    expect(restored?.steps.every((step) => step.status === "completed")).toBe(true);
    expect(restored?.checks[0]?.attempts.map((attempt) => attempt.exitCode)).toEqual([1, 0]);
  });

  it("validates the plan a model sent in the field", () => {
    /**
     * The plan that failed in the field: steps as `{step, status}` objects
     * instead of bare titles, and a command wrapped across two lines. The
     * provider rejected the whole thing as invalid input before the tool ran.
     */
    const sent = {
      action: "plan",
      goal:
        "Onboarding + multipage dashboard for Meadow: Effect-layered API (domain/ports/use-cases), wnstn.space address creation, devices + profile management, landing app router with onboarding wizard and dashboard pages.",
      steps: [
        { step: "1. Install architecture-patterns + error-handling-patterns skills (done)", status: "completed" },
        { step: "2. API domain layer: tagged errors, address value object, device label rules (pure)", status: "pending" },
        { step: "3. API application layer: AccountRepository port + Effect use cases", status: "pending" },
        { step: "4. API infrastructure: drizzle adapter for the port", status: "pending" },
        { step: "5. API http layer: router, error->status mapping, controllers for profile/devices/addresses", status: "pending" },
        { step: "6. API schema: email_address table + drizzle migration applied", status: "pending" },
        { step: "7. API config: mail domain (wnstn.space) + site url", status: "pending" },
        { step: "8. Landing: Effect-based http client + route table", status: "pending" },
        { step: "9. Landing: onboarding wizard (profile -> address -> done)", status: "pending" },
        { step: "10. Landing: dashboard shell + overview/addresses/devices/profile pages", status: "pending" },
        { step: "11. Verify: typecheck, lint, build, e2e API exercise against local Postgres", status: "pending" },
        { step: "12. Docs: account/dashboard/addresses + env vars", status: "pending" },
      ],
      checks: [
        { command: "pnpm\n --filter  check-types", description: "API typecheck passes" },
        { command: "pnpm\n --filter  check-types", description: "Landing typecheck passes" },
        { command: "CI=true pnpm run lint", description: "Repo lint passes" },
        { command: "pnpm\n --filter  build", description: "Landing builds" },
        { command: "git diff --check", description: "No whitespace errors" },
      ],
    };
    const state = { taskLedger: null, discoveredChecks: [], activeFileChanges: null, store: null, workspace: {} };
    const ledgerTool = createTaskLedgerTool(state as never, async () => true) as unknown as {
      inputSchema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } };
    };

    const result = ledgerTool.inputSchema.safeParse(sent);
    expect(result.success).toBe(true);
  });

  it("accepts the plan shapes a model actually sends", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "nah-task-ledger-"));
    const store = createJsonlSessionStore(path.join(directory, "session.jsonl"));
    const state = {
      taskLedger: null,
      discoveredChecks: [],
      activeFileChanges: null,
      store,
      workspace: {
        exists: async (file: string) => ["package.json", "pnpm-lock.yaml"].includes(file),
        readFile: async () => JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }),
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      },
    } as unknown as SessionState;
    const ledgerTool = createTaskLedgerTool(state, async () => true) as unknown as {
      inputSchema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } };
      execute: (input: unknown, context: unknown) => Promise<string>;
    };
    /**
     * The provider validates tool input against the schema before the tool
     * ever runs, so the shape a model sends is checked here the same way.
     */
    const parse = (input: unknown) => {
      const result = ledgerTool.inputSchema.safeParse(input);
      expect(result.success).toBe(true);
      return result.data;
    };

    await ledgerTool.execute(parse({ action: "discover_checks" }), {});
    const plan = await ledgerTool.execute(
      parse({
        action: "plan",
        goal: "Ship the dashboard",
        steps: [
          { step: "1. Install skills (done)", status: "completed" },
          { step: "2. API domain layer", status: "pending" },
        ],
        checks: [
          { cmd: "CI=true pnpm\n run typecheck", desc: "Typecheck passes" },
        ],
      }),
      {},
    );

    expect(plan).toContain("Task plan saved");
    expect(state.taskLedger?.steps.map((step) => step.title)).toEqual([
      "1. Install skills (done)",
      "2. API domain layer",
    ]);
    expect(state.taskLedger?.steps[0]?.status).toBe("completed");
    expect(state.taskLedger?.checks[0]).toMatchObject({
      description: "Typecheck passes",
      command: "CI=true pnpm run typecheck",
    });
  });

  it("lists the discovered commands when a check command is not one of them", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "nah-task-ledger-"));
    const state = {
      taskLedger: null,
      discoveredChecks: [],
      activeFileChanges: null,
      store: null,
      workspace: {
        exists: async (file: string) => ["package.json", "pnpm-lock.yaml"].includes(file),
        readFile: async () => JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }),
      },
    } as unknown as SessionState;
    const ledgerTool = createTaskLedgerTool(state, async () => true) as unknown as {
      execute: (input: unknown, context: unknown) => Promise<string>;
    };

    await ledgerTool.execute({ action: "discover_checks" }, {});
    const rejected = await ledgerTool.execute(
      {
        action: "plan",
        goal: "Ship the dashboard",
        steps: ["Implement"],
        checks: [{ description: "Typecheck", command: "pnpm --filter check-types" }],
      },
      {},
    );

    expect(rejected).toContain("must exactly match a discovered command");
    expect(rejected).toContain("pnpm --filter check-types");
    expect(rejected).toContain("- CI=true pnpm run typecheck");
    expect(state.taskLedger).toBeNull();
  });

  it("answers a status call that carries no status", async () => {
    /**
     * The call that failed in the field: `{"action":"status"}` and nothing
     * else. The schema asked for a status value, so the provider rejected the
     * call as invalid input before the tool ran — a question answered with a
     * type error.
     */
    directory = await mkdtemp(path.join(tmpdir(), "nah-task-ledger-"));
    const store = createJsonlSessionStore(path.join(directory, "session.jsonl"));
    const state = {
      taskLedger: null,
      discoveredChecks: [],
      activeFileChanges: null,
      store,
      workspace: {
        exists: async (file: string) => ["package.json", "pnpm-lock.yaml"].includes(file),
        readFile: async () => JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }),
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      },
    } as unknown as SessionState;
    const ledgerTool = createTaskLedgerTool(state, async () => true) as unknown as {
      inputSchema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } };
      execute: (input: unknown, context: unknown) => Promise<string>;
    };
    const parse = (input: unknown) => {
      const result = ledgerTool.inputSchema.safeParse(input);
      expect(result.success).toBe(true);
      return result.data;
    };

    await ledgerTool.execute(parse({ action: "discover_checks" }), {});
    await ledgerTool.execute(
      parse({
        action: "plan",
        goal: "Ship the dashboard",
        steps: ["Implement"],
        checks: [{ description: "Typecheck", command: "CI=true pnpm run typecheck" }],
      }),
      {},
    );

    const read = await ledgerTool.execute(parse({ action: "status" }), {});
    expect(read).toContain("Status: in_progress");
    expect(read).toContain("Implement");
    expect(state.taskLedger?.status).toBe("in_progress");

    const unknown = await ledgerTool.execute(parse({ action: "status", status: "nearly there" }), {});
    expect(unknown).toContain("unknown task status");
    expect(unknown).toContain("in_progress, blocked, completed");
    expect(state.taskLedger?.status).toBe("in_progress");
  });

  it("takes the status words a model reaches for", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "nah-task-ledger-"));
    const store = createJsonlSessionStore(path.join(directory, "session.jsonl"));
    const state = {
      taskLedger: null,
      discoveredChecks: [],
      activeFileChanges: null,
      store,
      workspace: {
        exists: async (file: string) => ["package.json", "pnpm-lock.yaml"].includes(file),
        readFile: async () => JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }),
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      },
    } as unknown as SessionState;
    const ledgerTool = createTaskLedgerTool(state, async () => true) as unknown as {
      inputSchema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } };
      execute: (input: unknown, context: unknown) => Promise<string>;
    };
    const parse = (input: unknown) => {
      const result = ledgerTool.inputSchema.safeParse(input);
      expect(result.success).toBe(true);
      return result.data;
    };

    await ledgerTool.execute(parse({ action: "discover_checks" }), {});
    await ledgerTool.execute(
      parse({
        action: "plan",
        goal: "Ship the dashboard",
        steps: ["Implement"],
        checks: [{ description: "Typecheck", command: "CI=true pnpm run typecheck" }],
      }),
      {},
    );

    await ledgerTool.execute(parse({ action: "step", id: "1", status: "done" }), {});
    expect(state.taskLedger?.steps[0]?.status).toBe("completed");
    await ledgerTool.execute(parse({ action: "run_check", id: "1" }), {});
    const done = await ledgerTool.execute(parse({ action: "status", status: "finished" }), {});
    expect(done).toContain("Status: completed");
    expect(state.taskLedger?.status).toBe("completed");
  });
});
