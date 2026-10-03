/**
 * `/studio` — start the dashboard.
 *
 * The Studio is a separate package that this one does not depend on. It gets
 * installed the first time somebody asks for it, then runs as a background
 * process that outlives the session that started it, which is the only shape
 * that works: a dashboard you cannot use while the agent is working is not a
 * dashboard, and a dashboard bound to one terminal dies with it.
 *
 * The command returns as soon as the Studio is up, prints where it went, and
 * opens a browser. What happens after that is the Studio's problem, and `/studio
 * status` or `/studio stop` are how you ask about it later.
 *
 * Two rules the implementation exists to keep:
 *
 *  - Nothing is installed without asking. A command typed in a session should not
 *    reach for the network and write to a global package directory on its own
 *    initiative, so the install goes through the same approval prompt as a tool
 *    call, and `--yes` is the only way past it.
 *  - Nothing is sent anywhere unless a Studio is listening. The endpoint file is
 *    the whole opt-in: no Studio, no telemetry, no network.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

import { c } from "./render.js";
import { openUrl } from "./open-browser.js";
import { detectPackageManager, findStudioBinary, runOnceCommand, type PackageManager } from "./package-manager.js";
import {
  STUDIO_DIST_TAG,
  STUDIO_PACKAGE,
  clearEndpoint,
  isProcessAlive,
  liveEndpoint,
  probeStudio,
  readEndpoint,
  type StudioEndpoint,
} from "./studio-endpoint.js";

const DEFAULT_PORT = 4111;

/** How long to wait for a freshly spawned Studio to answer before giving up on it. */
const READY_TIMEOUT_MS = 12_000;

/**
 * A Studio built in this checkout, next to the CLI.
 *
 * `packages/nah-studio/dist/cli.js` sits two directories above `dist/cli.js`, so
 * for anyone working on either of them, `/studio` should run the code in their
 * working tree rather than ask npm for a release that may predate their edits.
 * Returns null when there is no such build, which is every real installation.
 */
export const siblingStudio = (
  nahBin: string | undefined,
  exists: (path: string) => boolean = existsSync,
): string | null => {
  if (!nahBin) return null;
  // Only a CLI running out of a build directory can have a sibling package. A
  // globally installed one sits in `bin/`, where two directories up is not a
  // workspace, and guessing there would be inventing paths.
  const distDir = nodePath.dirname(nahBin);
  if (nodePath.basename(distDir) !== "dist") return null;
  const candidate = nodePath.resolve(distDir, "..", "..", "nah-studio", "dist", "cli.js");
  return exists(candidate) ? candidate : null;
};

const studioLogPath = (home: string = os.homedir()): string =>
  nodePath.join(home, ".nah", "studio", "studio.log");

/**
 * The last few lines of the Studio's log.
 *
 * Stripped of escape sequences before it is printed: this goes into a transcript
 * that redraws itself, and a stray cursor-move from a progress bar would take the
 * TUI with it. An empty log returns null rather than a blank quote.
 */
const logTail = async (path: string, lines = 6): Promise<string[] | null> => {
  try {
    const kept = (await fs.readFile(path, "utf8"))
      .split("\n")
      .map((line) =>
        line
          .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
          .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "")
          .replace(/\r/g, "")
          .trim(),
      )
      .filter((line) => line.length > 0);
    return kept.length === 0 ? null : kept.slice(-lines);
  } catch {
    return null;
  }
};

/**
 * Where the Studio publishes itself.
 *
 * Derived from `home` rather than from `os.homedir()` at each use, so the log, the
 * endpoint file and the process being stopped are all in one place and cannot end
 * up describing two different Studios.
 */
const endpointFile = (home: string = os.homedir()): string => nodePath.join(home, ".nah", "studio.json");

export type StudioCommandOptions = {
  cwd: string;
  out: NodeJS.WriteStream;
  /** Runs the command and reports its answer. For a tool call, `y`; for `--yes`, always true. */
  confirm?: (question: string) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** This binary, so the Studio launches the same `nah` you are running. */
  nahBin?: string;
  /** Injected in tests. */
  spawnProcess?: typeof spawn;
  open?: typeof openUrl;
  probe?: typeof probeStudio;
  /** How long to wait for a fresh Studio to publish itself. */
  readyTimeoutMs?: number;
};

/**
 * How this process was launched.
 *
 * Recorded so the Studio launches the same build you are running: a global `nah`
 * from npm and one built from source produce different traces, and a dashboard
 * quietly watching the other one is worse than no dashboard.
 */
export const currentNahBin = (argv: string[] = process.argv, cwd: string = process.cwd()): string | undefined => {
  const script = argv[1];
  if (!script) return undefined;
  return nodePath.isAbsolute(script) ? script : nodePath.resolve(cwd, script);
};

