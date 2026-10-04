import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hostedMemory } from "../src/memory-hosted.js";
import { localMemory } from "../src/memory-backend.js";
import { CognitiveMemory } from "not-another-harness";

/**
 * The hosted backend, over a stubbed transport.
 *
 * The behaviour worth testing is not the HTTP — that is the SDK's, and it has its
 * own tests. It is what this adapter does with a failure and with a response,
 * because the hosted backend sits in front of a turn the user is waiting on: a
 * thrown error here is a failed turn, and a silently-empty result is memory that
 * looks broken rather than unavailable.
 */

type Route = (url: string, init: RequestInit | undefined) => unknown;

let routes: Map<string, Route>;
let calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }>;

/**
 * A real `Response`, because the SDK reads the error envelope off one.
 *
 * A hand-rolled `{status, _data}` object is not enough: ofetch parses the body
 * and copies it onto the response, and the adapter's 401/403/404 handling is
 * built on that. Stubbing with something else would test a transport that does
 * not exist.
 */
const respond = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Install a fetch that answers only the paths a test declares. */
const stubFetch = () => {
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    // ofetch hands fetch a Headers instance by this point, not a plain object.
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    calls.push({
      url: href,
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers,
    });
    const route = routes.get(`${method} ${href.replace(/^https?:\/\/[^/]+/, "")}`) ?? routes.get(href);
    if (!route) throw new Error(`unstubbed route: ${method} ${href}`);
    const result = route(href, init);
    if (result instanceof Error) throw result;
    // A route may return a body to be wrapped, or a whole Response when it needs
    // to control the status itself.
    return result instanceof Response ? result : respond(result);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const BASE = "https://cogmem.example";

beforeEach(() => {
  routes = new Map();
  calls = [];
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const contextReport = (over: Record<string, unknown> = {}) => ({
  text: "## Cognitive Memory State\n### Memory index\n- staging build ID\n",
  entries: [
    { id: "m1", tier: "L1", reason: "index", gist: "staging build ID", tokens: 6 },
    { id: "m2", tier: "L1", reason: "trigger", gist: "host", body: "the internal host", tokens: 9 },
  ],
  totalTokens: 15,
  truncated: false,
  ...over,
});

describe("hosted planInjection", () => {
  it("maps a context report onto the local report shape", async () => {
    routes.set("POST /api/v1/context", () => contextReport());
    const memory = hostedMemory({ apiKey: "key-123", baseUrl: BASE });

    const report = await memory.planInjection({ userMessage: "what about ZQ7X4M2K?" });

    expect(report.totalTokens).toBe(15);
    expect(report.truncated).toBe(false);
    expect(report.entries.map((e) => e.reason)).toEqual(["index", "trigger"]);
    // Absent body stays absent, rather than becoming an empty string that would
    // render as a blank line in the index.
    expect(report.entries[0]!.body).toBeUndefined();
    expect(report.entries[1]!.body).toBe("the internal host");
    expect(memory.degraded).toBeNull();
  });

  it("sends the user message and the forced ids", async () => {
    routes.set("POST /api/v1/context", () => contextReport());
    const memory = hostedMemory({ apiKey: "key-123", baseUrl: BASE });

    await memory.planInjection({ userMessage: "the host?", forceFull: ["m2", "m7"] });

    const call = calls.find((c) => c.url.endsWith("/context"));
    expect(call?.body).toEqual({ userMessage: "the host?", forceFull: ["m2", "m7"] });
    expect(call?.headers.authorization).toBe("Bearer key-123");
  });

  it("returns an empty block and keeps the turn alive when the service is down", async () => {
    routes.set("POST /api/v1/context", () => new Error("fetch failed"));
    const memory = hostedMemory({ apiKey: "key-123", baseUrl: BASE });

    const report = await memory.planInjection({ userMessage: "hello" });

    // The turn proceeds; it just has no memory in it.
    expect(report).toEqual({ text: "", entries: [], totalTokens: 0, truncated: false });
    expect(memory.degraded).toMatch(/could not reach the service/);
  });

  it("says a rejected key is a rejected key, not an empty cache", async () => {
    routes.set("POST /api/v1/context", () => respond({ error: "Unauthorized", message: "bad key" }, 401));
    const memory = hostedMemory({ apiKey: "wrong", baseUrl: BASE });

    await memory.planInjection({});

    expect(memory.degraded).toMatch(/rejected the API key/);
    expect(memory.degraded).toMatch(/\/cogmem key/);
  });

  it("names the missing scope on a 403", async () => {
    routes.set("POST /api/v1/context", () =>
      respond({ error: "Forbidden", message: "nope", requiredScope: "memories:read" }, 403),
    );
    const memory = hostedMemory({ apiKey: "key-123", baseUrl: BASE });

    await memory.planInjection({});

    expect(memory.degraded).toMatch(/memories:read/);
  });

  it("clears the warning once a call succeeds again", async () => {
    let fail = true;
    routes.set("POST /api/v1/context", () => (fail ? new Error("fetch failed") : contextReport()));
    const memory = hostedMemory({ apiKey: "key-123", baseUrl: BASE });

    await memory.planInjection({});
    expect(memory.degraded).not.toBeNull();

    fail = false;
    const report = await memory.planInjection({});
    expect(report.entries).toHaveLength(2);
    // A blip should not leave a permanent "degraded" badge on a working backend.
    expect(memory.degraded).toBeNull();
  });
});

describe("hosted search", () => {
  it("converts service rows into engine items", async () => {
    routes.set("POST /api/v1/recall", () => ({
      results: [
        {
          memory: {
            id: "srv-1",
            content: "The staging build ID is ZQ7X4M2K.",
            gist: "staging build ID",
            tier: "L1",
            domains: ["deployment"],
            accessCount: 2,
            createdAt: 1,
            lastAccessedAt: 2,
            sessionId: "nah-abc",
          },
          score: 0.75,
        },
      ],
      empty: false,
    }));
    const memory = hostedMemory({ apiKey: "key-123", baseUrl: BASE });

    const [hit] = await memory.search("staging build id", 6);

    // The recall tool and the trigger detector read the engine shape, so the
    // conversion is what makes the hosted backend a drop-in.
    expect(hit!.score).toBe(0.75);
    expect(hit!.item.id).toBe("srv-1");
    expect(hit!.item.metadata.domains).toEqual(["deployment"]);
    expect(hit!.item.metadata.sourceSessionId).toBe("nah-abc");
    expect(calls.at(-1)?.body).toEqual({ query: "staging build id", limit: 6 });
  });

  it("returns nothing rather than throwing when recall fails", async () => {
    routes.set("POST /api/v1/recall", () => new Error("socket hang up"));
    const memory = hostedMemory({ apiKey: "key-123", baseUrl: BASE });

    expect(await memory.search("anything")).toEqual([]);
    expect(memory.degraded).toMatch(/socket hang up/);
  });
});

describe("hosted learning", () => {
  it("sends the finished turn with the session id", async () => {
    routes.set("POST /api/v1/turns", () => ({
      stored: [],
      mergedInto: [],
      counts: { stored: 1, merged: 0, rejected: 0, tensions: 0, promoted: 0 },
      rejected: [],
    }));
    const memory = hostedMemory({ apiKey: "key-123", baseUrl: BASE });

    await memory.postTurnAsync({
      userMessage: "the build id is ZQ7X4M2K",
      assistantResponse: "noted",
      sessionId: "nah-abc",
    });

    expect(calls.at(-1)?.body).toEqual({
      userMessage: "the build id is ZQ7X4M2K",
      assistantResponse: "noted",
      sessionId: "nah-abc",
    });
    expect(memory.degraded).toBeNull();
  });

  it("clips an over-long reply to what the service accepts", async () => {
    routes.set("POST /api/v1/turns", () => ({
      stored: [],
      mergedInto: [],
      counts: { stored: 0, merged: 0, rejected: 0, tensions: 0, promoted: 0 },
      rejected: [],
    }));
    const memory = hostedMemory({ apiKey: "key-123", baseUrl: BASE });

    await memory.postTurnAsync({
      userMessage: "explain the scheduler",
      assistantResponse: "z".repeat(250000),
    });

    const sent = calls.at(-1)?.body as { assistantResponse: string };
    expect(sent.assistantResponse).toHaveLength(200001);
    expect(memory.degraded).toBeNull();
  });

  it("records a learn failure instead of raising it into the turn", async () => {
    routes.set("POST /api/v1/turns", () => respond({ error: "InvalidRequest", message: "too long" }, 400));
    const memory = hostedMemory({ apiKey: "key-123", baseUrl: BASE });

    await expect(
      memory.postTurnAsync({ userMessage: "x".repeat(10), assistantResponse: "y" }),
    ).resolves.toBeUndefined();
    expect(memory.degraded).toMatch(/too long \(400\)/);
  });
});

describe("hosted describe", () => {
  it("reports the project counts and no fake turn total", async () => {
    routes.set("GET /api/v1/stats", () => ({
      memories: { total: 12, byTier: { L1: 9, L2: 2, L3: 1 }, sessions: 1, firstStoredAt: 1, lastAccessedAt: 2 },
      tensions: { active: 1 },
      weakDomains: [],
      recent: [{ id: "m1", content: "file naming is kebab-case", tier: "L1", domains: ["naming"], accessCount: 1, createdAt: 1, lastAccessedAt: 2 }],
      activeTensions: [
        {
          id: "t1",
          status: "active",
          claimA: { source: "user", statement: "deploy on fridays", timestamp: 1 },
          claimB: { source: "conversation", statement: "never deploy on fridays", timestamp: 2 },
          impact: "critical",
          actionableQuestion: "Which is it?",
        },
      ],
    }));
    routes.set("GET /api/v1/self-model", () => ({
      calibrationFactor: 1,
      activeDomains: ["naming"],
      domains: { naming: { reliabilityScore: 0.62, sampleCount: 4, knownFailurePatterns: [], recommendedStrategies: [] } },
      weakDomains: ["naming"],
    }));
    const memory = hostedMemory({ apiKey: "key-123", baseUrl: BASE });

    const description = await memory.describe();

    expect(description.counts).toEqual({ L1: 9, L2: 2, L3: 1 });
    expect(description.activeTensions).toHaveLength(1);
    expect(description.activeTensions[0]!.actionableQuestion).toBe("Which is it?");
    expect(description.domains).toEqual([{ domain: "naming", reliability: 0.62, samples: 4 }]);
    expect(description.held[0]!.content).toBe("file naming is kebab-case");
    // The service counts the project, not this run. A number here would be a lie
    // dressed as a fact.
    expect(description.turnsProcessed).toBeNull();
  });

  it("keeps the self-model when the key may not read stats", async () => {
    routes.set("GET /api/v1/stats", () =>
      respond({ error: "Forbidden", message: "nope", requiredScope: "stats:read" }, 403),
    );
    routes.set("GET /api/v1/self-model", () => ({
      calibrationFactor: 1,
      activeDomains: ["naming"],
      domains: { naming: { reliabilityScore: 0.62, sampleCount: 4, knownFailurePatterns: [], recommendedStrategies: [] } },
      weakDomains: ["naming"],
    }));
    const memory = hostedMemory({ apiKey: "key-123", baseUrl: BASE });

    const description = await memory.describe();

    // The two endpoints carry different scopes: a key without the opt-in
    // `stats:read` still has `memories:read`. Losing the self-model to that one
    // 403 would report a working connection as a broken one.
    expect(description.domains).toEqual([{ domain: "naming", reliability: 0.62, samples: 4 }]);
    expect(description.counts).toEqual({ L1: 0, L2: 0, L3: 0 });
    // And it says which scope is missing, rather than just going quiet.
    expect(description.degraded).toMatch(/stats:read/);
  });

  it("reports itself unreachable rather than reporting an empty cache", async () => {
    routes.set("GET /api/v1/stats", () => new Error("fetch failed"));
    routes.set("GET /api/v1/self-model", () => new Error("fetch failed"));
    const memory = hostedMemory({ apiKey: "key-123", baseUrl: BASE });

    const description = await memory.describe();

    expect(description.counts).toEqual({ L1: 0, L2: 0, L3: 0 });
    expect(description.degraded).toMatch(/could not reach the service/);
  });
});

describe("hosted resolveTension", () => {
  it("reports a missing tension as not found, not as a failure", async () => {
    routes.set("POST /api/v1/tensions/nope", () => respond({ error: "NotFound", message: "gone" }, 404));
    const memory = hostedMemory({ apiKey: "key-123", baseUrl: BASE });

    expect(await memory.resolveTension("nope", { resolvedBy: "me", pattern: "p" })).toBe(false);
    // A wrong id is the caller's answer; the service is fine and must not be
    // reported as degraded because of it.
    expect(memory.degraded).toBeNull();
  });

  it("records a real failure", async () => {
    routes.set("POST /api/v1/tensions/t1", () => new Error("fetch failed"));
    const memory = hostedMemory({ apiKey: "key-123", baseUrl: BASE });

    expect(await memory.resolveTension("t1", { resolvedBy: "me", pattern: "p" })).toBe(false);
    expect(memory.degraded).toMatch(/could not reach the service/);
  });
});

describe("both backends behind one interface", () => {
  it("answers the same describe shape", async () => {
    const engine = new CognitiveMemory();
    engine.addMemory(
      {
        id: "m1",
        content: "The staging build ID is ZQ7X4M2K.",
        bookmark: "staging build",
        tier: "L1",
        metadata: { domains: ["deployment"], createdAt: 1, lastAccessedAt: 1, accessCount: 1 },
      },
      "L1",
    );
    const local = localMemory({ memory: engine, location: "/tmp/x.sqlite" });
    const description = await local.describe();

    expect(description.backend).toBe("local");
    expect(description.counts).toEqual({ L1: 1, L2: 0, L3: 0 });
    expect(description.held).toEqual([{ content: "The staging build ID is ZQ7X4M2K.", domains: ["deployment"] }]);
    expect(description.turnsProcessed).toBe(0);
  });

  it("contains a local failure instead of throwing into the turn", async () => {
    const engine = new CognitiveMemory();
    // A snapshot is what describe() reads, and this engine has one; the failure
    // injected here is the engine refusing to answer at all.
    vi.spyOn(engine, "planInjection").mockImplementation(() => {
      throw new Error("engine exploded");
    });
    const local = localMemory({ memory: engine, location: "/tmp/x.sqlite" });

    const report = await local.planInjection({});
    expect(report).toEqual({ text: "", entries: [], totalTokens: 0, truncated: false });
    expect(local.degraded).toBe("engine exploded");
  });
});
