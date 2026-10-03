/**
 * Reporting to a Studio.
 *
 * The interesting parts are all about not breaking the thing being debugged: the
 * tee must hand the UI exactly the events it would have seen, a Studio that is
 * gone must be silent, and `NAH_TELEMETRY=off` must mean off. Everything else is
 * plumbing.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HarnessEvent } from "not-another-harness";
import {
  connectStudio,
  createStudioSink,
  describeAgent,
  teeEvents,
  telemetryState,
  traceTurn,
  type StudioTelemetry,
} from "../src/telemetry-export.js";

/**
 * A run shaped like the ones the engine emits, including a tool call.
 *
 * Borrowed from the engine's own telemetry tests rather than invented: an event
 * the recorder does not expect is a recorder that quietly records nothing, and
 * that failure looks exactly like "the studio is not receiving telemetry".
 */
const turn = (): HarnessEvent[] =>
  [
    { type: "run-start", stepBudget: null, tokenBudget: 400_000 },
    { type: "step-start", step: 1 },
    { type: "text-delta", step: 1, text: "working" },
    { type: "tool-call", step: 1, toolCallId: "t1", toolName: "read", input: { path: "src/a.ts" } },
    { type: "tool-result", step: 1, toolCallId: "t1", toolName: "read", output: "file contents", isError: false },
    {
      type: "step-finish",
      step: 1,
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      request: { totalInputTokens: 1000, freshInputTokens: 1000, cachedInputTokens: 0 },
    },
    { type: "finish", reason: "completed", text: "working", usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
  ] as unknown as HarnessEvent[];

/** An async iterable over a fixed list, like the harness's own event stream. */
async function* stream(events: HarnessEvent[]): AsyncIterable<HarnessEvent> {
  for (const event of events) yield event;
}

const tempHome = (): string => mkdtempSync(join(tmpdir(), "nah-telemetry-"));

describe("the tee", () => {
  it("gives both readers every event, in order", async () => {
    const events = turn();
    const { a, b } = teeEvents(stream(events));
    const [left, right] = await Promise.all([
      (async () => {
        const seen: string[] = [];
        for await (const event of a) seen.push(event.type);
        return seen;
      })(),
      (async () => {
        const seen: string[] = [];
        for await (const event of b) seen.push(event.type);
        return seen;
      })(),
    ]);
    // The harness's queue is destructive: a second reader takes events from the
    // first rather than seeing the same ones. Which is why this cannot be a
    // generator that two loops share.
    expect(left).toEqual(events.map((event) => event.type));
    expect(right).toEqual(events.map((event) => event.type));
  });

  it("replays a failure to both readers", async () => {
    const failing = async function* (): AsyncIterable<HarnessEvent> {
      yield turn()[0]!;
      throw new Error("stream broke");
    };
    const { a, b } = teeEvents(failing());
    const read = async (source: AsyncIterable<HarnessEvent>): Promise<string[]> => {
      const seen: string[] = [];
      try {
        for await (const event of source) seen.push(event.type);
      } catch (error) {
        seen.push(`error:${error instanceof Error ? error.message : ""}`);
      }
      return seen;
    };
    expect(await read(a)).toEqual(["run-start", "error:stream broke"]);
    expect(await read(b)).toEqual(["run-start", "error:stream broke"]);
  });
});

describe("the sink", () => {
  const agent = describeAgent({ cwd: "/repo", env: {}, id: "ag_test" });

  it("posts one finished trace with its spans, to the ingest endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const sink = createStudioSink(
      { url: "http://127.0.0.1:4111", pid: 1, startedAt: 0, version: "1", token: "shared" },
      agent,
      {
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          calls.push({ url: String(url), init: init ?? {} });
          return new Response("{}", { status: 200 });
        }) as typeof fetch,
      },
    );

    sink.emit({ id: "s1", traceId: "t1", parentId: null, name: "run", kind: "agent", startTime: 1, endTime: 2, status: "ok", attributes: {}, metadata: {} });
    sink.emit({ id: "s2", traceId: "t1", parentId: "s1", name: "tool: read", kind: "tool", startTime: 1, endTime: 2, status: "ok", attributes: {}, metadata: {} });
    await sink.flush({
      id: "t1",
      name: "run",
      startTime: 1,
      endTime: 2,
      rootSpanId: "s1",
      status: "ok",
      tags: [],
      metadata: {},
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:4111/api/traces");
    // The token travels with it: a Studio on the network refuses everything else.
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer shared");
    const body = JSON.parse(String(calls[0]!.init.body)) as { agent: { id: string }; spans: unknown[] };
    expect(body.agent.id).toBe("ag_test");
    expect(body.spans).toHaveLength(2);
  });

  it("is silent when the studio is not there", async () => {
    const sink = createStudioSink(
      { url: "http://127.0.0.1:4111", pid: 1, startedAt: 0, version: "1" },
      agent,
      {
        fetchImpl: (async () => {
          throw new Error("ECONNREFUSED");
        }) as typeof fetch,
      },
    );
    // A dashboard that is not listening is the normal case, not a failure: the
    // turn must finish exactly as it would have.
    await expect(
      sink.flush({ id: "t1", name: "run", startTime: 1, endTime: 2, rootSpanId: "s1", status: "ok", tags: [], metadata: {} }),
    ).resolves.toBeUndefined();
    await expect(sink.settled()).resolves.toBeUndefined();
  });

  it("warns about a token the studio rejects, rather than failing the turn", async () => {
    const warn = vi.fn();
    // A `warning` listener rather than a spy: `emitWarning` is a call, not an
    // event, and it delivers on the next tick.
    process.on("warning", warn);
    try {
      const sink = createStudioSink(
        { url: "http://127.0.0.1:4111", pid: 1, startedAt: 0, version: "1", token: "wrong" },
        agent,
        { fetchImpl: (async () => new Response("{}", { status: 401 })) as typeof fetch },
      );
      await sink.flush({ id: "t1", name: "run", startTime: 1, endTime: 2, rootSpanId: "s1", status: "ok", tags: [], metadata: {} });
      await new Promise((resolve) => setImmediate(resolve));
      // An auth failure is the one case worth surfacing: nothing can retry it, and
      // silence here looks exactly like a Studio that is not listening.
      expect(warn).toHaveBeenCalled();
      expect((warn.mock.calls[0]?.[0] as Error).message).toContain("rejected this session's token");
    } finally {
      process.off("warning", warn);
    }
  });
});

