import { describe, expect, it, vi } from "vitest";
import { createBoatEnvironment, DEFAULT_BOAT_REPO_DIR } from "./boat-environment.js";
import type { BoatCommandApi } from "../../sandbox-fs/boat-sandbox-runtime.js";

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

describe("createBoatEnvironment", () => {
  it("returns the same shape as createBlaxelEnvironment", async () => {
    const { api } = makeApi();
    const boat = await createBoatEnvironment({
      getApi: () => api,
      getSandboxId: () => "sb-1",
      repoRoot: DEFAULT_BOAT_REPO_DIR,
    });

    // The contract a caller switches on — provider must not leak past this.
    expect(typeof boat.env.exec).toBe("function");
    expect(typeof boat.env.readFile).toBe("function");
    expect(typeof boat.env.writeFile).toBe("function");
    expect(typeof boat.destroy).toBe("function");
    expect(typeof boat.sandboxName).toBe("string");
  });

  it("defaults the label to the sandbox id", async () => {
    const { api } = makeApi();
    const boat = await createBoatEnvironment({
      getApi: () => api,
      getSandboxId: () => "sb-abc",
      repoRoot: DEFAULT_BOAT_REPO_DIR,
    });

    expect(boat.sandboxName).toBe("sb-abc");
  });

  it("honours an explicit label", async () => {
    const { api } = makeApi();
    const boat = await createBoatEnvironment({
      getApi: () => api,
      getSandboxId: () => "sb-abc",
      repoRoot: DEFAULT_BOAT_REPO_DIR,
      label: "nah-coding",
    });

    expect(boat.sandboxName).toBe("nah-coding");
  });

  it("creates the repo dir on a fresh sandbox, quoted and best-effort", async () => {
    const { api, calls } = makeApi();
    await createBoatEnvironment({
      getApi: () => api,
      getSandboxId: () => "sb-1",
      repoRoot: DEFAULT_BOAT_REPO_DIR,
    });

    const mkdir = calls.at(-1);
    expect(mkdir?.command).toBe("bash");
    expect(mkdir?.args?.join(" ")).toContain("mkdir -p");
    expect(mkdir?.cwd).toBe("/");
  });

  /**
   * A template that already has the repo dir makes `mkdir -p` a no-op, and a
   * sandbox that refuses it must not stop the run from starting.
   */
  it("still builds an environment when the mkdir fails", async () => {
    const calls: Parameters<BoatCommandApi["executeCommand"]>[0][] = [];
    const api: BoatCommandApi = {
      executeCommand: vi.fn(async (request) => {
        calls.push(request);
        if (request.command === "bash") throw new Error("sandbox not ready");
        return { success: true, exitCode: 0, stdout: "" };
      }),
    };

    const boat = await createBoatEnvironment({
      getApi: () => api,
      getSandboxId: () => "sb-1",
      repoRoot: DEFAULT_BOAT_REPO_DIR,
    });

    expect(typeof boat.env.exec).toBe("function");
  });

  it("routes env operations to this sandbox", async () => {
    const { api, calls } = makeApi({ stdout: "hello\n" });
    const boat = await createBoatEnvironment({
      getApi: () => api,
      getSandboxId: () => "sb-xyz",
      repoRoot: DEFAULT_BOAT_REPO_DIR,
    });

    const result = await boat.env.exec("echo hello");

    expect(result.stdout).toBe("hello\n");
    expect(calls.at(-1)?.sandboxId).toBe("sb-xyz");
  });

  it("delegates destroy to the runtime's lifecycle hook", async () => {
    const deleteSandbox = vi.fn(async () => ({}));
    const { api } = makeApi();
    const boat = await createBoatEnvironment({
      getApi: () => ({ ...api, deleteSandbox }),
      getSandboxId: () => "sb-1",
      repoRoot: DEFAULT_BOAT_REPO_DIR,
    });

    await boat.destroy();
    expect(deleteSandbox).toHaveBeenCalledWith({ sandboxId: "sb-1" });
  });

  it("destroy is a no-op when the provider has no delete hook", async () => {
    const { api } = makeApi();
    const boat = await createBoatEnvironment({
      getApi: () => api,
      getSandboxId: () => "sb-1",
      repoRoot: DEFAULT_BOAT_REPO_DIR,
    });

    await expect(boat.destroy()).resolves.toBeUndefined();
  });

  /**
   * Path jailing lives in `normalizeUnderRepoRoot`, shared with every provider.
   * This asserts the Boat environment actually routes through it rather than
   * trusting its own copy.
   */
  it("rejects a path that escapes the repo root", async () => {
    const { api } = makeApi();
    const boat = await createBoatEnvironment({
      getApi: () => api,
      getSandboxId: () => "sb-1",
      repoRoot: DEFAULT_BOAT_REPO_DIR,
    });

    await expect(boat.env.readFile("../../etc/passwd")).rejects.toThrow();
  });
});

describe("DEFAULT_BOAT_REPO_DIR", () => {
  /**
   * Boat's jail admits `/home/user` and `/tmp` and answers anything else with
   * `400 invalid_path`. Reusing the Blaxel default (`/workspace/repo`) would
   * fail every single call, so this pins the jail explicitly.
   */
  it("sits inside Boat's path jail", () => {
    expect(DEFAULT_BOAT_REPO_DIR.startsWith("/home/user")).toBe(true);
  });

  it("is not the Blaxel-shaped default", () => {
    expect(DEFAULT_BOAT_REPO_DIR).not.toBe("/workspace/repo");
  });
});