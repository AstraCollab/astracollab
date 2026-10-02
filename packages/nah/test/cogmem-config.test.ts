import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_COGMEM_BASE_URL,
  loadCogmemConfig,
  looksLikeUrl,
  maskKey,
  resolveCogmemBaseUrl,
  resolveCogmemKey,
  saveCogmemConfig,
} from "../src/cogmem-config.js";
import { readConfig } from "../src/nah-config.js";
import { loadLastModel, saveLastModel } from "../src/model-preferences.js";
import { macKeychainAddCommand } from "../src/credentials.js";
import * as credentials from "../src/credentials.js";

/**
 * The connection settings, and the key that goes with them.
 *
 * Three things are worth protecting here. The config file is shared with the
 * last-used model, so a cogmem write must not drop it. The key must never land
 * in that file. And a key in the environment has to beat one in the keychain,
 * because that is the more explicit statement of intent.
 */

let home: string;
let previousHome: string | undefined;
const savedEnv: Record<string, string | undefined> = {};

const setEnv = (key: string, value: string | undefined) => {
  savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

beforeEach(() => {
  previousHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "nah-cogmem-home-"));
  process.env.HOME = home;
  setEnv("COGNITIVE_MEMORY_KEY", undefined);
  setEnv("COGNITIVE_MEMORY_URL", undefined);
  // The keychain is not reachable from a test, and silently finding nothing is
  // the behaviour most of these cases are asserting.
  vi.spyOn(credentials, "getStoredSecret").mockResolvedValue(undefined);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("cogmem config", () => {
  it("defaults to the public service and local memory", async () => {
    const config = await loadCogmemConfig();
    expect(config).toEqual({ enabled: false, baseUrl: DEFAULT_COGMEM_BASE_URL, keySource: "store" });
  });

  it("round-trips through the shared config file", async () => {
    await saveCogmemConfig({ enabled: true, baseUrl: "https://memory.example" });
    expect(await loadCogmemConfig()).toEqual({
      enabled: true,
      baseUrl: "https://memory.example",
      keySource: "store",
    });
  });

  it("keeps the last-used model when the connection changes", async () => {
    // The regression this guards: two modules read-modify-writing one file means
    // whichever wrote last wins, and a user who set a model loses it by typing
    // /cogmem setup.
    await saveLastModel("openrouter:stealth/space-bunny-alpha");
    await saveCogmemConfig({ enabled: true });

    expect(await loadLastModel()).toBe("openrouter:stealth/space-bunny-alpha");
    expect((await loadCogmemConfig()).enabled).toBe(true);
  });

  it("keeps the connection when the model changes", async () => {
    await saveCogmemConfig({ enabled: true, baseUrl: "https://memory.example" });
    await saveLastModel("anthropic:claude-sonnet-4-5");

    expect((await loadCogmemConfig()).baseUrl).toBe("https://memory.example");
  });

  it("never writes the key to disk", async () => {
    process.env.COGNITIVE_MEMORY_KEY = "sk-super-secret-value";
    await resolveCogmemKey(await loadCogmemConfig());
    await saveCogmemConfig({ enabled: true });

    const raw = readFileSync(join(home, ".nah", "config.json"), "utf8");
    expect(raw).not.toContain("sk-super-secret-value");
    expect(JSON.parse(raw).cogmem.keySource).toBe("store");
  });

  it("writes the config file owner-only", async () => {
    await saveCogmemConfig({ enabled: true });
    // A user's home directory is not a shared folder, whatever is in the file.
    expect(statSync(join(home, ".nah", "config.json")).mode & 0o777).toBe(0o600);
  });

  it("recovers from a corrupt config instead of refusing to start", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(home, ".nah"), { recursive: true });
    writeFileSync(join(home, ".nah", "config.json"), "{ not json");
    expect(await loadCogmemConfig()).toEqual({
      enabled: false,
      baseUrl: DEFAULT_COGMEM_BASE_URL,
      keySource: "store",
    });
  });

  it("ignores a stored value of the wrong shape", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(home, ".nah"), { recursive: true });
    writeFileSync(
      join(home, ".nah", "config.json"),
      JSON.stringify({ cogmem: { enabled: "yes", baseUrl: 42, keySource: "keychain" } }),
    );
    const config = await loadCogmemConfig();
    expect(config.enabled).toBe(false);
    expect(config.baseUrl).toBe(DEFAULT_COGMEM_BASE_URL);
    // An unrecognised source falls back to the store rather than to "env", which
    // would silently ignore a saved key.
    expect(config.keySource).toBe("store");
  });
});

