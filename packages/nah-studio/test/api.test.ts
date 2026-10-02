/**
 * The agent-facing half of the API.
 *
 * What an agent is allowed to do, what it is told, and what happens when the
 * stream it is watching drops. The security cases are here too, because "accepts
 * telemetry from other processes" is a door, and a door needs to know who is
 * knocking.
 */
import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";
import { StudioStore } from "../src/store.js";
import { startStudioServer, type StudioHandle } from "../src/server.js";
import { createStreamHub } from "../src/stream.js";
import { resolveNahBinary, launchArgs, type Launcher } from "../src/launcher.js";
import type { Span, Trace } from "../src/wire.js";

const trace = (over: Partial<Trace> = {}): Trace => ({
  id: "t1",
  name: "a run",
  startTime: 1_000,
  endTime: 4_000,
  rootSpanId: "s1",
  status: "ok",
  tags: [],
  metadata: {},
  ...over,
});

const span = (over: Partial<Span> = {}): Span => ({
  id: "s1",
  traceId: "t1",
  parentId: null,
  name: "a run",
  kind: "agent",
  startTime: 1_000,
  endTime: 4_000,
  status: "ok",
  attributes: {},
  metadata: {},
  ...over,
});

/** A server with a fresh in-memory store, plus a request helper. */
const withServer = async (
  options: { launcher?: Launcher } = {},
  run: (url: string, store: StudioStore) => Promise<void>,
): Promise<void> => {
  const store = new StudioStore({ path: ":memory:" });
  const handle: StudioHandle = await startStudioServer({
    store,
    port: 0,
    host: "127.0.0.1",
    ...(options.launcher ? { launcher: options.launcher } : {}),
  });
  try {
    await run(handle.url, store);
  } finally {
    await handle.close();
  }
};

/** Enough of a ServerResponse for the hub: headers, a write, and close. */
const fakeClient = (): {
  written: string[];
  throwOnWrite: boolean;
  writeHead: (status: number, headers: Record<string, string>) => void;
  write: (chunk: string) => void;
  end: () => void;
  emit: (event: string) => void;
} => {
  const emitter = new EventEmitter();
  const client = {
    written: [] as string[],
    throwOnWrite: false,
    writeHead: () => undefined,
    write: (chunk: string) => {
      if (client.throwOnWrite) throw new Error("socket closed");
      client.written.push(chunk);
    },
    end: () => undefined,
    emit: (event: string) => emitter.emit(event),
  };
  (client as unknown as { on: EventEmitter["on"] }).on = emitter.on.bind(emitter);
  return client;
};