describe("tracing a turn", () => {
  /** A Studio that records what it was sent, standing in for the real one. */
  const fakeStudio = (): { studio: StudioTelemetry; posted: Array<Record<string, unknown>> } => {
    const posted: Array<Record<string, unknown>> = [];
    const agent = describeAgent({ cwd: "/repo", env: {}, id: "ag_test" });
    const endpoint = { url: "http://127.0.0.1:4111", pid: 1, startedAt: 0, version: "1" };
    const sink = createStudioSink(endpoint, agent, {
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    return { studio: { sink, agent, endpoint, settled: () => sink.settled() }, posted };
  };

  it("records the run without changing what the caller sees", async () => {
    const { studio, posted } = fakeStudio();
    const events = turn();
    const seen: string[] = [];

    const traced = traceTurn(studio, stream(events), { prompt: "do the thing", model: "anthropic:claude-sonnet-4-5" });
    for await (const event of traced) seen.push(event.type);

    // The UI gets the stream untouched — this is the same iteration the session
    // would have done with no studio anywhere.
    expect(seen).toEqual(events.map((event) => event.type));

    // A process about to exit waits for this; that is what makes one-shot mode
    // report at all.
    await studio.settled();
    expect(posted).toHaveLength(1);
    const body = posted[0]!;
    expect((body.trace as { tags: string[] }).tags).toContain("studio");
    expect((body.agent as { id: string }).id).toBe("ag_test");
    expect((body.spans as unknown[]).length).toBeGreaterThan(0);
  });

  it("reports a turn that failed, which is the one worth having", async () => {
    const { studio, posted } = fakeStudio();
    // How the engine actually fails: an `error` event, then a `finish`, then the
    // queue closes. A stream that throws instead is a case the engine does not
    // produce, and the recorder cannot close a trace it was never given.
    const failing = [
      ...turn().slice(0, 2),
      { type: "error", error: new Error("the provider went away") },
      { type: "finish", reason: "error", text: "", usage: { inputTokens: 100, outputTokens: 0, totalTokens: 100 } },
    ] as unknown as HarnessEvent[];
    const traced = traceTurn(studio, stream(failing), { prompt: "do the thing" });
    for await (const _event of traced) void _event;
    await studio.settled();

    expect(posted).toHaveLength(1);
    const trace = posted[0]!.trace as { status: string; error?: { message: string } };
    expect(trace.status).toBe("error");
    expect(trace.error?.message).toContain("the provider went away");
  });
});

describe("announcing an agent", () => {
  /** A home directory with a Studio published in it, i.e. a session that can report. */
  const withStudio = async (fetchImpl: typeof fetch): Promise<string> => {
    const home = tempHome();
    mkdirSync(join(home, ".nah"), { recursive: true });
    writeFileSync(
      join(home, ".nah", "studio.json"),
      JSON.stringify({ url: "http://127.0.0.1:4111", pid: process.pid, startedAt: 1, version: "1.0.0" }),
    );
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      await connectStudio({ cwd: "/repo", env: process.env, model: "openai:gpt-5", fetchImpl });
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
    }
    return home;
  };

  it("says hello when it attaches, not on its first finished turn", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    await withStudio((async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response("{}", { status: 200 });
    }) as typeof fetch);

    const registration = calls.find((call) => call.url.endsWith("/api/agents"));
    // Without this, the dashboard lists the sessions that have recently finished
    // something rather than the ones that are open — and an agent sitting at a
    // prompt, which is most of them, is invisible.
    expect(registration).toBeDefined();
    expect(registration!.body).toMatchObject({ name: "repo", cwd: "/repo", model: "openai:gpt-5", source: "session" });
  });

  it("does not care whether the Studio answers", async () => {
    // A session must not fail to start because a dashboard is not listening, and
    // must not print an error about it either: the endpoint file said there was
    // one, and there is not.
    await expect(
      withStudio((async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch),
    ).resolves.toBeDefined();
  });
});

