/**
 * Live memory evaluation.
 *
 * The point of this script is to answer one question honestly: does memory
 * actually carry information forward, or does the transcript do all the work?
 *
 * So it teaches facts in a first "session", then **wipes the conversation
 * history** and asks about them again. With an empty transcript, anything the
 * model can still answer came out of memory.
 */
import { createNodeEnvironment } from "@astracollab/not-another-harness/node";
import { createCodingTools } from "@astracollab/not-another-harness";
import { resolveModel } from "./src/model.js";
import { resolveInjection, runTurn, type SessionState } from "./src/session.js";
import { createTurnExtractor, prepareMemory, memoryFileFor, setMemoryPersistedHook } from "./src/memory.js";
import { localMemory } from "./src/memory-backend.js";
import { createRecallTool } from "./src/memory-tool.js";
import { MemoryInjectionLog } from "./src/memory-injection.js";

const MODEL = process.env.NAH_EVAL_MODEL ?? "openrouter:stealth/space-bunny-alpha";
const CWD = process.env.NAH_EVAL_CWD ?? process.cwd();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string) => s.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");

/** Records the system-role message the SDK actually sent, so we can prove injection. */
function spyOn(model: object) {
  const seen: string[] = [];
  const wrapped = new Proxy(model, {
    get(target, prop, receiver) {
      if (prop === "doStream") {
        return async (options: Record<string, unknown>) => {
          const prompt = options.prompt;
          if (Array.isArray(prompt)) {
            for (const part of prompt as Array<Record<string, unknown>>) {
              if (part.role === "system" && typeof part.content === "string") seen.push(part.content);
            }
          }
          return (target as { doStream: (o: unknown) => unknown }).doStream(options);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { wrapped, seen };
}

let recallCalls = 0;
const env = createNodeEnvironment(CWD);
const resolved = await resolveModel(MODEL);
const { wrapped, seen } = spyOn(resolved.model);

const persist = process.env.NAH_EVAL_NOPERSIST !== "1";
let persistedAt = 0;
setMemoryPersistedHook(() => {
  persistedAt += 1;
});
const prepared = await prepareMemory({
  cwd: CWD,
  persist,
  extractor: createTurnExtractor(resolved.model),
});

const state = {
  messages: [],
  system: "You are a concise assistant. Answer in one short sentence.",
  cwd: CWD,
  tools: {
    ...createCodingTools(env, { approveToolCall: async () => true }),
    recall: (() => {
      const inner = createRecallTool(() => prepared.memory);
      return {
        ...inner,
        execute: async (input: never, ctx: unknown) => {
          recallCalls += 1;
          console.log(`  [tool] recall called with ${JSON.stringify(input)}`);
          return inner.execute(input, ctx);
        },
      };
    })(),
  },
  workspace: env,
  activeFileChanges: null,
  activeShellCommands: null,
  undoHistory: [],
  sessionBasePath: null,
  taskLedger: null,
  discoveredChecks: [],
  store: null,
  model: { model: wrapped, spec: resolved.spec },
  providerStatus: null,
  totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  contextUsedTokens: 0,
  contextUsageEstimated: false,
  lastOutputTokens: 0,
  turns: 0,
  permissions: "yolo",
  cognitiveMemory: localMemory({ memory: prepared.memory, location: prepared.path }),
  memoryInjectionLog: new MemoryInjectionLog(),
} as unknown as SessionState;

const ask = async (prompt: string, label: string) => {
  // The injection is resolved here rather than inside `runTurn`, which is
  // synchronous. This eval is deliberately the local backend only: it waits on
  // the persistence hook to know a turn's background work finished, and a hosted
  // turn has no such hook. The hosted adapter is covered by the unit tests, which
  // stub the transport.
  const injection = await resolveInjection(state, prompt);
  const turn = runTurn(state, prompt, {}, injection);
  const consumer = (async () => {
    for await (const _ of turn.events) {
      /* drain */
    }
  })();
  const result = await turn.done;
  await consumer;
  // postTurnAsync is fired and forgotten and costs a model call, so wait for the
  // persistence step (its final action) before reading memory back.
  const before = persistedAt;
  for (let i = 0; i < 60; i += 1) {
    await sleep(250);
    if (persistedAt > before) break;
  }
  await sleep(200);
  const system = seen[seen.length - 1] ?? "";
  const at = system.indexOf("## Cognitive Memory State");
  const injected = at >= 0 ? strip(system.slice(at)) : "";
  const snap = prepared.memory.getSnapshot();
  console.log(`\n--- ${label}`);
  console.log(`  asked    : ${prompt.slice(0, 70)}`);
  console.log(`  answer   : ${result.text.replace(/\s+/g, " ").slice(0, 110)}`);
  console.log(`  memory   : l1=${snap.l1.length} l2=${snap.l2.length} tensions=${snap.l0.tensions.length}`);
  if (snap.l2.length) console.log(`  l2       : ${JSON.stringify(snap.l2.map((m) => m.content.slice(0, 64)))}`);
  if (snap.l1.length) console.log(`  l1       : ${JSON.stringify(snap.l1.map((m) => m.content.slice(0, 64)))}`);
  console.log(`  injected : ${injected ? injected.replace(/\s+/g, " ").slice(0, 160) : "NO"}`);
  return result.text;
};

// ---- Session 1: teach -------------------------------------------------------
console.log(`model: ${resolved.spec}`);
console.log(`memory file: ${memoryFileFor(CWD)} (persisted: ${persist})`);
console.log(`restored from a previous run: ${prepared.restored}`);

// Non-guessable tokens: a capable model will happily invent a plausible URL or
// path, so a recall test built from guessable values proves nothing.
const NONCE_ID = "ZQ7X4M2K";
const NONCE_HOST = "internal-hbr-2291.pineapple.example";
const NONCE_FLAG = "HBR_ENABLE_FAST_LANE";

const RECALL_ONLY = process.env.NAH_EVAL_RECALL_ONLY === "1";

console.log("\n########## SESSION 1 — teach ##########");
if (!RECALL_ONLY) {
  await ask(`The staging build ID is ${NONCE_ID}. Just remember it, do not verify it against the repo.`, "teach fact");
  await ask(`The internal staging host is ${NONCE_HOST}. Just remember it, do not verify it against the repo.`, "teach fact 2");
  await ask("For this repo, always use kebab-case for new file names. Just note it, do not verify.", "teach preference");
} else {
  console.log("  (recall-only: skipping the teaching turns entirely)");
}

// ---- Session 2: wipe history, rely only on memory ---------------------------
console.log(
  RECALL_ONLY
    ? "\n########## FRESH PROCESS — memory loaded from disk, empty transcript ##########"
    : "\n########## SESSION 2 — history wiped, memory only ##########",
);
state.messages = [];
console.log(`transcript messages now: ${state.messages.length}`);

const idAnswer = await ask("What is the staging build ID for this project? If you were not told, say UNKNOWN.", "recall nonce id");
const hostAnswer = await ask("What is the internal staging host? If you were not told, say UNKNOWN.", "recall nonce host");
const conventionAnswer = await ask("What file-naming convention was specified for this repo? If you were not told, say UNKNOWN.", "recall preference");
// Deliberately unlike the stored wording ("staging build ID is …"), so the
// pre-staged block should not contain it: answering needs the recall tool.
const indirectAnswer = await ask(
  "Which opaque identifier was issued for the staging environment? If you were not told, say UNKNOWN.",
  "recall via tool only",
);

// ---- Verdict ----------------------------------------------------------------
const checks: Array<[string, string, boolean]> = [
  ["build ID (unguessable)", idAnswer, idAnswer.includes(NONCE_ID)],
  ["staging host (unguessable)", hostAnswer, hostAnswer.includes("2291") && hostAnswer.includes("pineapple")],
  ["kebab-case preference", conventionAnswer, /kebab/i.test(conventionAnswer)],
  ["build id (tool-only path)", indirectAnswer, indirectAnswer.includes("ZQ7X4M2K")],
];

console.log("\n########## INJECTION LOG ##########");
const summary = state.memoryInjectionLog!.summary();
console.log(
  `  ${summary.turns} turns · avg ${summary.avgTokens} tokens · max ${summary.maxTokens} · reasons ${JSON.stringify(summary.byReason)}`,
);
for (const turn of state.memoryInjectionLog!.entries.slice(-3)) {
  console.log(`  turn ${turn.turn}: ${turn.totalTokens} tokens`);
  for (const item of turn.items) {
    console.log(`    ${item.hasBody ? "BODY" : "index"} [${item.reason}] ${item.gist.slice(0, 60)}`);
  }
}

console.log("\n########## VERDICT (empty transcript, so only memory can answer) ##########");
for (const [name, answer, ok] of checks) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(14)} ${answer.replace(/\s+/g, " ").slice(0, 70)}`);
}
const passed = checks.filter(([, , ok]) => ok).length;
console.log(`\n  ${passed}/${checks.length} recalled from memory with no conversation history`);
console.log(`  recall tool invoked ${recallCalls} time(s)`);
process.exit(0);
