import { describe, expect, it, vi } from "vitest";
import {
  createBoatSandboxRuntime,
  __testing,
  type BoatCommandApi,
} from "./boat-sandbox-runtime.js";

const ROOT = "/home/user/repo";

/** A command API that records the request it was given. */
const makeApi = (
  result: Partial<Awaited<ReturnType<BoatCommandApi["executeCommand"]>>> = {},
): { api: BoatCommandApi; calls: Parameters<BoatCommandApi["executeCommand"]>[0][] } => {
  const calls: Parameters<BoatCommandApi["executeCommand"]>[0][] = [];
  const api: BoatCommandApi = {
    executeCommand: vi.fn(async (request) => {
      calls.push(request);
      return { success: true, exitCode: 0, stdout: "", ...result };
    }),
  };
  return { api, calls };
};

describe("toBoatTimeoutSeconds", () => {
  it("converts milliseconds to seconds, rounding up", () => {
    expect(__testing.toBoatTimeoutSeconds(30_000)).toBe(30);
    expect(__testing.toBoatTimeoutSeconds(1_500)).toBe(2);
  });

  it("clamps to Boat's 600s synchronous cap", () => {
    expect(__testing.toBoatTimeoutSeconds(10 * 60 * 60 * 1000)).toBe(600);
  });

  it("falls back to the default for absent or nonsensical timeouts", () => {
    // 0 would otherwise mean "expire immediately" at the provider.
    expect(__testing.toBoatTimeoutSeconds(0)).toBe(60);
    expect(__testing.toBoatTimeoutSeconds(-5)).toBe(60);
    expect(__testing.toBoatTimeoutSeconds(undefined)).toBe(60);
  });
});

describe("normalizeExitCode", () => {
  it("prefers an explicit code", () => {
    expect(__testing.normalizeExitCode({ exitCode: 3, success: true })).toBe(3);
  });

  it("derives from success when no code is given", () => {
    expect(__testing.normalizeExitCode({ success: false })).toBe(1);
    expect(__testing.normalizeExitCode({ success: true })).toBe(0);
    expect(__testing.normalizeExitCode({})).toBe(0);
  });
});

describe("createBoatSandboxRuntime", () => {
  it("sends the sandbox id, command and args", async () => {
    const { api, calls } = makeApi();
    const runtime = createBoatSandboxRuntime({
      getApi: () => api,
      getSandboxId: () => "sb-1",
      repoRoot: ROOT,
    });

    await runtime.executeCommand!("git", ["status"]);

    expect(calls[0]).toMatchObject({ sandboxId: "sb-1", command: "git", args: ["status"] });
  });

  it("falls back to `result` when the provider returns no `stdout`", async () => {
    const { api } = makeApi({ stdout: undefined, result: "combined output" });
    const runtime = createBoatSandboxRuntime({
      getApi: () => api,
      getSandboxId: () => "sb-1",
      repoRoot: ROOT,
    });

    const result = await runtime.executeCommand!("bash", ["-lc", "echo hi"]);
    expect(result.stdout).toBe("combined output");
  });

  it("reports a non-zero exit rather than throwing", async () => {
    const { api } = makeApi({ success: false, exitCode: 2, stderr: "boom" });
    const runtime = createBoatSandboxRuntime({
      getApi: () => api,
      getSandboxId: () => "sb-1",
      repoRoot: ROOT,
    });

    const result = await runtime.executeCommand!("false", []);
    expect(result).toMatchObject({ success: false, exitCode: 2, stderr: "boom" });
  });

  it("uses defaultCwd only when the caller omits one", async () => {
    const { api, calls } = makeApi();
    const runtime = createBoatSandboxRuntime({
      getApi: () => api,
      getSandboxId: () => "sb-1",
      repoRoot: ROOT,
      defaultCwd: ROOT,
    });

    await runtime.executeCommand!("ls", []);
    expect(calls[0]?.cwd).toBe(ROOT);

    await runtime.executeCommand!("ls", [], { cwd: "/home/user/other" });
    expect(calls[1]?.cwd).toBe("/home/user/other");
  });

  it("omits cwd entirely when neither a default nor an option is set", async () => {
    const { api, calls } = makeApi();
    const runtime = createBoatSandboxRuntime({
      getApi: () => api,
      getSandboxId: () => "sb-1",
      repoRoot: ROOT,
    });

    await runtime.executeCommand!("ls", []);
    expect(calls[0]).not.toHaveProperty("cwd");
  });

  it("throws rather than sending a command with no sandbox id", async () => {
    const { api } = makeApi();
    const runtime = createBoatSandboxRuntime({
      getApi: () => api,
      getSandboxId: () => "",
      repoRoot: ROOT,
    });

    await expect(runtime.executeCommand!("ls", [])).rejects.toThrow(/no sandbox id/i);
  });

  /**
   * The reason this factory composes both halves. `RepoSandboxFs` has no `exec`,
   * so its directory operations need a runner — and the only safe runner is this
   * runtime's own. Assert the wiring, not just that `mkdir` returns.
   */
  it("drives fs directory operations through its own executeCommand", async () => {
    const { api, calls } = makeApi();
    const runtime = createBoatSandboxRuntime({
      getApi: () => api,
      getSandboxId: () => "sb-1",
      repoRoot: ROOT,
    });

    await runtime.fs.mkdir("src");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ sandboxId: "sb-1", command: "bash" });
    expect(calls[0]?.args?.join(" ")).toContain("mkdir -p");
  });

  it("keeps two runtimes from sharing a sandbox", async () => {
    const a = makeApi();
    const b = makeApi();
    const runtimeA = createBoatSandboxRuntime({
      getApi: () => a.api,
      getSandboxId: () => "sb-a",
      repoRoot: ROOT,
    });
    const runtimeB = createBoatSandboxRuntime({
      getApi: () => b.api,
      getSandboxId: () => "sb-b",
      repoRoot: ROOT,
    });

    await runtimeA.fs.mkdir("x");
    await runtimeB.fs.mkdir("y");

    // The regression this whole design exists to prevent: a shared module-level
    // runner would have sent both to one sandbox.
    expect(a.calls.map((c) => c.sandboxId)).toEqual(["sb-a"]);
    expect(b.calls.map((c) => c.sandboxId)).toEqual(["sb-b"]);
  });

  it("omits lifecycle hooks when the provider does not implement them", () => {
    const { api } = makeApi();
    const runtime = createBoatSandboxRuntime({
      getApi: () => api,
      getSandboxId: () => "sb-1",
      repoRoot: ROOT,
    });

    expect(runtime.start).toBeUndefined();
    expect(runtime.destroy).toBeUndefined();
  });

  it("wires lifecycle hooks to this sandbox when available", async () => {
    const deleteSandbox = vi.fn(async () => ({}));
    const { api } = makeApi();
    const runtime = createBoatSandboxRuntime({
      getApi: () => ({ ...api, deleteSandbox }),
      getSandboxId: () => "sb-1",
      repoRoot: ROOT,
    });

    await runtime.destroy?.();
    expect(deleteSandbox).toHaveBeenCalledWith({ sandboxId: "sb-1" });
  });
});