const post = async (url: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("an agent registering itself", () => {
  it("is answered with its own row, so it can put its next trace somewhere", async () => {
    await withServer({}, async (url) => {
      const response = await post(url, "/api/agents", {
        name: "reviewer",
        cwd: "/repo",
        model: "anthropic:claude-sonnet-4-5",
        version: "0.0.1-beta.1",
        pid: 4242,
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean; agent: { id: string; name: string; status: string } };
      expect(body.ok).toBe(true);
      expect(body.agent.name).toBe("reviewer");
      expect(body.agent.status).toBe("starting");
    });
  });

  it("is idempotent, because a client cannot know whether this is a Studio it has met", async () => {
    await withServer({}, async (url, store) => {
      const body = { id: "ag_fixed", cwd: "/repo", name: "reviewer" };
      await post(url, "/api/agents", body);
      await post(url, "/api/agents", body);
      await post(url, "/api/agents", body);
      expect(store.listAgents()).toHaveLength(1);
    });
  });

  it("is refused without a directory to work in", async () => {
    await withServer({}, async (url) => {
      const body = (await (await post(url, "/api/agents", { name: "nameless" })).json()) as { error: string };
      expect(body.error).toContain("cwd");
    });
  });
});

describe("an agent pushing a trace", () => {
  it("is attributed to the agent that sent it", async () => {
    await withServer({}, async (url, store) => {
      const response = await post(url, "/api/traces", {
        agent: { id: "ag_one", cwd: "/repo", name: "reviewer" },
        trace: trace(),
        spans: [span()],
      });
      const body = (await response.json()) as { ok: boolean; agentId: string };
      expect(body.ok).toBe(true);
      expect(store.listTraces({ agentId: body.agentId })).toHaveLength(1);
      // And the agent is now known to be running, because a trace is proof of life.
      expect(store.getAgent(body.agentId)?.status).toBe("running");
    });
  });

  it("registers an agent that pushes a trace without announcing itself", async () => {
    await withServer({}, async (url, store) => {
      await post(url, "/api/traces", { agent: { cwd: "/repo" }, trace: trace(), spans: [span()] });
      expect(store.listAgents()).toHaveLength(1);
    });
  });

  it("still records a trace with no agent at all, which is the built-in agent", async () => {
    await withServer({}, async (url, store) => {
      await post(url, "/api/traces", { trace: trace(), spans: [span()] });
      expect(store.listTraces()).toHaveLength(1);
      expect(store.listAgents()).toHaveLength(0);
    });
  });

  it("is answered with something useful when the payload is wrong", async () => {
    await withServer({}, async (url) => {
      const body = (await (await post(url, "/api/traces", { trace: trace() })).json()) as { error: string };
      expect(body.error).toContain("spans");
    });
  });

  it("replaces a trace it has already seen rather than listing it twice", async () => {
    await withServer({}, async (url, store) => {
      const payload = { trace: trace(), spans: [span()] };
      await post(url, "/api/traces", payload);
      await post(url, "/api/traces", payload);
      expect(store.listTraces()).toHaveLength(1);
    });
  });
});

describe("the live stream", () => {
  /**
   * Read `text/event-stream` frames off a response.
   *
   * A plain `fetch` with a reader rather than a WebSocket client: the frames are
   * named, and the assertion that matters is that a named frame arrives at all —
   * a UI listening on the default message event would silently get nothing.
   */
  const frames = async (
    url: string,
    read: (events: string[]) => boolean,
    timeoutMs = 3_000,
  ): Promise<string[]> => {
    const response = await fetch(`${url}/api/stream`);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const events: string[] = [];
    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const frame of chunk.split("\n\n")) {
          if (frame.startsWith("event:")) events.push(frame.trim());
        }
        if (read(events)) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return events;
  };

  const hasEvent = (type: string) => (events: string[]): boolean =>
    events.some((frame) => frame.startsWith(`event: ${type}`));

  it("opens with the agents it already knows", async () => {
    await withServer({}, async (url, store) => {
      store.registerAgent({ id: "ag_a", cwd: "/repo", name: "reviewer" });
      const events = await frames(url, hasEvent("hello"));
      expect(events.some((frame) => frame.includes('"reviewer"'))).toBe(true);
    });
  });

  it("pushes an agent and a trace as they happen", async () => {
    await withServer({}, async (url) => {
      const reading = frames(url, (events) => hasEvent("trace")(events) && events.some((frame) => frame.includes("a run")));
      // Give the stream a moment to attach before writing, or the first event is
      // seen by nobody — which is the same as not being pushed at all.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await post(url, "/api/agents", { id: "ag_a", cwd: "/repo" });
      await post(url, "/api/traces", { agent: { id: "ag_a", cwd: "/repo" }, trace: trace(), spans: [span()] });
      const events = await reading;
      expect(events.some((frame) => frame.startsWith("event: agent"))).toBe(true);
      expect(events.some((frame) => frame.startsWith("event: trace"))).toBe(true);
    });
  });

  it("pushes an agent's output as it is printed", async () => {
    await withServer({}, async (url, store) => {
      const reading = frames(url, hasEvent("log"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      store.appendAgentLog("ag_a", { stream: "stdout", text: "hello from the agent" });
      const events = await reading;
      expect(events.some((frame) => frame.includes("hello from the agent"))).toBe(true);
    });
  });

  it("stops writing to a client that has gone, rather than holding it open", async () => {
    const store = new StudioStore({ path: ":memory:" });
    const hub = createStreamHub(store, { livenessMs: 30_000 });
    try {
      const client = fakeClient();
      hub.add(client as never);
      expect(hub.size()).toBe(1);

      store.appendAgentLog("ag_a", { stream: "stdout", text: "while you were here" });
      expect(client.written.join("")).toContain("while you were here");

      // A closed tab: the hub drops it and unsubscribes, so an idle Studio goes
      // back to doing nothing rather than accumulating dead sockets.
      client.emit("close");
      expect(hub.size()).toBe(0);
      const before = client.written.length;
      store.appendAgentLog("ag_a", { stream: "stdout", text: "after you left" });
      expect(client.written).toHaveLength(before);
    } finally {
      hub.close();
    }
  });

  it("answers a client that disappears mid-write without failing the writer", () => {
    const store = new StudioStore({ path: ":memory:" });
    const hub = createStreamHub(store, { livenessMs: 30_000 });
    try {
      const client = fakeClient();
      client.throwOnWrite = true;
      // A browser that disconnected between the socket opening and the first
      // frame: the request ends instead of throwing out through the server.
      expect(() => hub.add(client as never)).not.toThrow();
      expect(hub.size()).toBe(0);
      // And a watcher that has gone must not be able to turn a completed run into
      // an error for the agent that produced it.
      expect(() => store.appendAgentLog("ag_a", { stream: "stdout", text: "boom" })).not.toThrow();
    } finally {
      hub.close();
    }
  });
});

describe("starting an agent", () => {
  it("says so plainly when there is no nah binary to start", async () => {
    await withServer({}, async (url) => {
      const body = (await (await post(url, "/api/agents/launch", { cwd: "/repo", prompt: "go" })).json()) as {
        error: string;
      };
      expect(body.error).toContain("no nah binary");
    });
  });

  it("wants both a directory and a task", async () => {
    await withServer({ launcher: { command: "/bin/true", prefixArgs: [], label: "true" } }, async (url) => {
      expect(((await (await post(url, "/api/agents/launch", { prompt: "go" })).json()) as { error: string }).error).toContain(
        "cwd",
      );
      expect(
        ((await (await post(url, "/api/agents/launch", { cwd: "/repo" })).json()) as { error: string }).error,
      ).toContain("prompt");
    });
  });

  it("spawns the real thing and records what it printed", async () => {
    // A child that behaves like an agent: it prints, then exits non-zero because
    // there are no credentials here — which is exactly the case worth seeing in
    // the log rather than in a stack trace on the server.
    const launcher: Launcher = { command: "/bin/sh", prefixArgs: ["-c"], label: "sh -c" };
    await withServer({ launcher }, async (url, store) => {
      const body = (await (
        await post(url, "/api/agents/launch", { cwd: "/tmp", name: "checker", prompt: "go" })
      ).json()) as { ok: boolean; agent: { id: string } };
      expect(body.ok).toBe(true);

      const agentId = body.agent.id;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && store.getAgent(agentId)?.status === "running") {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const agent = store.getAgent(agentId);
      expect(agent?.name).toBe("checker");
      expect(agent?.source).toBe("launch");
      expect(["exited", "failed"]).toContain(agent?.status);
      // The reason is in the log, which is where someone looks after a launch that
      // did not do what they expected.
      expect(store.listAgentLogs(agentId).length).toBeGreaterThan(0);
    });
  });

  it("refuses to stop an agent it did not start", async () => {
    await withServer({ launcher: { command: "/bin/true", prefixArgs: [], label: "true" } }, async (url, store) => {
      const agent = store.registerAgent({ id: "ag_mine", cwd: "/repo", source: "session" });
      const body = (await (await post(url, `/api/agents/${agent.id}/stop`, {})).json()) as { ok: boolean; error: string };
      // A browser button is not consent to kill somebody's terminal.
      expect(body.ok).toBe(false);
      expect(body.error).toContain("outside the Studio");
    });
  });

  it("refuses to stop an agent on another machine", async () => {
    await withServer({ launcher: { command: "/bin/true", prefixArgs: [], label: "true" } }, async (url, store) => {
      const agent = store.registerAgent({ id: "ag_theirs", cwd: "/repo", source: "launch", host: "another-host" });
      const body = (await (await post(url, `/api/agents/${agent.id}/stop`, {})).json()) as { error: string };
      expect(body.error).toContain("another-host");
    });
  });
});

describe("choosing what to launch", () => {
  it("runs the build that recorded it, through node when it is a script", () => {
    // A recorded path ending in .js is what argv[1] looks like for a checkout or
    // an npx run, and depending on the file's executable bit would fail on both.
    const script = resolveNahBinary("/repo/packages/nah/dist/cli.js", { execPath: "/usr/local/bin/node" });
    expect(script).toMatchObject({ command: "/usr/local/bin/node", prefixArgs: ["/repo/packages/nah/dist/cli.js"] });

    const binary = resolveNahBinary("/usr/local/bin/nah", { execPath: "/usr/local/bin/node" });
    expect(binary).toMatchObject({ command: "/usr/local/bin/nah", prefixArgs: [] });
  });

  it("falls back to whatever nah is on PATH", () => {
    const found = resolveNahBinary(undefined, { which: (command) => (command === "nah" ? "/opt/bin/nah" : undefined) });
    expect(found?.command).toBe("/opt/bin/nah");
    expect(resolveNahBinary(undefined, { which: () => undefined })).toBeNull();
  });

  it("gives a headless agent machine-readable output", () => {
    // `--mode json`, because this process has no TTY: the pretty renderer would
    // have nothing to render into and the agent's reasoning would be invisible.
    expect(launchArgs({ prompt: "check the tests", model: "openai:gpt-5", permissions: "readonly" })).toEqual([
      "--mode",
      "json",
      "--model",
      "openai:gpt-5",
      "--permissions",
      "readonly",
      "check the tests",
    ]);
    expect(launchArgs({ prompt: "just do it" })).toEqual(["--mode", "json", "just do it"]);
  });
});

describe("who may talk to this studio", () => {
  it("refuses a request without the token when one is set", async () => {
    const store = new StudioStore({ path: ":memory:" });
    const handle = await startStudioServer({ store, port: 0, host: "127.0.0.1", token: "shared" });
    try {
      expect((await fetch(`${handle.url}/api/agents`)).status).toBe(401);
      const allowed = await fetch(`${handle.url}/api/agents`, { headers: { authorization: "Bearer shared" } });
      expect(allowed.status).toBe(200);
      // The stream is reachable with the token too, or the dashboard's live view
      // is the one thing that needs a page reload.
      const streamed = await fetch(`${handle.url}/api/stream`, { headers: { authorization: "Bearer shared" } });
      expect(streamed.status).toBe(200);
      await streamed.body?.cancel();
      // And in the query string, because EventSource cannot set a header.
      expect((await fetch(`${handle.url}/api/agents?token=shared`)).status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it("reports itself, so the dashboard can be honest about what it is", async () => {
    await withServer({ launcher: { command: "/usr/local/bin/nah", prefixArgs: [], label: "nah" } }, async (url) => {
      const body = (await (await fetch(`${url}/api/info`)).json()) as {
        service: string;
        version: string;
        launcher: { available: boolean; command: string | null };
      };
      expect(body.service).toBe("nah-studio");
      expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(body.launcher).toEqual({ available: true, command: "nah" });
    });
  });
});

describe("a server that is closing", () => {
  it("lets go of its streams, so a dashboard left open cannot hold the port", async () => {
    const store = new StudioStore({ path: ":memory:" });
    const handle = await startStudioServer({ store, port: 0, host: "127.0.0.1" });
    const response = await fetch(`${handle.url}/api/stream`);
    const reader = response.body!.getReader();
    const attached = (async () => {
      while (true) {
        const { done } = await reader.read();
        if (done) return "closed";
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 50));
    await handle.close();
    // Without ending the streams, `server.close` waits for them forever.
    expect(await Promise.race([attached, new Promise((resolve) => setTimeout(() => resolve("hung"), 2_000))])).toBe(
      "closed",
    );
  });
});

/** Keeps the linter honest about the unused import when the emitter changes. */
export type { EventEmitter };