export type StudioAction = "start" | "status" | "stop" | "open" | "url" | "help";

/**
 * Ask a yes/no question on the real terminal.
 *
 * `process.stdout` rather than the transcript sink, for the same reason `/provider`
 * does it: readline needs a stream with `output.on`, and inside the TUI the sink is
 * not one. The caller is expected to have released the alternate screen first —
 * `/studio` runs this the way it runs `/provider`.
 *
 * A non-TTY answers "no". The decision in front of the user is whether to install
 * a package, and a piped invocation has no user to ask.
 */
export const confirmOnStdout = async (question: string): Promise<boolean> => {
  if (!process.stdin.isTTY) return false;
  const readline = await import("node:readline/promises");
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    const answer = (await prompt.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } catch {
    return false;
  } finally {
    prompt.close();
  }
};

export const parseStudioArg = (arg: string | undefined): StudioAction => {
  switch (arg) {
    case undefined:
    case "":
    case "start":
      return "start";
    case "status":
      return "status";
    case "stop":
      return "stop";
    case "open":
      return "open";
    case "url":
      return "url";
    case "help":
    case "--help":
      return "help";
    default:
      return "help";
  }
};

const HELP = [
  "  /studio              Start the dashboard in the background and open it",
  "  /studio status       Where it is, whether it is answering, which version",
  "  /studio stop         Stop it",
  "  /studio open         Open the browser again",
  "  /studio url          Print the URL",
  "",
  "  The Studio is a separate package, installed the first time you ask for it.",
  "  While it is running, this session's turns are traced into it. Set",
  "  NAH_TELEMETRY=off or run /telemetry off to stop that.",
  "  NAH_STUDIO_YES=1 skips the install prompt; NAH_STUDIO_PORT picks the port.",
].join("\n");

/**
 * Run the command.
 *
 * Every failure is reported as a line and a return, never a throw: this runs
 * inside a session, and an exception would take the terminal down over a
 * dashboard.
 */
export const runStudioCommand = async (
  input: string,
  options: StudioCommandOptions,
): Promise<"handled"> => {
  const { out } = options;
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  // Where this `nah` is. Resolved here rather than by the caller because the two
  // interactive paths do not know or pass it, and without it a checkout cannot
  // find its own Studio — which is the whole of what makes `/studio` work before
  // anything is published.
  const nahBin = options.nahBin ?? currentNahBin();
  const arg = input.slice("/studio".length).trim().split(/\s+/)[0];
  const action = parseStudioArg(arg);

  if (action === "help") {
    out.write(`${HELP}\n`);
    return "handled";
  }

  const file = endpointFile(home);
  const existing = await liveEndpoint(file);
  if (!existing) {
    // A file with a dead pid in it: harmless to agents, which check, and
    // confusing to a person reading it. Cleared on the way past so the next thing
    // that reads this file finds one Studio, not two candidates.
    const stale = await readEndpoint(file);
    if (stale) {
      out.write(`${c.dim(`  clearing the address of a studio that is no longer running (pid ${stale.pid})`)}\n`);
      await clearEndpoint(stale.pid, file);
    }
  }
  if (action === "url") {
    out.write(`${existing ? existing.url : "no studio is running — /studio starts one"}\n`);
    return "handled";
  }
  if (action === "open") {
    if (!existing) {
      out.write(`${c.dim("  no studio is running — /studio starts one")}\n`);
      return "handled";
    }
    const opened = await (options.open ?? openUrl)(existing.url);
    out.write(opened.opened ? `${existing.url}\n` : `${existing.url}  ${c.dim(`(${opened.reason})`)}\n`);
    return "handled";
  }
  if (action === "status") {
    await reportStatus(out, existing, options);
    return "handled";
  }
  if (action === "stop") {
    await stopStudio(out, existing, { home, probe: options.probe });
    return "handled";
  }

  // action === "start"
  if (existing) {
    // Already up. Reuse it rather than starting a second one on a different
    // port, which would split the dashboard in two and leave the user with two
    // half-dashboards and no way to tell which one is live.
    const answering = await (options.probe ?? probeStudio)(existing);
    if (answering) {
      out.write(`${c.green("  studio")} ${c.dim(`already running at ${existing.url} · ${existing.version}`)}\n`);
      const opened = await (options.open ?? openUrl)(existing.url);
      if (!opened.opened) out.write(`  ${c.dim(`${existing.url}  (${opened.reason})`)}\n`);
      return "handled";
    }
    out.write(`${c.yellow("  studio")} ${c.dim(`was not answering on ${existing.url} — starting a new one`)}\n`);
    await clearEndpoint(existing.pid, endpointFile(home));
  }

  const spawnProcess = options.spawnProcess ?? spawn;

  // A local build comes before PATH: a checkout should show the dashboard its own
  // changes, not the last release.
  const fromCheckout = siblingStudio(nahBin);
  if (fromCheckout) {
    out.write(`${c.dim(`  using the studio built in this checkout: ${fromCheckout}`)}\n`);
    return startStudio(out, {
      command: process.execPath,
      args: [fromCheckout, ...studioArgs(options.cwd, env, nahBin)],
      options,
      binaryLabel: "this checkout",
    });
  }

  const binary = findStudioBinary({ cwd: options.cwd, platform: process.platform, ...(env.PATH === undefined ? {} : { pathEnv: env.PATH }) });

  if (binary) {
    return startStudio(out, {
      command: binary,
      args: studioArgs(options.cwd, env, nahBin),
      options,
      binaryLabel: binary,
    });
  }

  // Nothing installed: ask, then install.
  const manager = detectPackageManager({ env, cwd: options.cwd, platform: process.platform });
  // `beta`, not `latest`: the Studio is a prerelease, and `latest` is whatever was
  // last published without the tag — which on a project like this is the first
  // one, and possibly a broken one.
  const install = runOnceCommand(manager, `${STUDIO_PACKAGE}@${STUDIO_DIST_TAG}`);
  const question = `Install ${c.bold(STUDIO_PACKAGE)} with ${c.bold(install.command)}? It becomes the dashboard for every agent on this machine.`;

  if (env.NAH_STUDIO_YES === "1") {
    out.write(`${c.dim(`  installing ${STUDIO_PACKAGE} with ${manager}`)}\n`);
  } else {
    const confirm = options.confirm;
    if (!confirm) {
      // No way to ask — a scripted or piped invocation. Installing on a guess is
      // the one thing this command must not do.
      out.write(`${c.dim("  no studio is installed. Run:")} ${install.command} ${install.args.join(" ")}\n`);
      return "handled";
    }
    if (!(await confirm(question))) {
      out.write(`${c.dim("  not installed")}\n`);
      return "handled";
    }
  }

  return startStudio(out, {
    command: install.command,
    // `--yes` has to be a real argument for the two managers that spell it
    // differently, and dlx is expected to be non-interactive either way.
    args: install.args,
    options,
    binaryLabel: `${STUDIO_PACKAGE}@${STUDIO_DIST_TAG}`,
    via: manager,
  });
};

