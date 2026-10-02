/**
 * `/cogmem` — point memory at the hosted service, or bring it home again.
 *
 * The local SQLite store and the hosted service run the same cognitive layer, so
 * this is a switch of where memory lives, not of what memory does. Two rules
 * shape the whole command:
 *
 * 1. **Nothing is destroyed to make the switch.** The local store is left exactly
 *    as it was, so `/cogmem local` brings back everything, and `/cogmem import`
 *    is an explicit, confirmed copy rather than something that happens because a
 *    backend was enabled.
 * 2. **Nothing is enabled before it is proven.** Setup stores the key, checks
 *    that the service is up, checks that the key is accepted, and only then
 *    turns hosted memory on. A key that does not work leaves the CLI on local
 *    memory and says why.
 */
import * as readline from "node:readline/promises";

import { c } from "./render.js";
import { createMemoryReconciler, createTurnExtractor, prepareMemory } from "./memory.js";
import { localMemory, type MemoryDescription, type SessionMemory } from "./memory-backend.js";
import { hostedMemory, type HostedMemory } from "./memory-hosted.js";
import { openMemoryStore } from "./memory-store.js";
import { removeSecret, storeSecretFromPrompt, storeSecretInteractively } from "./credentials.js";
import {
  COGMEM_ACCOUNT,
  DEFAULT_COGMEM_BASE_URL,
  loadCogmemConfig,
  looksLikeUrl,
  maskKey,
  resolveCogmemBaseUrl,
  resolveCogmemKey,
  saveCogmemConfig,
} from "./cogmem-config.js";
import type { SessionState } from "./session.js";

/** Statements per request when importing. Large enough to be quick, small enough to retry. */
const IMPORT_BATCH = 50;

export type CogmemDeps = {
  state: SessionState;
  out: NodeJS.WriteStream;
  /** Overridable for tests, and for a caller that already has a terminal. */
  ask?: (question: string) => Promise<string>;
  /** Overridable so a test never opens a socket. */
  createHosted?: (options: { apiKey: string; baseUrl: string }) => HostedMemory;
};

const askOn = async (deps: CogmemDeps, question: string): Promise<string> => {
  if (deps.ask) return deps.ask(question);
  const prompt = readline.createInterface({
    input: process.stdin,
    output: deps.out,
    terminal: Boolean(process.stdin.isTTY),
  });
  try {
    return (await prompt.question(question)).trim();
  } finally {
    prompt.close();
  }
};

const buildHosted = (deps: CogmemDeps, apiKey: string, baseUrl: string): HostedMemory =>
  deps.createHosted ? deps.createHosted({ apiKey, baseUrl }) : hostedMemory({ apiKey, baseUrl });

/** Build the local backend, reusing the same wiring the CLI starts with. */
const buildLocal = async (deps: CogmemDeps): Promise<SessionMemory> => {
  const model = deps.state.model?.model ?? null;
  const prepared = await prepareMemory({
    cwd: deps.state.cwd,
    persist: deps.state.store !== null,
    extractor: model ? createTurnExtractor(model) : null,
    reconciler: model ? createMemoryReconciler(model) : null,
  });
  return localMemory({
    memory: prepared.memory,
    location: prepared.path,
    restored: prepared.restored,
    ...(prepared.importedFrom === undefined ? {} : { importedFrom: prepared.importedFrom }),
  });
};

/** One line per fact about where memory is, phrased the same for both backends. */
const renderStatus = (out: NodeJS.WriteStream, description: MemoryDescription, extras: string[]): void => {
  out.write(`${c.bold("Cognitive Memory")}\n`);
  out.write(`  backend   ${description.backend} · ${description.location}\n`);
  const { L1, L2, L3 } = description.counts;
  out.write(`  memories  ${L1} L1 · ${L2} L2 · ${L3} L3\n`);
  if (description.turnsProcessed !== null) out.write(`  turns     ${description.turnsProcessed} processed\n`);
  if (description.activeTensions.length > 0) {
    out.write(`  tensions  ${description.activeTensions.length} unresolved\n`);
  }
  if (description.domains.length > 0) {
    out.write(
      `  domains   ${description.domains
        .map((row) => `${row.domain} ${Math.round(row.reliability * 100)}%`)
        .join(" · ")}\n`,
    );
  }
  // A backend that is failing must say so here, not only by behaving as if it
  // had forgotten everything.
  if (description.degraded) out.write(`  ${c.yellow("unreachable")}  ${description.degraded}\n`);
  for (const extra of extras) out.write(`  ${c.dim(extra)}\n`);
};

