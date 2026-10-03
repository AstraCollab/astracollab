/**
 * The Studio, from `nah`'s side.
 *
 * The command is mostly about not doing things by surprise: not installing
 * anything without being asked, not starting a second Studio when one is already
 * running, and not claiming a dashboard exists when the file that describes it
 * points at a process that died an hour ago. Those are the cases worth pinning
 * down, so the spawn, the browser and the filesystem are all injected and the
 * assertions are about what the user was told.
 */
import { describe, expect, it, vi } from "vitest";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { parseCliArgs } from "../src/args.js";
import { detectPackageManager, findStudioBinary, runOnceCommand } from "../src/package-manager.js";
import { currentNahBin, parseStudioArg, runStudioCommand, siblingStudio, studioArgs } from "../src/studio-command.js";
import { STUDIO_DIST_TAG, STUDIO_PACKAGE } from "../src/studio-endpoint.js";
import { isProcessAlive, readEndpoint } from "../src/studio-endpoint.js";

/**
 * Write the endpoint file the way the Studio does.
 *
 * By hand on purpose. The format is the contract between two packages that do not
 * depend on each other — one writes it, this side reads it — so a test that used a
 * shared writer would only be asserting that a writer agrees with itself.
 */
const publishEndpoint = (dir: string, endpoint: Record<string, unknown>): string => {
  const path = join(dir, ".nah", "studio.json");
  mkdirSync(join(dir, ".nah"), { recursive: true });
  writeFileSync(path, JSON.stringify(endpoint, null, 2), { mode: 0o600 });
  return path;
};

const home = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "nah-studio-"));
  mkdirSync(join(dir, ".nah"), { recursive: true });
  return dir;
};

/** A writable that records what a command printed. */
const sink = () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  }) as unknown as NodeJS.WriteStream & { lines: string[] };
  stream.lines = lines;
  return stream;
};

const neverProbe = async () => true;

describe("studio endpoint", () => {
  it("reads what the Studio publishes", async () => {
    const dir = home();
    const path = publishEndpoint(dir, {
      url: "http://127.0.0.1:4111",
      token: "shared-secret",
      pid: process.pid,
      startedAt: 1,
      version: "1.2.3",
      nahBin: "/usr/local/bin/nah",
      cwd: "/repo",
    });
    expect(await readEndpoint(path)).toMatchObject({
      url: "http://127.0.0.1:4111",
      token: "shared-secret",
      version: "1.2.3",
      nahBin: "/usr/local/bin/nah",
      cwd: "/repo",
    });
    expect(existsSync(path)).toBe(true);
  });

  it("treats a file it cannot parse as no studio at all", async () => {
    const dir = home();
    const path = join(dir, ".nah", "studio.json");
    writeFileSync(path, "{not json");
    expect(await readEndpoint(path)).toBeNull();
    // Missing fields are the same thing: a Studio from another version wrote this.
    writeFileSync(path, JSON.stringify({ url: "http://127.0.0.1:4111" }));
    expect(await readEndpoint(path)).toBeNull();
  });

  it("knows a pid that is gone from one that is here", () => {
    // This process is definitionally alive.
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });
});

