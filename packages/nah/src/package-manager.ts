/**
 * Working out which package manager to install with.
 *
 * A Studio is installed on demand, so this is the difference between `/studio`
 * working and printing an error. The order below is deliberate: what the current
 * process was started with is the best evidence, the lockfile is the project's
 * intent, and `npm` is the answer only when there is no evidence at all — it is
 * the one that is certainly installed.
 *
 * The user agent is the important one. `npm_config_user_agent` is set by every
 * runner, and inside `pnpm nah` it says pnpm, which is the package manager this
 * project actually uses.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export type PackageManager = "pnpm" | "yarn" | "bun" | "npm";

const BY_USER_AGENT: Array<[RegExp, PackageManager]> = [
  [/pnpm/, "pnpm"],
  [/yarn/, "yarn"],
  [/bun/, "bun"],
  [/npm/, "npm"],
];

const hasCommand = (command: string, platform: NodeJS.Platform = process.platform): boolean => {
  const probe = spawnSync(platform === "win32" ? "where" : "command", platform === "win32" ? [command] : ["-v", command], {
    stdio: "ignore",
  });
  return probe.status === 0;
};

export const detectPackageManager = (
  options: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    platform?: NodeJS.Platform;
    which?: (command: string) => boolean;
  } = {},
): PackageManager => {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const which = options.which ?? ((command: string) => hasCommand(command, platform));

  const agent = env.npm_config_user_agent ?? "";
  for (const [pattern, manager] of BY_USER_AGENT) {
    if (pattern.test(agent)) return manager;
  }
  // pnpm writes one lockfile, bun and yarn each write their own, and npm's is
  // checked last because a project that has been through more than one of these
  // tends to have more than one file lying about.
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) return "bun";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(join(cwd, "package-lock.json"))) return "npm";
  return "npm";
};

/**
 * The command that runs a package without installing it permanently.
 *
 * `--yes` is the difference between a Studio that opens and a Studio that stops to
 * ask a question nobody is there to answer. pnpm's `dlx` does not prompt at all,
 * and it is deliberately left un-silenced: `--silent` here swallowed a failed
 * resolution and left a log file with nothing in it, which is the worst possible
 * outcome for a command whose whole job is to start something.
 */
export const runOnceCommand = (
  manager: PackageManager,
  packageSpec: string,
  args: string[] = [],
): { command: string; args: string[] } => {
  switch (manager) {
    case "pnpm":
      return { command: "pnpm", args: ["dlx", packageSpec, ...args] };
    case "yarn":
      return { command: "yarn", args: ["--yes", "dlx", packageSpec, ...args] };
    case "bun":
      return { command: "bunx", args: ["--yes", packageSpec, ...args] };
    case "npm":
      return { command: "npx", args: ["--yes", packageSpec, ...args] };
  }
};

/**
 * Find an installed Studio binary.
 *
 * A local `node_modules/.bin` first, then PATH: a project that depends on the
 * Studio should use the version its lockfile pinned, and one that does not should
 * use whatever was installed globally.
 */
export const findStudioBinary = (
  options: { cwd?: string; pathEnv?: string; platform?: NodeJS.Platform; exists?: (path: string) => boolean } = {},
): string | null => {
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? ((path: string) => existsSync(path));
  const name = platform === "win32" ? "nah-studio.cmd" : "nah-studio";

  const local = join(cwd, "node_modules", ".bin", name);
  if (exists(local)) return local;

  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  for (const entry of pathEnv.split(platform === "win32" ? ";" : ":")) {
    if (!entry) continue;
    const candidate = join(entry, name);
    if (exists(candidate)) return candidate;
  }
  return null;
};