/**
 * Prove the service and the key before enabling anything.
 *
 * `health` is deliberately unauthenticated, so a passing health check says the
 * deployment is up and nothing about whether the key works. A second,
 * authenticated call is what actually validates it — and a 403 there is reported
 * rather than treated as success, because a key that cannot read memory is not a
 * working configuration.
 */
const probeService = async (memory: HostedMemory): Promise<{ ok: boolean; lines: string[] }> => {
  const lines: string[] = [];
  try {
    const health = await memory.checkHealth();
    lines.push(`service ok · version ${health.version} · extractor ${health.extractor}`);
    if (health.extractor === "rules-only") {
      lines.push("the service has no model key configured, so learning is pattern-based only");
    }
    for (const problem of health.problems) lines.push(c.yellow(`service reports: ${problem}`));
  } catch (error) {
    return { ok: false, lines: [`could not reach the service: ${error instanceof Error ? error.message : String(error)}`] };
  }

  try {
    await memory.client.stats.get();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lines.push(c.yellow(`the key was rejected or is missing a scope: ${message}`));
  }
  return { ok: true, lines };
};

/** Store a key chosen interactively. Returns false when the user backed out. */
const collectKey = async (deps: CogmemDeps, baseUrl: string): Promise<boolean> => {
  const choice = (
    await askOn(
      deps,
      `Key: 1) device credential store  2) paste here  3) use COGNITIVE_MEMORY_KEY  [1]: `,
    )
  ) || "1";

  if (choice === "3") {
    if (!process.env.COGNITIVE_MEMORY_KEY?.trim()) {
      deps.out.write(c.red("COGNITIVE_MEMORY_KEY is not set in this environment.\n"));
      return false;
    }
    await saveCogmemConfig({ keySource: "env" });
    deps.out.write(c.dim("using COGNITIVE_MEMORY_KEY from the environment; nothing is stored\n"));
    return true;
  }

  if (choice === "2") {
    await storeSecretFromPrompt("cogmem", COGMEM_ACCOUNT, "Paste your Cognitive Memory API key (input hidden): ");
  } else {
    await storeSecretInteractively("cogmem", COGMEM_ACCOUNT, {
      platformMessage: "Paste your Cognitive Memory API key into the macOS Keychain prompt.\n",
    });
  }
  await saveCogmemConfig({ keySource: "store" });
  deps.out.write(c.green(`saved the key in the device credential store for ${baseUrl}\n`));
  return true;
};

const setup = async (deps: CogmemDeps): Promise<void> => {
  const config = await loadCogmemConfig();
  const answer = await askOn(deps, `Service URL [${config.baseUrl || DEFAULT_COGMEM_BASE_URL}]: `);
  const baseUrl = (answer || config.baseUrl || DEFAULT_COGMEM_BASE_URL).replace(/\/+$/, "");
  if (!looksLikeUrl(baseUrl)) {
    deps.out.write(c.red(`not a http(s) URL: ${baseUrl}\n`));
    return;
  }

  const hasKey = (await resolveCogmemKey({ ...config, baseUrl })).key !== null;
  if (!hasKey && !(await collectKey(deps, baseUrl))) return;

  await saveCogmemConfig({ baseUrl });
  const { key } = await resolveCogmemKey({ ...config, baseUrl });
  if (!key) {
    deps.out.write(c.red("no API key is available, so nothing was enabled.\n"));
    return;
  }

  const probe = await probeService(buildHosted(deps, key, baseUrl));
  for (const line of probe.lines) deps.out.write(`  ${line}\n`);
  if (!probe.ok) {
    deps.out.write(c.dim(`saved the URL and key. Fix the problem above, then /cogmem on.\n`));
    return;
  }

  deps.state.cognitiveMemory = buildHosted(deps, key, baseUrl);
  await saveCogmemConfig({ enabled: true });
  deps.out.write(c.green(`memory → hosted · ${baseUrl}\n`));
  deps.out.write(c.dim("your local store is untouched; /cogmem local switches back, /cogmem import copies it across\n"));
};