describe("opting out", () => {
  it("is on unless something says otherwise", async () => {
    const previous = process.env.HOME;
    process.env.HOME = tempHome();
    try {
      expect(await telemetryState({})).toBe("on");
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
    }
  });

  it("honours the environment over a remembered preference", async () => {
    expect(await telemetryState({ NAH_TELEMETRY: "off" })).toBe("off");
    expect(await telemetryState({ NAH_TELEMETRY: "0" })).toBe("off");
    expect(await telemetryState({ NAH_TELEMETRY: "on" })).toBe("on");
  });

  it("connects to nothing when there is no studio file", async () => {
    const previous = process.env.HOME;
    process.env.HOME = tempHome();
    try {
      // No file, so no telemetry — the opt-in is the studio publishing itself.
      expect(await connectStudio({ cwd: "/repo", env: process.env })).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
    }
  });
});

describe("identity", () => {
  it("names an agent after its directory, and one launched by the studio after its row", () => {
    expect(describeAgent({ cwd: "/Users/x/code/astracollab", env: {} }).name).toBe("astracollab");
    expect(describeAgent({ cwd: "/repo", env: { NAH_AGENT_NAME: "reviewer" } }).name).toBe("reviewer");
  });

  it("gives every process its own id", () => {
    // Two sessions in one repository are two agents; a dashboard that cannot tell
    // them apart cannot answer "is anything running right now".
    expect(describeAgent({ cwd: "/repo", env: {} }).id).not.toBe(describeAgent({ cwd: "/repo", env: {} }).id);
  });
});