/** Arguments for the Studio process. */
export const studioArgs = (cwd: string, env: NodeJS.ProcessEnv, nahBin: string | undefined = currentNahBin()): string[] => {
  const args = ["--cwd", cwd, "--port", String(env.NAH_STUDIO_PORT ?? DEFAULT_PORT)];
  // The model and the launching binary are the two things the Studio cannot work
  // out for itself, and both are cheap to pass down.
  if (env.NAH_MODEL) args.push("--model", env.NAH_MODEL);
  if (nahBin) args.push("--nah-bin", nahBin);
  return args;
};

/**
 * Spawn the Studio and wait for it to answer.
 *
 * Detached, because it has to outlive this session, and its output goes to a log
 * file rather than to the terminal: a background process sharing a TTY corrupts
 * it the moment it prints anything.
 */
const startStudio = async (
  out: NodeJS.WriteStream,
  launch: {
    command: string;
    args: string[];
    options: StudioCommandOptions;
    binaryLabel: string;
    via?: PackageManager;
  },
): Promise<"handled"> => {
  const { options } = launch;
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const spawnProcess = options.spawnProcess ?? spawn;
  const logPath = studioLogPath(home);

  await fs.mkdir(nodePath.dirname(logPath), { recursive: true, mode: 0o700 }).catch(() => undefined);
  // Truncated per start: a log of every Studio that ever ran is a log nobody
  // reads, and the interesting failure is always the last one.
  const log = await fs.open(logPath, "w", 0o600).catch(() => null);

  let child: ChildProcess;
  try {
    child = spawnProcess(launch.command, launch.args, {
      cwd: options.cwd,
      env: { ...env, NAH_STUDIO: "1" },
      // `ignore` for stdin as well: a child sharing this terminal's stdin would
      // fight the editor for every keystroke.
      stdio: ["ignore", log?.fd ?? "ignore", log?.fd ?? "ignore"],
      detached: true,
      windowsHide: true,
    });
  } catch (error) {
    out.write(`${c.red(`  could not start the studio: ${error instanceof Error ? error.message : String(error)}`)}\n`);
    return "handled";
  }

  child.unref();
  const pid = child.pid;

  out.write(`${c.dim(`  starting the studio with ${launch.binaryLabel}${launch.via ? ` via ${launch.via}` : ""}…`)}\n`);

  const endpoint = await waitForStudio(pid, options);
  await log?.close().catch(() => undefined);

  if (!endpoint) {
    out.write(`${c.red("  the studio did not come up")}\n`);
    // The reason is in the log, and printing it here is the whole point: a failed
    // install says why in a few words — unpublished, unresolvable, no such binary
    // — and none of them are guessable from "did not come up".
    const reason = await logTail(logPath);
    for (const line of reason ?? []) out.write(`  ${c.dim(line)}\n`);
    out.write(`${c.dim(`  log: ${logPath}`)}\n`);
    out.write(`${c.dim("  run it yourself to see why:")} ${launch.command} ${launch.args.join(" ")}\n`);
    return "handled";
  }

  out.write(`${c.green("  studio")} ${endpoint.url} ${c.dim("· agents in this session are traced there")}\n`);
  const opened = await (options.open ?? openUrl)(endpoint.url);
  if (!opened.opened) out.write(`  ${c.dim(`could not open a browser (${opened.reason}) — the URL is above`)}\n`);
  return "handled";
};