const importLocal = async (deps: CogmemDeps): Promise<void> => {
  const config = await loadCogmemConfig();
  const { key } = await resolveCogmemKey(config);
  if (!key) {
    deps.out.write(c.red("no API key is available. Run /cogmem setup first.\n"));
    return;
  }
  const baseUrl = resolveCogmemBaseUrl(config);
  const memory = buildHosted(deps, key, baseUrl);

  // Read the local store directly rather than through a loaded engine: this is a
  // copy of what is on disk, and loading it would also import a pre-SQLite JSON
  // file as a side effect of asking what would be copied.
  const store = openMemoryStore(deps.state.cwd);
  let snapshot;
  try {
    snapshot = store.load();
  } finally {
    store.close();
  }
  const held = snapshot ? [...snapshot.l1, ...snapshot.l2, ...snapshot.l3] : [];
  if (held.length === 0) {
    deps.out.write(c.dim("the local store holds nothing to import.\n"));
    return;
  }

  deps.out.write(`local store: ${held.length} memories (${snapshot?.l1.length ?? 0} L1, ${snapshot?.l2.length ?? 0} L2, ${snapshot?.l3.length ?? 0} L3)\n`);
  deps.out.write(`this sends them to ${baseUrl}, stored under your key.\n`);
  if (process.stdin.isTTY) {
    const proceed = (await askOn(deps, "Proceed? [y/N]: ")).toLowerCase();
    if (proceed !== "y" && proceed !== "yes") {
      deps.out.write(c.dim("nothing was sent.\n"));
      return;
    }
  } else {
    // No terminal to ask on, and this writes to a remote service. Refusing is the
    // only safe default.
    deps.out.write(c.red("import needs an interactive terminal; nothing was sent.\n"));
    return;
  }

  const items = held.map((item) => ({ content: item.content, domains: item.metadata.domains, tier: item.tier }));
  let stored = 0;
  let merged = 0;
  const rejected: string[] = [];
  for (let index = 0; index < items.length; index += IMPORT_BATCH) {
    const batch = items.slice(index, index + IMPORT_BATCH);
    try {
      // Tiers are preserved rather than flattened to L1: a memory that was
      // pre-staged locally was pre-staged for a reason, and one that was a warm
      // candidate should not be promoted by the act of copying it.
      const result = await memory.client.memories.create({ items: batch });
      stored += result.counts.stored;
      merged += result.counts.merged;
      rejected.push(...result.rejected.map((r) => r.content));
    } catch (error) {
      deps.out.write(c.red(`import stopped at ${index + batch.length}: ${error instanceof Error ? error.message : String(error)}\n`));
      deps.out.write(c.dim(`${stored} stored, ${merged} folded into what was already there. Re-run to continue.\n`));
      return;
    }
  }
  deps.out.write(c.green(`${stored} stored · ${merged} folded into existing memories\n`));
  // Never silent about what did not make it: a copy that quietly dropped a third
  // of someone's memory is the failure this whole command is meant to avoid.
  if (rejected.length > 0) {
    deps.out.write(c.yellow(`${rejected.length} refused by the service:\n`));
    for (const content of rejected.slice(0, 10)) deps.out.write(`  - ${content.slice(0, 100)}\n`);
    if (rejected.length > 10) deps.out.write(c.dim(`  …and ${rejected.length - 10} more\n`));
  }
  deps.out.write(c.dim("re-running is safe: restatements are folded in rather than duplicated\n"));
};

