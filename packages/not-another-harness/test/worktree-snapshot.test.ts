/**
 * The parent's uncommitted work is what a child most needs to see, and what it
 * used to never see.
 *
 * Branching children from `HEAD` made almost every real task undelegable: a live
 * agent session has uncommitted work by definition, so "delegate only work that
 * does not depend on your uncommitted changes" excluded nearly everything. These
 * tests run against real temporary repositories because the whole behaviour lives
 * in git plumbing that a mock would happily agree with.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type IsolationHandle, createGitWorktreeIsolation } from "../src/orchestrator.js";

const execFileAsync = promisify(execFile);

const git = async (cwd: string, args: string[]) => {
	const { stdout } = await execFileAsync("git", args, { cwd });
	return stdout.trim();
};

describe("git worktree isolation over a dirty parent", () => {
	let dir: string;
	let repo: string;
	let root: string;

	beforeEach(async () => {
		dir = await mkdtemp(nodePath.join(tmpdir(), "nah-worktree-"));
		// Worktrees live under `root` so a test can assert on what is left behind
		// without scanning the whole OS temp directory.
		root = nodePath.join(dir, "worktrees");
		repo = nodePath.join(dir, "repo");
		await git(dir, ["init", "--initial-branch=main", repo]);
		await git(repo, ["config", "user.email", "test@example.com"]);
		await git(repo, ["config", "user.name", "Test"]);
		await writeFile(nodePath.join(repo, "committed.txt"), "original\n");
		await git(repo, ["add", "-A"]);
		await git(repo, ["commit", "-m", "initial"]);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	/**
	 * Run a child through prepare/collect/cleanup, with the assertions happening
	 * while the worktree still exists — cleanup removes it, so returning the handle
	 * to assert on afterwards would test an empty directory.
	 */
	const withChild = async (
		assert: (ctx: { handle: IsolationHandle; artifact: Awaited<ReturnType<NonNullable<ReturnType<typeof createGitWorktreeIsolation>["prepare"]>>["collect"]> }) => Promise<void>,
		options: { snapshotParentChanges?: boolean; retain?: boolean } = {},
	) => {
		const isolation = createGitWorktreeIsolation({ cwd: repo, tmpRoot: root, ...options });
		const handle = await isolation.prepare?.();
		if (!handle) throw new Error("prepare returned no handle");
		try {
			const artifact = await handle.collect?.();
			await assert({ handle, artifact });
		} finally {
			await handle.cleanup?.({ retain: false });
		}
	};

	it("gives a child the parent's uncommitted edits, not just HEAD", async () => {
		await writeFile(nodePath.join(repo, "committed.txt"), "edited by the parent\n");

		await withChild(async ({ handle, artifact }) => {
			expect(await readFile(nodePath.join(handle.cwd, "committed.txt"), "utf8")).toBe(
				"edited by the parent\n",
			);
			// The diff is measured from the snapshot, so the parent's own edit is not
			// reported back to the parent as if the child had made it.
			expect(artifact?.diff ?? "").not.toContain("edited by the parent");
		});
	});

	it("includes untracked files, which are the new ones a child needs", async () => {
		await writeFile(nodePath.join(repo, "brand-new.ts"), "export const added = 1;\n");

		await withChild(async ({ handle }) => {
			expect(await readFile(nodePath.join(handle.cwd, "brand-new.ts"), "utf8")).toBe(
				"export const added = 1;\n",
			);
		});
	});

	it("respects .gitignore rather than copying build output into every child", async () => {
		await writeFile(nodePath.join(repo, ".gitignore"), "node_modules/\n");
		await git(repo, ["add", "-A"]);
		await git(repo, ["commit", "-m", "ignore rules"]);
		await writeFile(nodePath.join(repo, "committed.txt"), "changed\n");
		await mkdir(nodePath.join(repo, "node_modules", "pkg"), { recursive: true });
		await writeFile(nodePath.join(repo, "node_modules/pkg/index.js"), "huge\n");

		await withChild(async ({ handle }) => {
			await expect(
				readFile(nodePath.join(handle.cwd, "node_modules/pkg/index.js"), "utf8"),
			).rejects.toThrow();
		});
	});

	it("tells the child the parent's state is included, and that it is frozen", async () => {
		await writeFile(nodePath.join(repo, "committed.txt"), "edited by the parent\n");

		await withChild(({ handle }) => {
			const note = handle.boundaryNotes?.find((n) => n.includes("uncommitted"));
			expect(note).toBeDefined();
			expect(note).toContain("included");
			expect(note).toContain("frozen");
			expect(note).not.toContain("do not depend on them");
		});
	});

	it("leaves HEAD as the base when the parent has nothing uncommitted", async () => {
		const head = await git(repo, ["rev-parse", "HEAD"]);

		await withChild(async ({ handle, artifact }) => {
			expect(artifact?.baseRevision).toBe(head);
			expect(handle.boundaryNotes?.some((n) => n.includes("uncommitted"))).toBe(false);
		});
	});

	it("branches from HEAD when the caller opts out", async () => {
		await writeFile(nodePath.join(repo, "committed.txt"), "edited by the parent\n");
		const head = await git(repo, ["rev-parse", "HEAD"]);

		await withChild(
			async ({ handle, artifact }) => {
				expect(artifact?.baseRevision).toBe(head);
				expect(await readFile(nodePath.join(handle.cwd, "committed.txt"), "utf8")).toBe(
					"original\n",
				);
				// The note must describe the isolation actually in force, not the one
				// the default would have used.
				const note = handle.boundaryNotes?.find((n) => n.includes("uncommitted"));
				expect(note).toContain("not present here");
				expect(note).not.toContain("included");
			},
			{ snapshotParentChanges: false },
		);
	});

	it("never touches the parent's working tree or real index to take the snapshot", async () => {
		await writeFile(nodePath.join(repo, "committed.txt"), "edited by the parent\n");
		await writeFile(nodePath.join(repo, "untracked.ts"), "export const x = 1;\n");
		const statusBefore = await git(repo, ["status", "--porcelain=v1"]);
		const headBefore = await git(repo, ["rev-parse", "HEAD"]);

		await withChild(async () => {
			// The whole point of the temp index: a snapshot must not stage, stash or
			// otherwise rearrange what the user has in flight.
			expect(await git(repo, ["status", "--porcelain=v1"])).toBe(statusBefore);
			expect(await git(repo, ["rev-parse", "HEAD"])).toBe(headBefore);
			expect(await git(repo, ["stash", "list"])).toBe("");
		});
	});

	it("reports only the child's own edits in changedPaths", async () => {
		await writeFile(nodePath.join(repo, "committed.txt"), "edited by the parent\n");

		await withChild(async ({ handle }) => {
			await writeFile(nodePath.join(handle.cwd, "child.ts"), "export const mine = 1;\n");
			const collected = await handle.collect?.();
			expect(collected?.changedPaths).toContain("child.ts");
			expect(collected?.changedPaths ?? []).not.toContain("committed.txt");
		});
	});

	it("removes the temp index even when the worktree is retained", async () => {
		await writeFile(nodePath.join(repo, "committed.txt"), "edited by the parent\n");
		const isolation = createGitWorktreeIsolation({ cwd: repo, tmpRoot: root, retain: true });

		const handle = await isolation.prepare?.();
		await handle?.cleanup?.({ retain: true });

		const leftovers = (await readdir(root)).filter((n) => n.includes("index"));
		expect(leftovers).toEqual([]);
	});
});