describe("choosing a package manager", () => {
  it("trusts the runner that started this process", () => {
    // The strongest evidence there is, and the reason a monorepo does not install
    // through npm just because npm is always present.
    expect(detectPackageManager({ env: { npm_config_user_agent: "pnpm/10.13.1 npm/? node/v22.19.0" }, cwd: "/nope" })).toBe("pnpm");
    expect(detectPackageManager({ env: { npm_config_user_agent: "yarn/4.5.0 npm/? node/v22" }, cwd: "/nope" })).toBe("yarn");
    expect(detectPackageManager({ env: { npm_config_user_agent: "bun/1.2.0" }, cwd: "/nope" })).toBe("bun");
    expect(detectPackageManager({ env: { npm_config_user_agent: "npm/10.9.0 node/v22" }, cwd: "/nope" })).toBe("npm");
  });

  it("falls back to npm when there is no evidence at all", () => {
    expect(detectPackageManager({ env: {}, cwd: "/nope" })).toBe("npm");
  });

  it("builds a dlx command per manager, from the tag the releases live under", () => {
    for (const manager of ["pnpm", "yarn", "bun", "npm"] as const) {
      const command = runOnceCommand(manager, `${STUDIO_PACKAGE}@${STUDIO_DIST_TAG}`);
      expect(command.command.length).toBeGreaterThan(0);
      expect(command.args.join(" ")).toContain(`${STUDIO_PACKAGE}@${STUDIO_DIST_TAG}`);
    }
    // Not `latest`: the Studio is a prerelease, and `latest` is whatever was
    // published without a tag — for a package that has only ever been published
    // with one, that is the first build, and it stays there.
    expect(STUDIO_DIST_TAG).not.toBe("latest");
  });

  it("does not silence the installer, because its failure is the useful part", () => {
    // `--silent` here left a log file with nothing in it, and turned a
    // "no such version" into a bare "did not come up".
    for (const manager of ["pnpm", "yarn", "bun", "npm"] as const) {
      expect(runOnceCommand(manager, "nah-studio@beta").args).not.toContain("--silent");
    }
  });

  it("prefers a locally installed studio over a global one", () => {
    const local = findStudioBinary({
      cwd: "/repo",
      pathEnv: "/usr/bin",
      exists: (path) => path === join("/repo", "node_modules", ".bin", "nah-studio"),
    });
    expect(local).toBe(join("/repo", "node_modules", ".bin", "nah-studio"));

    const onPath = findStudioBinary({
      cwd: "/repo",
      pathEnv: "/usr/local/bin:/usr/bin",
      exists: (path) => path === "/usr/local/bin/nah-studio",
    });
    expect(onPath).toBe("/usr/local/bin/nah-studio");

    expect(findStudioBinary({ cwd: "/repo", pathEnv: "/usr/bin", exists: () => false })).toBeNull();
  });
});

describe("/studio arguments", () => {
  it("reads an action, and an unknown one as help rather than a shrug", () => {
    expect(parseStudioArg(undefined)).toBe("start");
    expect(parseStudioArg("")).toBe("start");
    expect(parseStudioArg("status")).toBe("status");
    expect(parseStudioArg("stop")).toBe("stop");
    expect(parseStudioArg("wat")).toBe("help");
  });

  it("passes the directory, port and this binary down to the studio", () => {
    const args = studioArgs("/repo", { NAH_MODEL: "anthropic:claude-sonnet-4-5" }, "/usr/local/bin/nah");
    expect(args).toContain("--cwd");
    expect(args[args.indexOf("--cwd") + 1]).toBe("/repo");
    expect(args[args.indexOf("--port") + 1]).toBe("4111");
    expect(args[args.indexOf("--model") + 1]).toBe("anthropic:claude-sonnet-4-5");
    // So the Studio launches this build and not whatever `nah` is on PATH.
    expect(args[args.indexOf("--nah-bin") + 1]).toBe("/usr/local/bin/nah");
  });

  it("honours a port from the environment", () => {
    const args = studioArgs("/repo", { NAH_STUDIO_PORT: "5000" }, undefined);
    expect(args[args.indexOf("--port") + 1]).toBe("5000");
  });

  it("finds a studio built in the same checkout", () => {
    // The case that is not a real installation: someone working on the Studio or
    // the CLI. `/studio` should run their working tree, not the last release.
    const built = "/repo/packages/nah-studio/dist/cli.js";
    expect(siblingStudio("/repo/packages/nah/dist/cli.js", (path) => path === built)).toBe(built);
    // Nothing built, nothing claimed.
    expect(siblingStudio("/repo/packages/nah/dist/cli.js", () => false)).toBeNull();
    // A globally installed CLI has no sibling, and must not look for one.
    expect(siblingStudio("/usr/local/bin/nah", () => true)).toBeNull();
    expect(siblingStudio(undefined)).toBeNull();
  });

  it("falls back to this process's own entry point when a caller passes none", () => {
    // The TUI and the REPL do not pass a binary, and before this default they went
    // to npm for a package that could not have worked in a checkout. The only
    // correct place to resolve it is inside the command.
    const given = studioArgs("/repo", {}, "/given/nah");
    expect(given[given.indexOf("--nah-bin") + 1]).toBe("/given/nah");
    // And with none given, the value is this process's own entry point.
    const defaulted = studioArgs("/repo", {});
    expect(defaulted[defaulted.indexOf("--nah-bin") + 1]).toBe(currentNahBin());
  });

  it("finds its own entry point, resolved against the cwd", () => {
    expect(currentNahBin(["node", "/abs/dist/cli.js"], "/repo")).toBe("/abs/dist/cli.js");
    expect(currentNahBin(["node", "dist/cli.js"], "/repo")).toBe("/repo/dist/cli.js");
  });
});