/**
 * Wait for the Studio to publish itself and answer.
 *
 * Polling the endpoint file rather than the process: the file is written by the
 * Studio once it is listening, so its appearance is the signal, and a child that
 * exited without publishing never produces one.
 */
const waitForStudio = async (
  pid: number | undefined,
  options: StudioCommandOptions,
): Promise<StudioEndpoint | null> => {
  const probe = options.probe ?? probeStudio;
  const home = options.home ?? os.homedir();
  const path = endpointFile(home);
  const deadline = Date.now() + (options.readyTimeoutMs ?? READY_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const endpoint = await liveEndpoint(path);
    if (endpoint && isProcessAlive(endpoint.pid)) {
      if (await probe(endpoint)) return endpoint;
    }
    // The Studio is gone and left nothing behind: stop waiting on a corpse.
    if (pid !== undefined && !isProcessAlive(pid)) {
      const stale = await readEndpoint(path);
      if (!stale) return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
};

const reportStatus = async (
  out: NodeJS.WriteStream,
  endpoint: StudioEndpoint | null,
  options: StudioCommandOptions,
): Promise<void> => {
  if (!endpoint) {
    out.write(`${c.dim("  no studio is running")}\n`);
    return;
  }
  const answering = await (options.probe ?? probeStudio)(endpoint);
  out.write(`  ${c.green("studio")} ${endpoint.url}\n`);
  out.write(`  ${c.dim(`version ${endpoint.version} · pid ${endpoint.pid} · ${answering ? "answering" : "not answering"}`)}\n`);
  if (endpoint.token) out.write(`  ${c.dim("requires NAH_STUDIO_TOKEN")}\n`);
  const telemetry = (options.env ?? process.env).NAH_TELEMETRY;
  out.write(`  ${c.dim(`telemetry from this session: ${telemetry === "off" ? "off" : "on"}`)}\n`);
};

const stopStudio = async (
  out: NodeJS.WriteStream,
  endpoint: StudioEndpoint | null,
  options: { home: string; probe?: typeof probeStudio },
): Promise<void> => {
  if (!endpoint) {
    out.write(`${c.dim("  no studio is running")}\n`);
    return;
  }
  try {
    process.kill(endpoint.pid, "SIGTERM");
  } catch (error) {
    // Already gone: the file was stale, which is the same outcome.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      out.write(`${c.red(`  could not stop pid ${endpoint.pid}: ${error instanceof Error ? error.message : String(error)}`)}\n`);
      return;
    }
  }
  // Wait for the process to actually go, so the next `/studio` does not find a
  // port still held by the one we just asked to leave.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && isProcessAlive(endpoint.pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (isProcessAlive(endpoint.pid)) {
    out.write(`${c.yellow(`  pid ${endpoint.pid} ignored SIGTERM — it is still running`)}\n`);
    return;
  }
  await clearEndpoint(endpoint.pid, endpointFile(options.home));
  out.write(`${c.green("  stopped")} ${c.dim(`· log kept at ${studioLogPath(options.home)}`)}\n`);
};

/** Does the current session report to a Studio? Used by `/telemetry` and tests. */
export const studioIsListening = async (home: string = os.homedir()): Promise<StudioEndpoint | null> => {
  const endpoint = await liveEndpoint(endpointFile(home));
  if (!endpoint) return null;
  return (await probeStudio(endpoint)) ? endpoint : null;
};
