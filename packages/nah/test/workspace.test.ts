import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";

import { describeWorkspaceBoundary, resolveWorkspaceRoot } from "../src/workspace.js";

const REPO = nodePath.resolve(import.meta.dirname, "..", "..", "..");

/**
 * The contract is "we return what git says", so the expectation is built from git
 * rather than from `nodePath.resolve`.
 *
 * These paths cannot be compared naively: a macOS temp directory sits behind
 * `/var` -> `/private/var`, and git reports whichever form it was given. Neither
 * the resolved nor the realpath'd form is the answer on both platforms.
 */
const gitRoot = (dir: string): string =>
  execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" }).trim();

/** A throwaway git repo, optionally with a nested package directory. */
const makeRepo = async (nested = false): Promise<string> => {
  const dir = await mkdtemp(nodePath.join(tmpdir(), "nah-ws-"));
  const git = (args: string[], cwd = dir) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git(["init", "-q"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  await writeFile(nodePath.join(dir, "README.md"), "# repo\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  if (nested) {
    await mkdir(nodePath.join(dir, "packages", "app"), { recursive: true });
    await writeFile(nodePath.join(dir, "packages", "app", "index.ts"), "export const x = 1;\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "pkg"]);
  }
  return dir;
};

describe("resolveWorkspaceRoot", () => {
  it("widens to the repository when started from a package directory", async () => {
    // The measured failure: started in packages/nah, asked to explain the
    // monorepo, `read ../not-another-harness/...` was refused and the agent spent
    // several steps shelling out to `cd ../..` to get around a fence it had never
    // been told about.
    const dir = await makeRepo(true);
    try {
      const pkg = nodePath.join(dir, "packages", "app");
      expect(await resolveWorkspaceRoot(pkg, {})).toBe(gitRoot(dir));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op when already at the repository root", async () => {
    const dir = await makeRepo(true);
    try {
      expect(await resolveWorkspaceRoot(dir, {})).toBe(gitRoot(dir));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("honours NAH_WORKSPACE_ROOT for deliberately working in a subtree", async () => {
    const dir = await makeRepo(true);
    try {
      const pkg = nodePath.join(dir, "packages", "app");
      expect(await resolveWorkspaceRoot(pkg, { NAH_WORKSPACE_ROOT: pkg })).toBe(nodePath.resolve(pkg));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to cwd outside a repository", async () => {
    // No git, no repository, or a permission failure are all ordinary. The cwd is
    // then the right answer rather than an error — failing startup over this would
    // be worse than the fence it was avoiding.
    const dir = await mkdtemp(nodePath.join(tmpdir(), "nah-nogit-"));
    try {
      expect(await resolveWorkspaceRoot(dir, {})).toBe(nodePath.resolve(dir));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores a blank override", async () => {
    const dir = await makeRepo(true);
    try {
      const pkg = nodePath.join(dir, "packages", "app");
      expect(await resolveWorkspaceRoot(pkg, { NAH_WORKSPACE_ROOT: "   " })).toBe(gitRoot(dir));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("still widens when the cwd reaches the repo through a symlink", async () => {
    // Git resolves symlinks before reporting its toplevel. A cwd reached through
    // one therefore comes back from git as a *different string* for the same
    // directory — `/var/...` versus `/private/var/...` on macOS — and a naive
    // containment check concludes "not in the repo" and quietly does nothing. Every
    // temp, cache and CI path is reached this way, so this is the common case, not
    // an edge one.
    const dir = await makeRepo(true);
    const viaLink = nodePath.join(dir, "..", `nah-link-${nodePath.basename(dir)}`);
    try {
      await symlink(dir, viaLink);
      const fromLink = nodePath.join(viaLink, "packages", "app");
      expect(await resolveWorkspaceRoot(fromLink, {})).toBe(gitRoot(dir));
    } finally {
      await rm(viaLink, { force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves this repository's own root, which is how the fix was verified", async () => {
    // Guards against the detection silently degrading to a cwd fallback in the
    // actual monorepo the fix was written for.
    expect(await resolveWorkspaceRoot(nodePath.join(REPO, "packages", "nah"), {})).toBe(REPO);
  });
});

describe("describeWorkspaceBoundary", () => {
  const root = "/repo";

  it("names the root", () => {
    expect(describeWorkspaceBoundary(root, "/repo")).toContain(root);
  });

  it("says the file tools are fenced and bash is not", () => {
    const line = describeWorkspaceBoundary(root, root);
    expect(line).toMatch(/read, write, edit, list and glob/);
    // The honest bit. Telling a model "everything is confined here" when bash is
    // not would send it looking for a `cd ..` that cannot work.
    expect(line).toMatch(/bash is not fenced/i);
  });

  it("distinguishes a widened root from the working directory", () => {
    expect(describeWorkspaceBoundary(root, "/repo/packages/app")).toContain("/repo");
    expect(describeWorkspaceBoundary("/repo", "/repo")).toContain("working directory");
  });

  it("is short enough to be worth its place in the prompt every turn", async () => {
    // It is appended to the system prompt on every single turn, so its cost is
    // multiplied by the step count — the same reason the static prefix is watched.
    expect(describeWorkspaceBoundary(root, root).length).toBeLessThan(400);
  });
});