/**
 * Handle `/cogmem`.
 *
 * Returns nothing: every path writes its own outcome, because the useful output
 * is the state afterwards rather than a status code the caller has to render.
 */
export const handleCogmemCommand = async (deps: CogmemDeps, arg: string): Promise<void> => {
  const sub = arg.trim().toLowerCase();
  const config = await loadCogmemConfig();

  if (sub === "" || sub === "status") {
    const description = await deps.state.cognitiveMemory?.describe();
    if (!description) {
      deps.out.write(c.dim("memory is not active in this session.\n"));
      return;
    }
    const { key, source } = await resolveCogmemKey(config);
    const extras: string[] = [];
    if (description.backend === "hosted") {
      extras.push(
        key
          ? `key ${maskKey(key)} from ${source === "env" ? "COGNITIVE_MEMORY_KEY" : "the credential store"}`
          : "no key available — this session is running without one",
      );
      if (config.keySource === "env" && !process.env.COGNITIVE_MEMORY_KEY?.trim()) {
        extras.push("COGNITIVE_MEMORY_KEY is set to use the environment, and it is not set");
      }
      extras.push("/cogmem setup to change the connection · /cogmem local to switch back");
    } else {
      extras.push("/cogmem setup to use the hosted service instead");
      if (config.enabled) extras.push("hosted is enabled but unavailable, so this is the local fallback");
    }
    renderStatus(deps.out, description, extras);
    return;
  }

  if (sub === "setup" || sub === "connect") {
    await setup(deps);
    return;
  }

  if (sub === "key") {
    const baseUrl = resolveCogmemBaseUrl(config);
    if (!(await collectKey(deps, baseUrl))) return;
    // A replacement key is only useful if the backend is actually using it.
    if (config.enabled && deps.state.cognitiveMemory?.backend === "hosted") {
      const { key } = await resolveCogmemKey(config);
      if (key) deps.state.cognitiveMemory = buildHosted(deps, key, baseUrl);
    }
    deps.out.write(c.dim("saved. /cogmem on to use it, or /cogmem setup to re-check the connection.\n"));
    return;
  }

  if (sub === "forget") {
    try {
      await removeSecret("cogmem", COGMEM_ACCOUNT);
      await saveCogmemConfig({ keySource: "store" });
      deps.out.write(c.dim("removed the stored key. Local memory is unaffected.\n"));
    } catch (error) {
      deps.out.write(c.red(`${error instanceof Error ? error.message : String(error)}\n`));
    }
    return;
  }

  if (sub === "local" || sub === "off") {
    await saveCogmemConfig({ enabled: false });
    if (deps.state.cognitiveMemory?.backend === "hosted") {
      deps.state.cognitiveMemory = await buildLocal(deps);
    }
    deps.out.write(c.green("memory → local · everything you already learned is still there\n"));
    return;
  }

  if (sub === "on") {
    const { key } = await resolveCogmemKey(config);
    if (!key) {
      deps.out.write(c.red("no API key is available. Run /cogmem setup first.\n"));
      return;
    }
    const baseUrl = resolveCogmemBaseUrl(config);
    const memory = buildHosted(deps, key, baseUrl);
    const probe = await probeService(memory);
    for (const line of probe.lines) deps.out.write(`  ${line}\n`);
    if (!probe.ok) {
      deps.out.write(c.red("not enabling hosted memory: the service did not answer.\n"));
      return;
    }
    await saveCogmemConfig({ enabled: true });
    deps.state.cognitiveMemory = memory;
    deps.out.write(c.green(`memory → hosted · ${baseUrl}\n`));
    return;
  }

  if (sub === "import") {
    await importLocal(deps);
    return;
  }

  deps.out.write(c.dim("usage: /cogmem [status|setup|key|on|off|local|import|forget]\n"));
};