describe("/studio", () => {
  it("opens the dashboard that is already running instead of starting a second", async () => {
    const dir = home();
    publishEndpoint(dir, { url: "http://127.0.0.1:4111", pid: process.pid, startedAt: 1, version: "1.0.0" });
    const out = sink();
    const opened: string[] = [];
    const spawnProcess = vi.fn();

    await runStudioCommand("/studio", {
      cwd: dir,
      out,
      env: { PATH: "" },
      home: dir,
      spawnProcess,
      probe: neverProbe,
      open: async (url) => {
        opened.push(url);
        return { opened: true };
      },
    });

    expect(out.lines.join("")).toContain("already running at http://127.0.0.1:4111");
    // One dashboard, not two on two ports — the failure this avoids is a user
    // staring at two half-empty views wondering which is the real one.
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(opened).toEqual(["http://127.0.0.1:4111"]);
  });

  it("ignores a studio file whose process is gone", async () => {
    const dir = home();
    // A pid nothing can be running: signal 0 on it fails, which is how a Studio
    // that was killed an hour ago is told apart from one that is listening.
    publishEndpoint(dir, { url: "http://127.0.0.1:4111", pid: 2 ** 30, startedAt: 1, version: "1.0.0" });
    const out = sink();
    const spawnProcess = vi.fn();

    await runStudioCommand("/studio", {
      cwd: dir,
      out,
      env: { PATH: "" },
      home: dir,
      spawnProcess,
      probe: neverProbe,
      open: async () => ({ opened: false, reason: "no" }),
      confirm: async () => false,
    });

    const printed = out.lines.join("");
    expect(printed).not.toContain("already running");
    // Treated as no Studio at all, so the next step is a new one — and the stale
    // file is cleared rather than left to be read again by every agent on the
    // machine.
    expect(printed).toContain("not installed");
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(await readEndpoint(join(dir, ".nah", "studio.json"))).toBeNull();
  });

  it("installs nothing until it is asked, and prints the command when it cannot ask", async () => {
    const dir = home();
    const out = sink();
    const spawnProcess = vi.fn();

    await runStudioCommand("/studio", {
      cwd: dir,
      out,
      env: { PATH: "" },
      home: dir,
      spawnProcess,
      probe: neverProbe,
      open: async () => ({ opened: false, reason: "no" }),
    });

    expect(spawnProcess).not.toHaveBeenCalled();
    const printed = out.lines.join("");
    // Piped or scripted, so there is no user to answer the question. The command
    // is printed instead of guessed at.
    expect(printed).toContain(`${STUDIO_PACKAGE}@${STUDIO_DIST_TAG}`);
  });

  it("does not install when the answer is no", async () => {
    const dir = home();
    const out = sink();
    const spawnProcess = vi.fn();

    await runStudioCommand("/studio", {
      cwd: dir,
      out,
      env: { PATH: "" },
      home: dir,
      spawnProcess,
      probe: neverProbe,
      open: async () => ({ opened: false, reason: "no" }),
      confirm: async () => false,
    });

    expect(spawnProcess).not.toHaveBeenCalled();
    expect(out.lines.join("")).toContain("not installed");
  });

  it("reports a Studio that never came up, and where to look", async () => {
    const dir = home();
    const out = sink();
    const child = { pid: process.pid, unref: vi.fn(), on: vi.fn() };
    // A studio binary that really is there: the PATH is probed on disk, and a
    // command that shells out to nothing is not the thing under test.
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "bin", "nah-studio"), "#!/bin/sh\n");
    const logPath = join(dir, ".nah", "studio", "studio.log");

    await runStudioCommand("/studio", {
      cwd: dir,
      out,
      env: { PATH: join(dir, "bin") },
      home: dir,
      nahBin: "/usr/local/bin/nah",
      // The child writes its own diagnostics to the log it inherits, which is
      // where a failed resolution says why — the thing `--silent` used to eat.
      spawnProcess: vi.fn(() => {
        appendFileSync(
          logPath,
          "Progress: resolved 0, reused 0\n\u001b[2mERR_PNPM_FETCH_404\u001b[0m  No matching version found for nah-studio@beta.\n",
        );
        return child;
      }) as never,
      // Answers no, so `waitForStudio` runs out its clock on a Studio that is not
      // there rather than waiting on one that is.
      probe: async () => false,
      open: async () => ({ opened: false, reason: "no" }),
      readyTimeoutMs: 300,
    });

    const printed = out.lines.join("");
    expect(printed).toContain("did not come up");
    // The reason, not just the log path: "did not come up" is not a diagnosis.
    expect(printed).toContain("No matching version found");
    // The child's own escape codes stripped, so a progress bar cannot take the TUI
    // with it. The output still has `c.dim` codes of its own — these are not.
    expect(printed).not.toContain("ERR_PNPM_FETCH_404\u001b[0m");
    expect(printed).toContain("studio.log");
  });

  it("reports status, and says plainly when there is none", async () => {
    const dir = home();
    const quiet = sink();
    await runStudioCommand("/studio status", { cwd: dir, out: quiet, env: {}, home: dir, probe: neverProbe });
    expect(quiet.lines.join("")).toContain("no studio is running");

    publishEndpoint(dir, { url: "http://127.0.0.1:4111", pid: process.pid, startedAt: 1, version: "0.0.2", token: "secret" });
    const loud = sink();
    await runStudioCommand("/studio status", { cwd: dir, out: loud, env: {}, home: dir, probe: neverProbe });
    const printed = loud.lines.join("");
    expect(printed).toContain("http://127.0.0.1:4111");
    expect(printed).toContain("0.0.2");
    expect(printed).toContain("answering");
    // Worth surfacing: a token-bound Studio behaves differently from a local one.
    expect(printed).toContain("NAH_STUDIO_TOKEN");
  });

  it("prints the url without starting anything", async () => {
    const dir = home();
    const out = sink();
    const spawnProcess = vi.fn();
    await runStudioCommand("/studio url", { cwd: dir, out, env: {}, home: dir, spawnProcess, probe: neverProbe });
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(out.lines.join("")).toContain("no studio is running");
  });
});

describe("nah serve", () => {
  it("is /studio with an optional action", () => {
    const bare = parseCliArgs(["serve"]);
    expect(bare.serve).toBe(true);
    expect(bare.serveAction).toBeUndefined();
    expect(parseCliArgs(["serve", "stop"])).toMatchObject({ serve: true, serveAction: "stop" });
    expect(parseCliArgs(["serve", "--port", "5000"])).toMatchObject({ serve: true, servePort: 5000 });
    // A prompt is not built out of the action, and an ordinary prompt is untouched.
    expect(parseCliArgs(["fix the test"]).prompt).toBe("fix the test");
  });
});