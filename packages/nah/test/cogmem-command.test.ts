import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleCogmemCommand } from "../src/cogmem-command.js";
import { localMemory, type MemoryDescription, type SessionMemory } from "../src/memory-backend.js";
import type { HostedMemory } from "../src/memory-hosted.js";
import { loadCogmemConfig, saveCogmemConfig } from "../src/cogmem-config.js";
import { MemoryStore } from "../src/memory-store.js";
import { memoryFileFor } from "../src/memory.js";
import * as credentials from "../src/credentials.js";
import type { SessionState } from "../src/session.js";

/**
 * `/cogmem`, driven end to end against a fake service and a fake terminal.
 *
 * What matters is not that it prints things — it is that it never enables a
 * backend that does not work, never destroys the local store on the way past,
 * and never sends anything anywhere without saying so first.
 */

type Ask = (question: string) => Promise<string>;

const strip = (value: string): string => value.replace(/\u001b\[[0-9;]*m/g, "");

const fakeState = (memory: SessionMemory, cwd: string): SessionState =>
  ({
    cwd,
    store: null,
    model: null,
    cognitiveMemory: memory,
  }) as unknown as SessionState;

const localDescription = (over: Partial<MemoryDescription> = {}): MemoryDescription => ({
  backend: "local",
  location: "/tmp/x.sqlite",
  turnsProcessed: 3,
  counts: { L1: 2, L2: 0, L3: 0 },
  held: [{ content: "file naming is kebab-case", domains: ["naming"] }],
  heldNote: "shown in full",
  activeTensions: [],
  domains: [],
  degraded: null,
  ...over,
});

/** A hosted backend that records what it was built with and never touches a socket. */
const fakeHosted = (
  behaviour: {
    health?: () => Promise<unknown>;
    stats?: () => Promise<unknown>;
    create?: (request: { items: Array<{ content: string }> }) => Promise<unknown>;
  } = {},
): HostedMemory & { built: Array<{ apiKey: string; baseUrl: string }> } => {
  const built: Array<{ apiKey: string; baseUrl: string }> = [];
  const backend = {
    built,
    backend: "hosted" as const,
    location: "",
    degraded: null as string | null,
    client: {
      stats: { get: behaviour.stats ?? (async () => ({ memories: { byTier: {} }, recent: [], activeTensions: [] })) },
      memories: {
        create: behaviour.create ?? (async () => ({ counts: { stored: 0, merged: 0, rejected: 0 }, rejected: [] })),
      },
    },
    checkHealth: behaviour.health ?? (async () => ({ ok: true, version: "1.0.0", extractor: "rules+model", problems: [] })),
    async planInjection() {
      return { text: "", entries: [], totalTokens: 0, truncated: false };
    },
    async search() {
      return [];
    },
    async postTurnAsync() {},
    async describe() {
      return localDescription({ backend: "hosted", turnsProcessed: null, held: [], heldNote: "recent" });
    },
    async resolveTension() {
      return true;
    },
  };
  return backend as unknown as HostedMemory & { built: Array<{ apiKey: string; baseUrl: string }> };
};

let home: string;
let cwd: string;
let previousHome: string | undefined;
const savedTty = process.stdin.isTTY;

beforeEach(() => {
  previousHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "nah-cogmem-cmd-home-"));
  cwd = mkdtempSync(join(tmpdir(), "nah-cogmem-cmd-project-"));
  process.env.HOME = home;
  delete process.env.COGNITIVE_MEMORY_KEY;
  delete process.env.COGNITIVE_MEMORY_URL;
  vi.spyOn(credentials, "getStoredSecret").mockResolvedValue(undefined);
  vi.spyOn(credentials, "storeSecretFromPrompt").mockResolvedValue(undefined);
  vi.spyOn(credentials, "storeSecretInteractively").mockResolvedValue(undefined);
  vi.spyOn(credentials, "removeSecret").mockResolvedValue(undefined);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  Object.defineProperty(process.stdin, "isTTY", { value: savedTty, configurable: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const capture = () => {
  let text = "";
  return {
    out: { write: (chunk: string) => ((text += chunk), true) } as unknown as NodeJS.WriteStream,
    text: () => strip(text),
  };
};

describe("/cogmem status", () => {
  it("shows the local backend and where it lives", async () => {
    const { out, text } = capture();
    const memory = localMemory({
      memory: { getSnapshot: () => ({ l0: { tensions: [], selfModel: { domains: {} }, activeTaskTrace: "" }, l1: [], l2: [], l3: [], stats: { totalTurnsProcessed: 0 } }) } as never,
      location: "/tmp/project.sqlite",
    });
    await handleCogmemCommand({ state: fakeState(memory, cwd), out }, "status");
    expect(text()).toContain("local");
    expect(text()).toContain("/tmp/project.sqlite");
    expect(text()).toContain("/cogmem setup");
  });

  it("says nothing is active when memory is off", async () => {
    const { out, text } = capture();
    await handleCogmemCommand({ state: fakeState(undefined as never, cwd), out }, "");
    expect(text()).toContain("not active");
  });
});

describe("/cogmem setup", () => {
  it("rejects a URL that is not one", async () => {
    const { out, text } = capture();
    const hosted = fakeHosted();
    await handleCogmemCommand(
      { state: fakeState(localMemory({ memory: {} as never, location: "x" }), cwd), out, ask: async () => "not a url", createHosted: () => hosted },
      "setup",
    );
    expect(text()).toContain("not a http(s) URL");
  });

  it("stores a key, checks the service, and only then switches", async () => {
    const { out, text } = capture();
    const hosted = fakeHosted();
    // No key yet: the store returns one only once the key has been written, which
    // is the order the real flow happens in.
    let stored = false;
    vi.mocked(credentials.getStoredSecret).mockImplementation(async () => (stored ? "stored-key" : undefined));
    vi.mocked(credentials.storeSecretInteractively).mockImplementation(async () => {
      stored = true;
    });
    const state = fakeState(localMemory({ memory: {} as never, location: "/tmp/x.sqlite" }), cwd);

    await handleCogmemCommand(
      {
        state,
        out,
        // URL, then key source.
        ask: (async (q: string) => (q.startsWith("Service") ? "https://memory.example" : "1")) as Ask,
        createHosted: (options) => {
          hosted.built.push(options);
          return hosted;
        },
      },
      "setup",
    );

    expect(credentials.storeSecretInteractively).toHaveBeenCalledWith("cogmem", "default", expect.anything());
    // Nothing is enabled until the probe has passed.
    expect(state.cognitiveMemory?.backend).toBe("hosted");
    expect(hosted.built[0]).toEqual({ apiKey: "stored-key", baseUrl: "https://memory.example" });
    expect(text()).toContain("memory → hosted · https://memory.example");
    expect(text()).toContain("untouched");
    expect((await loadCogmemConfig()).baseUrl).toBe("https://memory.example");
  });

  it("does not switch when the service cannot be reached", async () => {
    const { out, text } = capture();
    const hosted = fakeHosted({
      health: async () => {
        throw new Error("getaddrinfo ENOTFOUND memory.example");
      },
    });
    vi.mocked(credentials.getStoredSecret).mockResolvedValue("stored-key");
    const state = fakeState(localMemory({ memory: {} as never, location: "/tmp/x.sqlite" }), cwd);

    await handleCogmemCommand(
      { state, out, ask: (async (q: string) => (q.startsWith("Service") ? "https://memory.example" : "1")) as Ask, createHosted: () => hosted },
      "setup",
    );

    // The turn keeps working on local memory, and the key and URL are still saved
    // so one `/cogmem on` finishes the job.
    expect(state.cognitiveMemory?.backend).toBe("local");
    expect(text()).toContain("could not reach the service");
    expect(text()).toContain("/cogmem on");
    const config = await loadCogmemConfig();
    expect(config.baseUrl).toBe("https://memory.example");
    expect(config.enabled).toBe(false);
  });

  it("warns about a key without a scope but still switches", async () => {
    const { out, text } = capture();
    const hosted = fakeHosted({
      stats: async () => {
        throw new Error("Forbidden: needs stats:read");
      },
    });
    vi.mocked(credentials.getStoredSecret).mockResolvedValue("stored-key");
    const state = fakeState(localMemory({ memory: {} as never, location: "x" }), cwd);

    await handleCogmemCommand(
      { state, out, ask: (async (q: string) => (q.startsWith("Service") ? "" : "1")) as Ask, createHosted: () => hosted },
      "setup",
    );

    expect(text()).toContain("rejected or is missing a scope");
    expect(state.cognitiveMemory?.backend).toBe("hosted");
  });

  it("uses the environment when asked, and stores nothing", async () => {
    const { out, text } = capture();
    // The environment key is only set after the choice, because a key present
    // beforehand is exactly the case where setup skips the question entirely.
    process.env.COGNITIVE_MEMORY_KEY = "";
    const hosted = fakeHosted();
    const state = fakeState(localMemory({ memory: {} as never, location: "x" }), cwd);

    await handleCogmemCommand(
      {
        state,
        out,
        ask: (async (q: string) => {
          if (q.startsWith("Service")) return "";
          // The user exports the key in another shell, so it is present by the
          // time setup asks where it should come from.
          process.env.COGNITIVE_MEMORY_KEY = "env-key";
          return "3";
        }) as Ask,
        createHosted: () => hosted,
      },
      "setup",
    );

    expect(process.env.COGNITIVE_MEMORY_KEY).toBe("env-key");
    expect(credentials.storeSecretInteractively).not.toHaveBeenCalled();
    expect(credentials.storeSecretFromPrompt).not.toHaveBeenCalled();
    expect(text()).toContain("nothing is stored");
    expect((await loadCogmemConfig()).keySource).toBe("env");
  });

  it("refuses the environment route when the variable is not set", async () => {
    const { out, text } = capture();
    const state = fakeState(localMemory({ memory: {} as never, location: "x" }), cwd);

    await handleCogmemCommand(
      { state, out, ask: (async (q: string) => (q.startsWith("Service") ? "" : "3")) as Ask, createHosted: () => fakeHosted() },
      "setup",
    );

    expect(text()).toContain("COGNITIVE_MEMORY_KEY is not set");
    expect(state.cognitiveMemory?.backend).toBe("local");
  });

  it("skips the key step when one is already available", async () => {
    const { out } = capture();
    const hosted = fakeHosted();
    vi.mocked(credentials.getStoredSecret).mockResolvedValue("stored-key");
    const state = fakeState(localMemory({ memory: {} as never, location: "x" }), cwd);
    const asked: string[] = [];

    await handleCogmemCommand(
      {
        state,
        out,
        ask: async (q: string) => {
          asked.push(q);
          return "";
        },
        createHosted: () => hosted,
      },
      "setup",
    );

    expect(asked.some((q) => q.startsWith("Key:"))).toBe(false);
    expect(state.cognitiveMemory?.backend).toBe("hosted");
  });
});

describe("/cogmem local and on", () => {
  it("switches back without losing the hosted connection", async () => {
    const { out, text } = capture();
    await saveCogmemConfig({ enabled: true, baseUrl: "https://memory.example" });
    const state = fakeState(localMemory({ memory: { getSnapshot: () => ({ l0: { tensions: [], selfModel: { domains: {} } }, l1: [], l2: [], l3: [], stats: { totalTurnsProcessed: 0 } }) } as never, location: "/tmp/x.sqlite" }), cwd);

    await handleCogmemCommand({ state, out }, "local");

    expect(state.cognitiveMemory?.backend).toBe("local");
    expect(text()).toContain("still there");
    // The URL and the choice of key source survive, so going back is one command.
    const config = await loadCogmemConfig();
    expect(config.baseUrl).toBe("https://memory.example");
    expect(config.enabled).toBe(false);
  });

  it("refuses to go hosted with no key", async () => {
    const { out, text } = capture();
    const state = fakeState(localMemory({ memory: {} as never, location: "x" }), cwd);

    await handleCogmemCommand({ state, out, createHosted: () => fakeHosted() }, "on");

    expect(text()).toContain("no API key");
    expect(state.cognitiveMemory?.backend).toBe("local");
  });
});

describe("/cogmem key and forget", () => {
  it("replaces a key and rebuilds a live hosted backend", async () => {
    const { out } = capture();
    await saveCogmemConfig({ enabled: true });
    vi.mocked(credentials.getStoredSecret).mockResolvedValue("new-key");
    const state = fakeState(fakeHosted() as unknown as SessionMemory, cwd);

    await handleCogmemCommand({ state, out, ask: async () => "2", createHosted: () => fakeHosted() }, "key");

    expect(credentials.storeSecretFromPrompt).toHaveBeenCalled();
    expect(state.cognitiveMemory?.backend).toBe("hosted");
  });

  it("leaves a local session alone when replacing a key", async () => {
    const { out } = capture();
    const local = localMemory({ memory: {} as never, location: "/tmp/x.sqlite" });
    const state = fakeState(local, cwd);

    await handleCogmemCommand({ state, out, ask: async () => "1" }, "key");

    // There is nothing to rebuild, so nothing is rebuilt.
    expect(state.cognitiveMemory).toBe(local);
  });

  it("forgets the stored key and says local memory is unaffected", async () => {
    const { out, text } = capture();
    await handleCogmemCommand({ state: fakeState(localMemory({ memory: {} as never, location: "x" }), cwd), out }, "forget");

    expect(credentials.removeSecret).toHaveBeenCalledWith("cogmem", "default");
    expect(text()).toContain("Local memory is unaffected");
  });
});

describe("/cogmem import", () => {
  const seedLocal = (count: number) => {
    const store = new MemoryStore({ path: memoryFileFor(cwd) });
    store.save({
      l0: { tensions: [], selfModel: { domains: {}, calibrationFactor: 1, activeDomains: [] }, activeTaskTrace: "" },
      l1: Array.from({ length: count }, (_, index) => ({
        id: `m${index}`,
        content: `local memory number ${index}`,
        bookmark: `local ${index}`,
        tier: "L1" as const,
        metadata: { domains: ["naming"], createdAt: 1, lastAccessedAt: 1, accessCount: 1 },
      })),
      l2: [],
      l3: [],
      stats: { totalTurnsProcessed: 1, predictionsHit: 0, predictionsTotal: 0, tensionsDetected: 0 },
    });
    store.close();
  };

  it("asks before sending anything, and sends nothing when told not to", async () => {
    seedLocal(3);
    const create = vi.fn();
    const { out, text } = capture();
    process.env.COGNITIVE_MEMORY_KEY = "env-key";
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    await handleCogmemCommand(
      { state: fakeState(localMemory({ memory: {} as never, location: "x" }), cwd), out, ask: async () => "n", createHosted: () => fakeHosted({ create }) as never },
      "import",
    );

    expect(create).not.toHaveBeenCalled();
    expect(text()).toContain("nothing was sent");
  });

  it("copies the local store in batches and reports what the service did", async () => {
    seedLocal(120);
    const batches: number[] = [];
    const { out, text } = capture();
    process.env.COGNITIVE_MEMORY_KEY = "env-key";
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    await handleCogmemCommand(
      {
        state: fakeState(localMemory({ memory: {} as never, location: "x" }), cwd),
        out,
        ask: async () => "y",
        createHosted: () =>
          fakeHosted({
            create: async (request) => {
              batches.push(request.items.length);
              return {
                counts: { stored: request.items.length, merged: 0, rejected: 0 },
                rejected: [],
              };
            },
          }) as never,
      },
      "import",
    );

    // 50 at a time, so one bad batch does not lose the other 70.
    expect(batches).toEqual([50, 50, 20]);
    expect(text()).toContain("120 stored");
  });

  it("names the statements the service refused", async () => {
    seedLocal(1);
    const { out, text } = capture();
    process.env.COGNITIVE_MEMORY_KEY = "env-key";
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    await handleCogmemCommand(
      {
        state: fakeState(localMemory({ memory: {} as never, location: "x" }), cwd),
        out,
        ask: async () => "y",
        createHosted: () =>
          fakeHosted({
            create: async () => ({
              counts: { stored: 0, merged: 0, rejected: 1 },
              rejected: [{ content: "local memory number 0", reason: "too vague" }],
            }),
          }) as never,
      },
      "import",
    );

    // A copy that silently dropped everything is the failure this guards.
    expect(text()).toContain("1 refused by the service");
    expect(text()).toContain("local memory number 0");
  });

  it("refuses to run without a terminal", async () => {
    seedLocal(1);
    const create = vi.fn();
    const { out, text } = capture();
    process.env.COGNITIVE_MEMORY_KEY = "env-key";
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    await handleCogmemCommand(
      { state: fakeState(localMemory({ memory: {} as never, location: "x" }), cwd), out, createHosted: () => fakeHosted({ create }) as never },
      "import",
    );

    expect(create).not.toHaveBeenCalled();
    expect(text()).toContain("needs an interactive terminal");
  });

  it("says so when there is nothing to import", async () => {
    const { out, text } = capture();
    process.env.COGNITIVE_MEMORY_KEY = "env-key";

    await handleCogmemCommand(
      { state: fakeState(localMemory({ memory: {} as never, location: "x" }), cwd), out, createHosted: () => fakeHosted() as never },
      "import",
    );

    expect(text()).toContain("nothing to import");
  });
});

describe("/cogmem usage", () => {
  it("prints the subcommands for anything it does not recognise", async () => {
    const { out, text } = capture();
    await handleCogmemCommand({ state: fakeState(localMemory({ memory: {} as never, location: "x" }), cwd), out }, "wat");
    expect(text()).toContain("/cogmem [status|setup|key|on|off|local|import|forget]");
  });
});
