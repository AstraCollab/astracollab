/**
 * Starting a Studio.
 *
 * Three things are wired together here and nowhere else, which is the whole
 * reason this file exists: the assembled agent (prompts, tools, permissions), the
 * tracer that records what it does, and the store the UI reads.
 *
 * The agent comes from `nah` itself rather than being assembled here. The Studio
 * answers "what did my agent do", and an agent assembled by a second copy of this
 * code would be a different agent with a different prompt and different tools —
 * so the CLI exports one read-only build of itself and the dashboard runs that.
 * A run per request, though, because an HTTP request has no transcript to inherit
 * and a turn carrying the previous one's history could answer a question about a
 * file it never read.
 */
import { createReadonlyAgent, type StudioAgent } from "nah-ai/agent";
import * as os from "node:os";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { StudioStore } from "./store.js";
import { clearEndpoint, writeEndpoint, type StudioEndpoint } from "./endpoint.js";
import { resolveNahBinary, type Launcher } from "./launcher.js";
import { registerBuiltinScorers, registeredScorers, startStudioServer, type StudioHandle } from "./server.js";

// Inlined at build time by vite define, so the published binary does not have to
// read its own package.json to say which version it is.
declare const __NAH_STUDIO_VERSION__: string;

const defaultStorePath = (): string => nodePath.join(os.homedir(), ".nah", "studio", "studio.sqlite");

export type ServeOptions = {
  cwd: string;
  port?: number;
  host?: string;
  /** Studio database. Defaults to ~/.nah/studio/studio.sqlite. */
  dbPath?: string;
  model?: string;
  /** Shared secret required on every request. Set it before binding 0.0.0.0. */
  token?: string;
  /** The `nah` to launch agents with. Resolved from PATH when absent. */
  nahBin?: string;
  /** Do not publish `~/.nah/studio.json`, so no agent finds this Studio. */
  noPublish?: boolean;
  out?: NodeJS.WriteStream;
  /** Injected in tests. */
  createAgent?: (options: { cwd: string; model?: string }) => Promise<StudioAgent>;
};

export type ServeRun = {
  output: string;
  toolsCalled: string[];
  filesChanged: string[];
  traceId?: string;
};

export const runServe = async (options: ServeOptions): Promise<StudioHandle> => {
  const out = options.out ?? process.stdout;
  const token = options.token ?? process.env.NAH_STUDIO_TOKEN;
  const store = new StudioStore({ path: options.dbPath ?? defaultStorePath() });

  registerBuiltinScorers();
  for (const [id, scorer] of registeredScorers) {
    store.saveScorer({
      id,
      name: scorer.name,
      ...(scorer.description === undefined ? {} : { description: scorer.description }),
      kind: scorer.kind,
    });
  }

  const createAgent = options.createAgent ?? createReadonlyAgent;
  // Resolved once and reused: the model object is stateless, and a per-request
  // keychain read would make the chat tab slower for no reason. A failure here is
  // reported in the banner, where the user can act on it, rather than as a 500
  // per keystroke.
  const agent = await createAgent({
    cwd: options.cwd,
    ...(options.model === undefined ? {} : { model: options.model }),
  });

  const execute = async (prompt: string): Promise<ServeRun> => {
    const run = await agent.run(prompt);
    if (run.trace) store.saveTrace(run.trace, run.spans);
    return {
      output: run.text,
      toolsCalled: run.toolsCalled,
      filesChanged: run.filesChanged,
      ...(run.trace ? { traceId: run.trace.id } : {}),
    };
  };

  const launcher: Launcher | null = resolveNahBinary(options.nahBin);

  const handle = await startStudioServer({
    store,
    // One level under the bundle, not two: the shipped artifact is `dist/cli.js`,
    // so `import.meta.url` resolves inside `dist` and `dist/ui` is where the
    // second Vite pass puts the UI. Running from source (vitest) has no dist to
    // speak of, which is why every caller that cares passes its own.
    assetDir: nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "ui"),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(launcher === null ? {} : { launcher }),
    cwd: options.cwd,
    execute,
    ...(token === undefined ? {} : { token }),
  });

  if (!options.noPublish) {
    const endpoint: StudioEndpoint = {
      url: handle.url,
      ...(token === undefined ? {} : { token }),
      pid: process.pid,
      startedAt: Date.now(),
      version: typeof __NAH_STUDIO_VERSION__ === "string" ? __NAH_STUDIO_VERSION__ : "0.0.0",
      ...(options.nahBin === undefined ? {} : { nahBin: options.nahBin }),
      cwd: options.cwd,
    };
    await writeEndpoint(endpoint);

    // Removed by `close`, which is awaited: an `exit` handler cannot finish an
    // async write, so a file left behind that way outlives the Studio and leaves
    // every agent on the machine aiming at a port nobody is listening on. This
    // handler stays as a backstop for an exit that skips `close` — a crash, say.
    process.once("exit", () => {
      void clearEndpoint(process.pid);
    });
    const close = handle.close.bind(handle);
    handle.close = async () => {
      await close();
      await clearEndpoint(process.pid).catch(() => undefined);
    };
  }

  out.write(`nah studio → ${handle.url}\n`);
  out.write(`  watching agents; every nah session on this machine can report to it\n`);
  out.write(`  agents:  ${agent.model ?? "no model configured — the chat tab and evals are unavailable"}\n`);
  out.write(`  launch:  ${launcher?.command ?? "no nah binary found — the Studio cannot start agents"}\n`);
  out.write(`  store:   ${options.dbPath ?? defaultStorePath()}\n`);
  if (launcher) {
    out.write(`  the built-in agent runs read-only; mutating tools are refused\n`);
  }
  if (token) {
    out.write("  every request needs NAH_STUDIO_TOKEN\n");
  } else {
    out.write(
      "  bound to loopback with no token. Set NAH_STUDIO_TOKEN before binding 0.0.0.0 —\n" +
        "  this store holds prompts, file paths and tool output.\n",
    );
  }
  out.write("  ctrl-c to stop\n");
  return handle;
};