describe("resolving the key", () => {
  it("prefers the environment over the stored key", async () => {
    vi.spyOn(credentials, "getStoredSecret").mockResolvedValue("stored-key");
    process.env.COGNITIVE_MEMORY_KEY = "env-key";

    expect(await resolveCogmemKey(await loadCogmemConfig())).toEqual({ key: "env-key", source: "env" });
  });

  it("uses the stored key when there is no environment one", async () => {
    vi.spyOn(credentials, "getStoredSecret").mockResolvedValue("stored-key");
    const resolved = await resolveCogmemKey(await loadCogmemConfig());
    expect(resolved).toEqual({ key: "stored-key", source: "store" });
  });

  it("treats an empty environment variable as unset", async () => {
    vi.spyOn(credentials, "getStoredSecret").mockResolvedValue("stored-key");
    // An exported-but-empty variable is a mistake, not an instruction to send
    // nothing; falling through to the stored key is the useful reading.
    process.env.COGNITIVE_MEMORY_KEY = "   ";
    expect((await resolveCogmemKey(await loadCogmemConfig())).key).toBe("stored-key");
  });

  it("ignores the keychain when setup asked for the environment", async () => {
    // Someone who chose "use COGNITIVE_MEMORY_KEY" is asking for the environment
    // specifically. A key left over from an earlier setup must not take over.
    await saveCogmemConfig({ keySource: "env" });
    vi.spyOn(credentials, "getStoredSecret").mockResolvedValue("stored-key");

    expect(await resolveCogmemKey(await loadCogmemConfig())).toEqual({ key: null, source: null });
    expect(credentials.getStoredSecret).not.toHaveBeenCalled();
  });

  it("reports no key rather than an empty one", async () => {
    expect(await resolveCogmemKey(await loadCogmemConfig())).toEqual({ key: null, source: null });
  });
});

describe("resolving the URL", () => {
  it("lets the environment override the stored service", async () => {
    await saveCogmemConfig({ baseUrl: "https://memory.example" });
    expect(resolveCogmemBaseUrl(await loadCogmemConfig())).toBe("https://memory.example");

    process.env.COGNITIVE_MEMORY_URL = "http://localhost:3000";
    expect(resolveCogmemBaseUrl(await loadCogmemConfig())).toBe("http://localhost:3000");
  });

  it("trims a trailing slash so paths do not double up", () => {
    process.env.COGNITIVE_MEMORY_URL = "https://memory.example/";
    expect(resolveCogmemBaseUrl({ enabled: true, baseUrl: "https://other.example", keySource: "store" })).toBe(
      "https://memory.example",
    );
  });
});

describe("key hygiene", () => {
  it("masks a key to something recognisable but unusable", () => {
    const masked = maskKey("cogmem_live_abcdefghijklmnop");
    expect(masked).toBe("cogm…op (28 chars)");
    expect(masked).not.toContain("abcdefghijkl");
    // Length is disclosed on purpose: a truncated key is the usual paste mistake.
    expect(masked).toContain("28 chars");
  });

  it("does not leak a short key by echoing part of it", () => {
    expect(maskKey("short")).toBe("•••••");
  });

  it("keeps a pasted key off the macOS command line", () => {
    // `security add-generic-password -w <key>` would put the secret in the process
    // table, where any process on the machine can read it. The batch form sends
    // it on stdin instead.
    const command = macKeychainAddCommand("com.astracollab.nah.cogmem", "default", "sk-secret");
    expect(command).toContain("-w \"sk-secret\"");
    // The command is piped to `security -i`, never passed as an argv entry; this
    // asserts the shape that keeps it out of `ps` output.
    expect(command.startsWith("add-generic-password")).toBe(true);
  });

  it("recognises a usable service URL and rejects anything else", () => {
    expect(looksLikeUrl("https://cogmem.astracollab.app")).toBe(true);
    expect(looksLikeUrl("http://localhost:3000")).toBe(true);
    expect(looksLikeUrl("cogmem.astracollab.app")).toBe(false);
    expect(looksLikeUrl("ftp://example.com")).toBe(false);
    expect(looksLikeUrl("")).toBe(false);
  });
});

describe("shared config file", () => {
  it("creates the directory it needs", async () => {
    expect(existsSync(join(home, ".nah"))).toBe(false);
    await saveCogmemConfig({ enabled: true });
    expect(existsSync(join(home, ".nah", "config.json"))).toBe(true);
  });

  it("leaves no temp file behind", async () => {
    await saveCogmemConfig({ enabled: true });
    await saveCogmemConfig({ enabled: false });
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(join(home, ".nah")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("reads an empty file as no configuration", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(home, ".nah"), { recursive: true });
    writeFileSync(join(home, ".nah", "config.json"), "");
    expect(await readConfig()).toEqual({});
  });
});
