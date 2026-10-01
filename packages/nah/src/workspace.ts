/**
 * Where the workspace begins.
 *
 * ## Why this is not just `cwd`
 *
 * `cwd` is where the user happened to be when they started the agent. In a
 * monorepo that is usually one package, and the unit of work is usually the
 * repository. Two measured runs of "explain this codebase" from
 * `packages/nah` both spent a step discovering the fence — one calling
 * `read ../../packages/not-another-harness/README.md` and getting
 *
 *     path escapes workspace root: ../../packages/not-another-harness/README.md
 *
 * then spending several more steps shelling out to `cd ../..` to work around it.
 * The agent was not doing anything wrong; it was told it was somewhere it was
 * not. A workspace rooted at the repository makes the sibling package reachable
 * by its real path (`packages/not-another-harness/...`) instead.
 *
 * ## Why `bash` is not restricted the same way
 *
 * It is tempting to close the inconsistency by blocking escapes in `bash` too.
 * That would be worse than the inconsistency, in both directions:
 *
 * - It cannot be done reliably. `cd ..`, `$(...)`, absolute paths, `git -C`,
 *   symlinks and `python -c "open(...)"` all defeat string matching, so a
 *   denylist is simultaneously leaky and useless.
 * - It would break legitimate work. `pnpm --filter`, `git -C ../sibling` and
 *   building across packages are ordinary in exactly the monorepos this harness
 *   runs in — the logs above are full of them.
 *
 * Real isolation is an OS-level problem (namespaces, seccomp, a container), not
 * a path check, and it would be a different project. So `bash` keeps its
 * unrestricted reach, `read`/`write` keep the check they can actually perform,
 * and the rest of this module's job is to make the boundary *known* rather than
 * something the agent has to trip over.
 */
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import * as nodePath from "node:path";

const execFileAsync = promisify(execFile);

/** Git's own answer to "where does the repository begin". */
const repoRoot = async (cwd: string): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    const top = stdout.trim();
    return top.length > 0 ? nodePath.resolve(top) : null;
  } catch {
    // Not a repository, git unavailable, or no permission. All ordinary — the
    // cwd is then the right answer, not an error.
    return null;
  }
};

/** The real path, falling back to the input when it cannot be resolved. */
const realOrSelf = async (path: string): Promise<string> => {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
};

/**
 * The directory the workspace tools are confined to.
 *
 * Resolution order:
 *  1. `NAH_WORKSPACE_ROOT`, for deliberately working inside a subtree.
 *  2. The enclosing Git repository, so a monorepo package is not a pen.
 *  3. `cwd`, when there is no repository.
 *
 * The containment check compares **real paths on both sides**, which is not a
 * detail. Git resolves symlinks before reporting its toplevel, so on macOS a cwd
 * reached through `/var` (as every temp and cache path is) comes back as
 * `/private/var` and a naive string comparison says "not inside the repo" — the
 * feature then silently does nothing on exactly the paths most likely to need it.
 */
export const resolveWorkspaceRoot = async (
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> => {
  const override = env.NAH_WORKSPACE_ROOT?.trim();
  if (override) return nodePath.resolve(override);
  const top = await repoRoot(cwd);
  if (!top) return nodePath.resolve(cwd);
  const resolved = nodePath.resolve(cwd);
  const [realCwd, realTop] = await Promise.all([realOrSelf(resolved), realOrSelf(top)]);
  const inside = realCwd === realTop || realCwd.startsWith(realTop + nodePath.sep);
  return inside ? top : resolved;
};

/**
 * One line telling the model where the workspace starts and what that means.
 *
 * Worth its place in the prompt: an agent that knows the root up front spends no
 * step discovering it, and an agent that hits the boundary already knows what
 * happened. The `bash` note matters because `bash` is *not* fenced — a model
 * told "everything is confined here" would wrongly conclude that `cd ..` fails.
 */
export const describeWorkspaceBoundary = (root: string, cwdLabel: string): string => {
  const same = root === nodePath.resolve(cwdLabel);
  const where = same ? `The workspace root is your working directory (${root}).` : `The workspace root is ${root}.`;
  return [
    where,
    "The read, write, edit, list and glob tools refuse paths outside it.",
    "bash is not fenced to it and can reach anywhere the user can — use bash when you genuinely need to, but prefer the file tools inside the workspace.",
  ].join(" ");
};
