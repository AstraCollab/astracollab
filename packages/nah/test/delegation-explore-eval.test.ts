/**
 * Does `delegate_explore` change what the model does?
 *
 * `delegation-eval.test.ts` measures a different variable — whether a child can
 * see the parent's uncommitted work — and its task is an editing task. Neither
 * arm nor metric here would notice `delegate_explore` existing. This suite is
 * built for the read-only child specifically, and it holds the task fixed while
 * the tool is toggled.
 *
 * Three things are measured, and the third is the one that matters:
 *
 *   1. `explored` — did the model reach for the tool at all.
 *   2. `parentTokens` — the claim under test, and it is specifically about the
 *      parent's *context*, not about money. A child's searching never enters the
 *      parent's context, so delegating should shrink what the parent has to
 *      carry. This is the whole justification for the tool: it buys a longer
 *      trace before the parent runs out of room. It is not a claim that
 *      delegation uses fewer tokens.
 *   2b. `totalTokens` (parent + child) — reported because the cost is real and
 *      it is ~5x inline on this fixture. Anthropic measures the same thing on
 *      their own system: agents ~4x a chat, multi-agent ~15x a chat. That ratio
 *      is not a defect, it is the price of the added capacity — but it does mean
 *      `totalTokens` is a cost line, not a score. Read a win as "parent context
 *      down, total flat-ish, correct unchanged". Read `totalTokens` up 5x with
 *      `parentTokens` up too as a regression.
 *   3. `correct` — whether the parent still gave the right answer.
 *
 * (3) exists because (1) and (2) are both easy to win by delegating badly. A
 * model that hands the question to a child and returns a vague summary uses
 * fewer tokens and looks like a win while being strictly worse. A change that
 * raises the delegation rate while lowering `correct` is a regression, so the
 * suite reports all three and the reading is theirs to make.
 *
 * Only infrastructure failures assert. Whether the model chooses to delegate is
 * a judgement call, and a suite that fails when it declines would punish a
 * reasonable choice and train us to distrust the signal.
 *
 * Opt in, since this spends live model calls:
 *   NAH_EXPLORE_EVAL=1 pnpm vitest run test/delegation-explore-eval.test.ts
 */
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { type LanguageModel, generateText } from "ai";

import { createCodingTools, runAgent } from "not-another-harness";
import { createNodeEnvironment } from "not-another-harness/node";

import { createDelegationTools, createSessionOrchestrator } from "../src/delegation.js";
import { resolveModel } from "../src/model.js";
import { type SessionState, composeTurnRequest } from "../src/session.js";

const execFileAsync = promisify(execFile);

const enabled = process.env.NAH_EXPLORE_EVAL === "1";
const modelSpec = process.env.NAH_EVAL_MODEL ?? "openrouter:stealth/space-bunny-alpha";
const repeatCount = Number(process.env.NAH_EVAL_REPEATS ?? 8);
const maxSteps = Number(process.env.NAH_EVAL_MAX_STEPS ?? 20);

const resultsPath = path.resolve(
	process.env.NAH_EXPLORE_RESULTS ??
		fileURLToPath(new URL("../../not-another-harness/evals/explore-results.jsonl", import.meta.url)),
);

/**
 * A repo big enough that answering costs real context.
 *
 * The first draft of this fixture was five small files and the model answered
 * it in four steps without delegating — correctly. Delegation has overhead, and
 * against a trivial search the right call is to just search. Measuring the tool
 * against a task it should decline on would have told us nothing.
 *
 * So the pressure is deliberate:
 *
 *   - 480 routes across 16 service shards, each with its own live and legacy
 *     table and its own handlers, so no single read answers the question.
 *   - `h07` is bound in every shard's live table, so enumerating every route
 *     that resolves to it means opening all of them. There is no search that
 *     shortens this, which is what makes a child's context worth paying for.
 *   - A legacy table mapping the same route names to *different* handlers, so
 *     grep alone yields a plausible wrong answer. Telling the two apart is
 *     judgement, not lookup.
 *   - No interpreter: `bash` and `write` are out of both arms, because with
 *     them the model *executes* the resolver instead of reading it and the task
 *     stops being a search at all.
 *
 * Every run also records `readCalls` and `filesTouched`. Without them a zero
 * delegation rate is unreadable: it looks the same whether the model declined on
 * a hard task or the fixture stayed so easy that inline search was obviously
 * right. Those two fields say which.
 */
const ROUTE_COUNT = 480;

/**
 * Shards, and why the repo is cut this way.
 *
 * The first two fixtures put every route in one `registry.mjs`, which meant one
 * grep of one file resolved the whole question and the parent finished in six
 * steps for about thirteen thousand tokens. A delegation could not possibly pay
 * for itself against that, and a suite measuring it could only ever report zero
 * — a number indistinguishable from "delegation is broken".
 *
 * So the fixture now forces a survey. The live and legacy tables are split
 * across twelve services, each with its own pair of registries and its own
 * handler module. Answering means:
 *
 *   1. finding which shard carries `route31` — a grep of `route31` also matches
 *      `route130`..`route139`, so the first hit is not the answer,
 *   2. telling the live table from the legacy one, which the import graph in
 *      `app.mjs` settles and nothing else does, and
 *   3. sweeping every shard for a second route bound to the same handler, since
 *      the two live bindings sit in different services.
 *
 * Step 3 is the expensive one and it is unavoidable: "is any other route mapped
 * to the same handler" has no answer short of looking at all twelve. Each shard
 * read lands in whichever context did the reading, which is the entire
 * difference delegation is supposed to make.
 */
const SERVICE_NAMES = [
	"checkout",
	"identity",
	"billing",
	"catalog",
	"search",
	"shipping",
	"notifications",
	"analytics",
	"admin",
	"reports",
	"webhooks",
	"support",
	"inventory",
	"pricing",
	"fraud",
	"loyalty",
] as const;

const ROUTES_PER_SHARD = ROUTE_COUNT / SERVICE_NAMES.length;

/**
 * Where inside each shard the extra `h07` binding sits.
 *
 * Chosen so it never lands on route9 or route31, which are placed explicitly.
 * `0` is deliberately avoided too: the very first route of every shard would
 * make the answer look findable by scanning the top of each table, and the point
 * is that the model cannot know where to look without opening everything.
 */
const SHARED_SLOT = Math.min(5, ROUTES_PER_SHARD - 1);

/** Every live route bound to `h07` — the exact set the prompt asks for. */
const routesBoundToH07 = (): string[] =>
	liveRoutes()
		.filter(([, handler]) => handler === "h07")
		.map(([name]) => name)
		.sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));

/**
 * Which shard a route lives in.
 *
 * Derived from the route's position in the live table, which is also how `SEED`
 * slices it — so this and the seed cannot disagree. An earlier version of this
 * asserted `route31` and `route9` were in different shards and passed against a
 * stale copy of the routing table; the invariant was wrong, not the fixture, and
 * it would have kept passing while checking nothing.
 */
const shardOf = (route: string): number => {
	const index = liveRoutes().findIndex(([name]) => name === route);
	if (index < 0) throw new Error(`no such route in the fixture: ${route}`);
	return Math.floor(index / ROUTES_PER_SHARD);
};

const handlerId = (n: number) => `h${String(n % ROUTE_COUNT).padStart(2, "0")}`;

/**
 * The live routing table.
 *
 * `route31` is the one under test and it deliberately shares a handler with
 * `route9`, so the "is anything else mapped here" half of the question has a
 * real answer rather than a "no".
 *
 * The default mapping is offset by 40 rather than the obvious `routeN -> hNN`
 * so that no third route lands on `h07` by accident. An ambiguous "anything
 * else" would let a correct answer name a route the judge does not accept, and
 * the suite would report a good answer as wrong — which is worse than no
 * measurement, because it pushes you toward a weaker prompt to fix a phantom.
 */
const liveRoutes = (): Array<[string, string]> => {
	const routes = Array.from({ length: ROUTE_COUNT }, (_, i) => [
		`route${i}`,
		handlerId(i + 40),
	] as [string, string]);
	routes[31] = ["route31", "h07"];
	routes[9] = ["route9", "h07"];
	// `h07` is bound in ONE MORE place per shard, so enumerating every route that
	// resolves to it means reading every live table.
	//
	// This is the property that makes the task a sweep rather than a lookup. With
	// only `route9` and `route31` bound to `h07`, `grep -w h07` returned both in
	// one call and solo answered having read 6 of 16 shards — no pressure, and
	// therefore nothing for a child to relieve. Spreading one binding per shard
	// puts the answer out of reach of any single search: there is no shortcut to
	// a set that is only fully visible once every table has been opened.
	//
	// Placed at a fixed offset inside each shard so the answer is deterministic
	// and the judge can name the expected count.
	for (let shard = 0; shard < SERVICE_NAMES.length; shard += 1) {
		const index = shard * ROUTES_PER_SHARD + SHARED_SLOT;
		if (index === 31 || index === 9) continue;
		routes[index] = [`route${index}`, "h07"];
	}
	// Any default mapping sends exactly one other route to `h07`, and hard-coding
	// which one breaks the moment the offset changes. Move whichever it turns out
	// to be onto a handler nothing else claims — but only routes the default put
	// there. The spread above deliberately claims many, and this cleanup used to
	// strip one of them, which is how a16-shard fixture silently came out with
	// 15 shards holding h07 while the invariant counted the other way.
	const spread = new Set(
		Array.from({ length: SERVICE_NAMES.length }, (_, shard) => `route${shard * ROUTES_PER_SHARD + SHARED_SLOT}`),
	);
	const stray = routes.findIndex(
		([name, handler]) => handler === "h07" && name !== "route31" && name !== "route9" && !spread.has(name),
	);
	if (stray >= 0) {
		const taken = new Set(routes.map(([, handler]) => handler));
		let replacement = 0;
		while (taken.has(handlerId(replacement))) replacement += 1;
		routes[stray] = [routes[stray][0], handlerId(replacement)];
	}
	return routes;
};

/**
 * The decoy maps the same names to different handlers, offset by one.
 *
 * Offset rather than random so the wrong answer is always *plausible* — a model
 * that reads the legacy registry gets a real handler and a real file name, and
 * only the import graph in `app.mjs` shows which registry is live.
 */
const legacyRoutes = (): Array<[string, string]> =>
	liveRoutes().map(([name, handler]) => [name, handlerId(Number(handler.slice(1)) + 1)]);

const registrySource = (routes: Array<[string, string]>, imports: string): string =>
	[
		imports,
		"",
		"export const routes = {",
		...routes.map(([name, handler]) => `  ${name}: ${handler},`),
		"};",
		"",
		"export const resolve = (route) => routes[route];",
		"",
	].join("\n");

const shardSlice = <T,>(items: readonly T[], shard: number): T[] =>
	items.slice(shard * ROUTES_PER_SHARD, (shard + 1) * ROUTES_PER_SHARD);

const SEED = (): Record<string, string> => {
	const files: Record<string, string> = {};
	const live = liveRoutes();
	const legacy = legacyRoutes();

	SERVICE_NAMES.forEach((service, shard) => {
		const dir = `services/${service}`;
		const routes = shardSlice(live, shard);
		const legacyInShard = shardSlice(legacy, shard);
		// Both tables import from one handler module per service, so a handler's
		// name alone still cannot say which registry routes to it — only the
		// table entry can. The legacy table names different handlers, so the
		// module has to define the union of both or the import would not resolve.
		const handlers = [...new Set([...routes.map(([, handler]) => handler), ...legacyInShard.map(([, handler]) => handler)])];
		const imports = `import { ${handlers.join(", ")} } from './handlers.mjs';`;

		files[`${dir}/routes.mjs`] = registrySource(routes, imports);
		files[`${dir}/routes.legacy.mjs`] = registrySource(legacyInShard, imports);
		files[`${dir}/handlers.mjs`] = [
			...handlers.map(
				(id) => `export const ${id} = (p) => ({ kind: '${id}', route: '${`route${Number(id.slice(1))}`}', p });`,
			),
			"",
		].join("\n");
	});

	// The live tables and nothing else. Whether `route31` resolves through a live
	// or a legacy shard is decided here and nowhere else — every table in the
	// repo contains a `route31` row, so the import graph is the only thing that
	// separates them.
	files["app.mjs"] = [
		...SERVICE_NAMES.map(
			(service) => `import { routes as ${service}Routes } from './services/${service}/routes.mjs';`,
		),
		"",
		"const tables = [",
		...SERVICE_NAMES.map((service) => `  ${service}Routes,`),
		"];",
		"",
		"export const resolve = (route) => {",
		"  for (const table of tables) {",
		"    if (route in table) return table[route];",
		"  }",
		"};",
		"",
		"export const handle = (route, payload) => resolve(route)(payload);",
		"",
	].join("\n");

	return files;
};

/**
 * Shaped like a question, not a ticket.
 *
 * Every word here is about finding out. There is nothing to edit, no failing
 * test, no "and then" — which is exactly the situation the read-only child
 * exists for, and the situation the old tools could not serve without a
 * worktree and a diff for a question.
 */
/**
 * Shaped like a question, not a ticket.
 *
 * Two properties are deliberate, and both were learned from runs that failed to
 * measure anything:
 *
 *   - "count them" rather than "is there another". Asking whether another route
 *     shares the handler is answerable from the one shard holding `route31`, so
 *     the sweep was optional and solo finished in 6 steps having read 6 of 16
 *     shards. Asking for the full set of routes bound to `h07` has no answer
 *     short of reading every live table, which is the sweep the whole design is
 *     meant to create.
 *   - No code to run. `bash` is out of both arms for exactly this reason: with
 *     it, the model executed `resolve('route31')` and answered having absorbed
 *     5 files. A question you cannot run is a question you must read.
 *
 * The trap stays — every shard has a legacy twin mapping the same route names to
 * different handlers, and only `app.mjs`'s import list says which column runs.
 */
const PROMPT =
	"I'm wiring a checkout flow and need a complete picture of the handler registry before I touch it. " +
	"Find every route that resolves to the handler h07 in the tables that are actually imported by the " +
	"app entrypoint, and tell me which file defines that handler. There is more than one registry in " +
	"here — answer from the code that actually runs, list every matching route, and don't change anything.";

/** Arms. The only difference is whether the read-only child is on the table. */
const arms = [
	{ id: "with-explore", delegation: true },
	{ id: "solo", delegation: false },
] as const;

/**
 * Run git, and report both streams on failure.
 *
 * `execFile` puts only stderr in its message, and git's most common non-zero
 * exit here — "nothing to commit" — goes to *stdout*. Without this the failure
 * reads as `Command failed: git commit` with nothing after it, which is how a
 * fixture bug reads as a git bug.
 */
const git = async (cwd: string, args: string[]): Promise<string> => {
	try {
		return (await execFileAsync("git", args, { cwd })).stdout.trim();
	} catch (error) {
		const e = error as { stdout?: string; stderr?: string };
		throw new Error(
			`git ${args.join(" ")} failed: ${[e.stderr?.trim(), e.stdout?.trim()].filter(Boolean).join(" | ") || "(no output)"}`,
		);
	}
};

const toolCallsCalled = (messages: Array<{ content: unknown }>): Array<{ name: string; input: unknown }> => {
	const calls: Array<{ name: string; input: unknown }> = [];
	for (const message of messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (
				part &&
				typeof part === "object" &&
				"type" in part &&
				part.type === "tool-call" &&
				"toolName" in part &&
				typeof part.toolName === "string"
			) {
				calls.push({ name: part.toolName, input: "input" in part ? part.input : undefined });
			}
		}
	}
	return calls;
};

const toolNamesCalled = (messages: Array<{ content: unknown }>): string[] =>
	toolCallsCalled(messages).map((call) => call.name);

/** The read-only tools, plus bash because the model reaches for it instead of paging. */
const SEARCH_TOOLS = new Set(["read", "list", "grep", "glob", "bash"]);

/**
 * How much of the repo the *parent* absorbed itself.
 *
 * This is the measurement that makes a zero delegation rate mean something. An
 * explore rate of zero is ambiguous on its own: it looks identical whether the
 * model declined to delegate on a task that was genuinely easy, or the fixture
 * was too small for the sweep to cost anything and the model had no reason to
 * delegate. Those are opposite findings and the rate alone cannot tell them
 * apart.
 *
 * `readCalls` counts the calls; `filesTouched` counts the distinct paths, because
 * twelve greps against one file and twelve reads across twelve shards cost the
 * same number of steps but nowhere near the same context. When `filesTouched`
 * stays in the single digits on the solo arm, the flood did not happen and a
 * zero is not evidence about `delegate_explore`.
 *
 * Paths are extracted from `input` rather than from tool output, so this counts
 * what the parent asked for. `bash` contributes nothing: its command string
 * rarely names a path the fixtures own, and guessing at shell words would make
 * this number look more precise than it is.
 */
const parentSearchFootprint = (
	calls: Array<{ name: string; input: unknown }>,
): { readCalls: number; filesTouched: string[] } => {
	const searched = calls.filter((call) => SEARCH_TOOLS.has(call.name));
	const files = new Set<string>();
	for (const call of searched) {
		const input = call.input as { path?: unknown } | undefined;
		if (typeof input?.path === "string" && input.path.length > 0 && call.name !== "bash") {
			files.add(input.path);
		}
	}
	return { readCalls: searched.length, filesTouched: [...files].sort() };
};

/**
 * Did the parent actually answer, and did it get it right?
 *
 * Both halves are required. Naming the handler without the shared route means
 * it guessed the route and never confirmed it; naming the route without the
 * handler file means it read the registry and stopped, which is the decoy.
 */
/**
 * Mentioned exactly, not merely as a substring.
 *
 * `body.includes("route9")` is true for `route90`, `route91`, ... — and at 480
 * routes the fixture contains all of them. That made the judge score a run which
 * answered "**no** other route maps to that handler" as correct purely because
 * the model listed the other `h07` candidates in its reasoning, and every arm
 * reported `correct: 4/4` while getting the question's second half wrong. A judge
 * that cannot tell a yes from a no is worse than no judge, because the suite
 * would have kept reporting a healthy suite.
 */
const mentions = (body: string, token: string): boolean =>
	new RegExp(`\\b${token}\\b`).test(body);

const judge = (text: string | undefined): { correct: boolean; namedHandler: boolean; namedShared: boolean } => {
	const body = (text ?? "").toLowerCase();
	// h07 is the live answer; the legacy table routes route31 to h08, so naming
	// the handler is what separates reading the right table from the wrong one.
	const namedHandler = mentions(body, "h07");
	// `route9` shares h07 with route31 in the live table. Matching it is what
	// distinguishes the model that did the cross-shard sweep from the one that
	// read the shard holding route31 and stopped — the sweep is the whole task.
	const namedShared = mentions(body, "route9");
	return { correct: namedHandler && namedShared, namedHandler, namedShared };
};

/**
 * The rubric, and why token presence is no longer the verdict.
 *
 * `judge` above credits any answer containing `h07` and `route9` anywhere. On
 * the first pass of this fixture it scored `correct: true` for a run that
 * answered "**no** other route is mapped to that handler" — wrong, because
 * `route9` shares `h07` — since `route90`-`route99` and a raw grep listing of the
 * `h07` rows both contain the substring. Token presence cannot tell a right
 * conclusion from a wrong one quoted next to it, which is the only job a
 * correctness signal has.
 *
 * So the rule checks stay as a cheap floor that needs no model call and cannot
 * fail open, and a rubric judge becomes the reported verdict. Anthropic's
 * multi-agent post reaches the same design for the same reason: a rubric over
 * factual accuracy and completeness, graded by a model, separated real wins from
 * ones that only look like them where turn-by-turn or substring checks could not.
 */
const RUBRIC = [
	"The answer must name h07 as a handler that route31 resolves to in the live (imported) tables.",
	"The answer must name services/identity/handlers.mjs as the file defining that handler.",
	`The complete set of live routes bound to h07 is ${routesBoundToH07().join(", ")} — ${routesBoundToH07().length} routes. An answer that lists only route9 and route31, or that says "no other route maps to it", is incomplete and scores at most 0.4.`,
	"An answer missing any one of those routes is incomplete. Judge the conclusion, not tokens quoted inside reasoning: quoting a grep listing that happens to contain a correct route name does not count as having reported it.",
].join("\n");

const JUDGE_SYSTEM = `You score one answer to one question against a rubric.

Reply with a single JSON object and nothing else:
{"score": <number between 0 and 1>, "reason": "<one or two sentences, citing the specific part of the answer that decided it>"}`;

/**
 * Grade one answer against `RUBRIC`.
 *
 * Plain `generateText` with hand-rolled JSON recovery rather than
 * `generateObject`, matching `judgeScorer` in nah-studio: models without
 * structured-output support throw `AI_NoObjectGeneratedError`, and a judge that
 * silently fails every run becomes a column of zeros that reads as "the agent is
 * bad at this". `null` means the judge did not return usable JSON, and is
 * reported as `judgeSkipped` rather than folded into the mean — a missing score
 * is not a score of zero.
 */
const gradeAnswer = async (
	model: LanguageModel,
	question: string,
	answer: string,
): Promise<{ score: number; reason: string } | null> => {
	const result = await generateText({
		model,
		system: JUDGE_SYSTEM,
		prompt: [
			"<question>",
			question,
			"</question>",
			"<answer>",
			answer,
			"</answer>",
			"Rubric:",
			RUBRIC,
			"",
			"Judge only the answer: do not reward length, confidence, or effort. Score 1 only when every rubric line is satisfied. No prose, no code fences.",
		].join("\n"),
		maxOutputTokens: 400,
	});

	// Brace-balanced slice, so a stray `}` in the judge's prose cannot abort the
	// parse — the same recovery judgeScorer does.
	const body = /```(?:json)?\s*([\s\S]*?)```/i.exec(result.text)?.[1] ?? result.text;
	const start = body.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let slice: string | null = null;
	for (let index = start; index < body.length; index += 1) {
		const char = body[index]!;
		if (inString) {
			if (char === "\\") index += 1;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) {
				slice = body.slice(start, index + 1);
				break;
			}
		}
	}
	if (!slice) return null;

	try {
		const parsed = JSON.parse(slice) as { score?: unknown; reason?: unknown };
		const raw = typeof parsed.score === "number" ? parsed.score : Number(parsed.score);
		if (!Number.isFinite(raw)) return null;
		// Clamped, because a judge reporting 7 on a 0-1 scale is reporting a
		// feeling, and an unbounded value silently wrecks every average it enters.
		return {
			score: Math.min(1, Math.max(0, raw)),
			reason: typeof parsed.reason === "string" ? parsed.reason : "(no reason given)",
		};
	} catch {
		return null;
	}
};

/**
 * The fixture's own invariants.
 *
 * These run always, and cheaply, because `judge` is only meaningful while they
 * hold. If someone retunes the routing table and leaves three routes sharing
 * `h07`, the judge will start marking correct answers wrong and the suite will
 * report a regression that is really a broken fixture — the worst kind of
 * measurement error, because it points at the prompt when the fault is here.
 */
describe("the explore eval's fixture still says what the judge assumes", () => {
	const live = liveRoutes();
	const legacy = legacyRoutes();

	it("routes route31 to h07 in the live table and somewhere else in the legacy one", () => {
		const handlerFor = (table: Array<[string, string]>, route: string) =>
			table.find(([name]) => name === route)?.[1];
		expect(handlerFor(live, "route31")).toBe("h07");
		// The decoy is what stops grep from being enough.
		expect(handlerFor(legacy, "route31")).not.toBe("h07");
	});

	it("binds h07 once per shard, so enumerating it requires reading every live table", () => {
		// The property the whole task rests on. `h07` appears in every shard's live
		// table, so there is no partial answer and no single search that finds the
		// set — the model has to open all of them. Two bindings would let `grep -w
		// h07` close the question in one call, which is exactly what happened before.
		const bound = routesBoundToH07();
		const shardsHoldingH07 = new Set(bound.map((name) => shardOf(name)));
		expect(shardsHoldingH07.size).toBe(SERVICE_NAMES.length);
		// One slot binding per shard, plus the two pinned routes: route31 (which is not
		// a slot binding — shard 1's slot is route35) and route9 (which sits in
		// shard 0 alongside that shard's slot binding, so shard 0 holds two).
		expect(bound.length).toBe(SERVICE_NAMES.length + 2);
		expect(bound).toContain("route31");
		expect(bound).toContain("route9");
	});

	it("names every route once and every handler in the hNN shape", () => {
		expect(new Set(live.map(([name]) => name)).size).toBe(ROUTE_COUNT);
		// Two- and three-digit both occur past 100; the old `/^h\d\d$/` would fail
		// on a scaled fixture and read as a routing bug.
		expect(live.every(([, handler]) => /^h\d{2,3}$/.test(handler))).toBe(true);
	});

	it("writes a repo whose two registries disagree about some routes", () => {
		// If they agreed the decoy would be pointless and the task would collapse
		// back into a single lookup, which is the mistake the first fixture made.
		const disagreeing = live.filter(([name], i) => live[i][1] !== legacy[i][1]);
		expect(disagreeing.length).toBeGreaterThan(ROUTE_COUNT / 2);
	});

	it("scatters h07 across shards so no single read settles the question", () => {
		// The load-bearing property, stated as what the fixture actually builds.
		// `h07` reaches the repo three ways: the two live bindings (route31 in one
		// shard, route9 in another) and a legacy decoy in a third shard, each with
		// a live twin carrying the same name a line away. A parent that reads one
		// table learns nothing about the other two, and grep alone cannot separate
		// them — only app.mjs's import list says which column runs.
		const seed = SEED();
		const tables = Object.entries(seed).filter(
			([file, body]) => file.includes("routes") && /\bh07\b/.test(body),
		);
		const shards = new Set(tables.map(([file]) => file.split("/")[1]));
		expect(tables.length).toBeGreaterThanOrEqual(3);
		expect(shards.size).toBeGreaterThanOrEqual(2);
		// And the live binding for route31 is genuinely elsewhere from the other
		// one, so the "anything else mapped to it" half cannot be answered from the
		// shard the model happens to open first.
		expect(shardOf("route31")).not.toBe(shardOf("route9"));
	});

	it("makes a route31 grep ambiguous with substring neighbours", () => {
		// `route31` is a substring of `route310`..`route319`, which live in a
		// different shard. Grep returns both shards and no row is self-identifying
		// as the answer, so the search cannot be closed from the first match.
		const seed = SEED();
		const carrying = new Set(
			Object.entries(seed)
				.filter(([file, body]) => file.endsWith(".mjs") && /\broute31\d/.test(body))
				.map(([file]) => file.split("/")[1]),
		);
		expect(carrying.size).toBeGreaterThanOrEqual(2);
	});

	it("is big enough that answering it inline costs real context", () => {
		// The check that stops this suite quietly going back to measuring nothing.
		// The first fixture satisfied every other invariant in this file and still
		// let the parent answer in six steps, because nothing here forced volume.
		// If the repo shrinks below these floors, treat the run as uninformative
		// rather than as a zero.
		const seed = SEED();
		const bytes = Object.values(seed).reduce((total, body) => total + body.length, 0);
		expect(Object.keys(seed).length).toBeGreaterThanOrEqual(SERVICE_NAMES.length * 3 + 1);
		expect(bytes).toBeGreaterThan(60_000);
		expect(ROUTE_COUNT).toBeGreaterThanOrEqual(480);
		// A route's two live bindings must stay in different shards. Every
		// ROUTES_PER_SHARD that puts them together would quietly restore the easy
		// fixture, and `ROUTE_COUNT` is the number to change when scaling.
		expect(ROUTES_PER_SHARD).toBeGreaterThan(9);
	});

	it("registers delegate_explore alongside the editing delegates", () => {
		// Guards the reading of every run in this file. An explore rate of zero
		// means one of two very different things — the model declined, or the tool
		// was never on the table — and the summary line alone cannot tell them
		// apart. Cheap, model-free, and it settles the question before any tokens
		// are spent.
		const orchestrator = createSessionOrchestrator({
			cwd: process.cwd(),
			system: "test",
			// Never invoked: this only inspects the tool map, it does not run a child.
			getModel: () => ({}) as never,
			approve: async () => true,
		});
		const tools = createDelegationTools({ orchestrator, approve: async () => true });
		expect(Object.keys(tools).sort()).toEqual([
			"delegate_explore",
			"delegate_explores",
			"delegate_task",
			"delegate_tasks",
		]);
	});

	it("keeps app.mjs importing only the live tables, so which shard runs is decidable", () => {
		const app = SEED()["app.mjs"] ?? "";
		// Every shard has a legacy twin carrying the same route names, so the
		// import list is the only thing that says which column is live. If app.mjs
		// ever reached for a legacy table the question would have no single answer.
		expect(app).toContain("routes.mjs");
		expect(app).not.toContain("routes.legacy.mjs");
		expect(app).toContain("export const handle = (route, payload) => resolve(route)(payload);");
	});
});

it("leaves no shortcut to the answer, so answering it means reading every table", () => {
		// The pressure claim, asserted rather than assumed. Earlier fixtures all
		// failed this: one file answered it in a read, and a two-match `h07` let a
		// single `grep -w h07` close the question. If `h07` is in every live table
		// then the only way to know the full set is to open all of them, and there
		// is no search that shortens the sweep — which is the precondition for a
		// child to be worth its overhead at all.
		const seed = SEED();
		const liveTables = Object.keys(seed).filter((file) => file.endsWith("routes.mjs"));
		expect(liveTables.length).toBe(SERVICE_NAMES.length);
		const carryingH07 = liveTables.filter((file) => /\bh07\b/.test(seed[file] ?? ""));
		expect(carryingH07.length).toBe(SERVICE_NAMES.length);
		// And enough total material that reading it all is a real cost, not a
		// formality — the property that made the solo arm finish in 7 steps when it
		// could read only a handful of shards.
		const bytes = Object.values(seed).reduce((total, body) => total + body.length, 0);
		expect(bytes).toBeGreaterThan(60_000);
	});

	it("does not let a neighbouring route name stand in for the answer", () => {
		// The judge matches `route9` and `h07` with word boundaries, and the
	// fixture is dense enough that substring matches are guaranteed. This asserts
	// the density — that routes and handlers differing only by a trailing digit
	// really are present — because without them a regression to `includes` would
	// pass every other test in this file while quietly scoring wrong answers right.
		const live = liveRoutes();
		// `route90`..`route99` all exist, so a substring judge cannot tell a model
		// that answered the question from one that merely mentioned route90. That
		// density is the precondition for this test mattering — without it a
		// regression to `includes` would pass every other test in this file while
		// quietly scoring wrong answers as correct.
		expect(live.filter(([name]) => /^route9\d$/.test(name)).length).toBe(10);
		expect(judge("route31 resolves to h07 in services/identity/routes.mjs. No other route maps to it.")).toMatchObject({
			namedHandler: true,
			namedShared: false,
			correct: false,
		});
		// And the version that went wrong in the first run: right handler, wrong
		// answer to "anything else", but `route90` present in the reasoning.
		expect(judge("route31 -> h07. h07 also appears for route90 and route447; no other route maps to it.")).toMatchObject({
			namedHandler: true,
			namedShared: false,
			correct: false,
		});
		expect(judge("route31 resolves to h07, and route9 is mapped to that same handler.")).toMatchObject({
			correct: true,
		});
		// The legacy decoy must name a *different* handler, or "named the handler"
		// would not separate reading the live table from the wrong one.
		expect(legacyRoutes().find(([name]) => name === "route31")?.[1]).not.toBe("h07");
	});

describe.skipIf(!enabled)("does the read-only child get used?", () => {
	const runId = `${new Date().toISOString()}-${process.pid}`;
	const records: Array<Record<string, unknown>> = [];

	afterAll(async () => {
		if (!enabled || records.length === 0) return;
		const mean = (values: number[]): number | null =>
			values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : null;
		const summary = arms.map((arm) => {
			const own = records.filter((record) => record.arm === arm.id);
			const usable = own.filter((record) => record.infra !== true);
			const explored = usable.filter((record) => record.explored === true).length;
			const filesTouched = usable.map((record) => record.filesTouched as number);
			const readCalls = usable.map((record) => record.readCalls as number);
			return {
				arm: arm.id,
				attempts: own.length,
				usable: usable.length,
				explored,
				exploreRate: usable.length ? explored / usable.length : null,
				correct: usable.filter((record) => record.correct === true).length,
				// The rubric judge, with non-responses excluded from the mean rather
				// than counted as zero — a judge that failed to answer is not a judge
				// that scored badly, and folding it in as 0 would make an outage look
				// like a regression in the agent.
				meanJudgeScore: mean(
					usable
						.map((record) => record.judgeScore as number | null)
						.filter((score): score is number => typeof score === "number"),
				),
				judgeSkipped: usable.filter((record) => record.judgeSkipped === true).length,
				// The split, not the total, is the finding. `meanTotalTokens` is the cost of
				// the added capacity and is expected to be several times inline —
				// Anthropic reports the same shape for their own agents (~4x a chat,
				// multi-agent ~15x). What would make this a regression is
				// `meanParentTokens` going *up* while the child does the work, because
				// then the parent paid twice and still delegated.
				meanParentTokens: mean(usable.map((record) => record.parentTokens as number)),
				meanChildTokens: mean(usable.map((record) => record.childTokens as number)),
				meanTotalTokens: mean(usable.map((record) => record.totalTokens as number)),
				// The context pressure, not just the outcome. A low `meanFilesTouched`
				// alongside a zero `exploreRate` means the fixture never made the
				// sweep cost anything and the zero says nothing about the tool.
				meanFilesTouched: mean(filesTouched),
				maxFilesTouched: filesTouched.length ? Math.max(...filesTouched) : null,
				meanReadCalls: mean(readCalls),
				infraErrors: own.filter((record) => record.infra === true).length,
			};
		});
		const line = JSON.stringify({ runId, model: modelSpec, summary });
		process.stdout.write(`[nah-explore-eval-summary] ${line}\n`);

		// The invariant this suite exists to defend, asserted rather than reported.
		//
		// Everything else in the summary is a judgement call, but this one is not:
		// a child's whole purpose is that its searching never enters the parent's
		// context. If the with-explore arm leaves the parent carrying *more* tokens
		// than the solo arm while the child did the reading, the tool has failed at
		// the only thing it was built for — the parent paid for the delegation and
		// still did the work.
		//
		// `totalTokens` is deliberately not asserted. Delegation costs ~5x tokens in
		// total and that is the price of the capacity (Anthropic measures the same
		// shape: agents ~4x a chat, multi-agent ~15x). Asserting a ratio there would
		// pin the eval to today's overhead and make a real improvement to the child's
		// efficiency look like a failure.
		//
		// Guarded on sample size because a mean over 1-2 runs is noise, and a
		// spurious failure here would train people to ignore the one assertion that
		// matters.
		const solo = summary.find((entry) => entry.arm === "solo");
		const withExplore = summary.find((entry) => entry.arm === "with-explore");
		const parentTokensWentDown =
			solo?.meanParentTokens != null &&
			withExplore?.meanParentTokens != null &&
			withExplore.meanParentTokens < solo.meanParentTokens;

		if ((solo?.usable ?? 0) >= 3 && (withExplore?.usable ?? 0) >= 3) {
			expect(
				parentTokensWentDown,
				`parentTokens must be lower when the search is delegated — that is the whole point of the tool. ` +
					`with-explore ${withExplore?.meanParentTokens} vs solo ${solo?.meanParentTokens} over ` +
					`${withExplore?.usable}/${solo?.usable} usable runs. If the child is doing the reading and the ` +
					`parent still pays, delegation is costing context rather than saving it. ` +
					`Metrics appended to ${resultsPath}: ${line}`,
			).toBe(true);
		} else {
			process.stdout.write(
				`[nah-explore-eval-summary] parentTokens invariant not asserted: ` +
					`needs >=3 usable runs per arm, have ${withExplore?.usable ?? 0}/${solo?.usable ?? 0}\n`,
			);
		}
		await mkdir(path.dirname(resultsPath), { recursive: true });
		await appendFile(
			resultsPath,
			`${JSON.stringify({ schemaVersion: 1, recordType: "explore_summary", runId, model: modelSpec, recordedAt: new Date().toISOString(), summary })}\n`,
			"utf8",
		);
	});

	it.each(
		arms.flatMap((arm) =>
			Array.from({ length: repeatCount }, (_, index) => ({ arm, repetition: index + 1 })),
		),
	)("arm $arm.id repetition $repetition", async ({ arm, repetition }) => {
		const workspace = await mkdtemp(path.join(tmpdir(), "nah-explore-eval-"));
		const record: Record<string, unknown> = {
			schemaVersion: 1,
			runId,
			recordedAt: new Date().toISOString(),
			model: modelSpec,
			arm: arm.id,
			repetition,
			explored: false,
			exploreCalls: 0,
			childrenStarted: 0,
			correct: false,
			judgeScore: null,
			judgeReason: null,
			judgeSkipped: false,
			parentTokens: 0,
			childTokens: 0,
			totalTokens: 0,
			infra: false,
			steps: 0,
			readCalls: 0,
			filesTouched: 0,
			elapsedMs: 0,
		};
		const startedAt = Date.now();
		try {
			for (const [file, contents] of Object.entries(SEED())) {
				await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
				await writeFile(path.join(workspace, file), contents);
			}
			await git(workspace, ["init", "--initial-branch=main"]);
			await git(workspace, ["config", "user.email", "eval@example.com"]);
			await git(workspace, ["config", "user.name", "Eval"]);
			await git(workspace, ["add", "-A"]);
			await git(workspace, ["commit", "-m", "seed"]);

			const resolved = await resolveModel(modelSpec);
			const approve = async () => true;
			const children: string[] = [];
			let childTokens = 0;
			const orchestrator = createSessionOrchestrator({
				cwd: workspace,
				system: "You are a coding agent working in this repository.",
				getModel: () => resolved.model,
				approve,
				// Child spend has to be counted, or the headline metric lies by
				// omission. `parentTokens` is the parent's own usage only, so an arm
				// that delegates moves tokens out of the number this suite reports
				// and into one it discards. Comparing arms on `parentTokens` alone
				// flatters delegation by exactly the work it absorbed — which is the
				// opposite of the claim under test.
				onChildUsage: (usage) => {
					childTokens += usage.totalTokens;
				},
				onChildEvent: (event) => {
					if (event.type === "subtask-start") children.push(event.title);
				},
			});
			const { delegate_task, delegate_tasks, delegate_explore, delegate_explores } = createDelegationTools({ orchestrator, approve });

			// The arm under test: the same model, the same task, the same prompt
			// builder — the only difference is whether the read-only child is
			// reachable. Nothing else varies.
			const delegationTools = arm.delegation
				? { delegate_task, delegate_tasks, delegate_explore, delegate_explores }
				: {};

			const { system } = composeTurnRequest(
				{
					system: "You are a coding agent working in this repository.",
					tools: delegationTools as unknown as SessionState["tools"],
					taskLedger: undefined,
				} as unknown as SessionState,
				PROMPT,
				"",
			);

			// `bash` and `write` are removed from both arms, and that is the whole reason
			// this fixture was rebuilt.
			//
			// With them, the model does not do the search — it *executes* it. The
			// first run of the scaled fixture wrote a probe file and ran
			// `resolve('route31')` through node, got `h07` in one call, and answered
			// in 7 steps having absorbed 5 files. Every arm reported `correct: 4/4`
			// and a 0% delegation rate, which is exactly the uninformative result this
			// suite exists to replace: the task was computable, so reading it was
			// never worth delegating no matter how large the repo got.
			//
			// A question you cannot run is a question you must read. Removing the
			// interpreter restores that, and it is symmetric — both arms lose the
			// same tools, so the only difference between them remains whether the
			// read-only child is on the table.
			const { bash: _bash, write: _write, ...readOnlyTools } = createCodingTools(
					createNodeEnvironment(workspace),
				) as Record<string, unknown>;

			const run = runAgent({
				model: resolved.model,
			 system,
				prompt: PROMPT,
				tools: {
					...readOnlyTools,
					...delegationTools,
				},
				maxSteps,
				compaction: "off",
			});
			const result = await run.result;
			const calls = toolCallsCalled(result.messages);
			const called = calls.map((call) => call.name);
			// Both explore tools count as delegation. Counting only the single-child one
			// would report a regression the moment a fan-out started working.
			const exploreCalls = called.filter(
				(name) => name === "delegate_explore" || name === "delegate_explores",
			).length;
			const footprint = parentSearchFootprint(calls);
			const verdict = judge(result.text);
			// The rubric judge is the reported verdict; `verdict.correct` stays as the
			// cheap rule check. Both are recorded, because the gap between them is the
			// measurement — a large gap means the rule check is crediting answers it
			// cannot actually verify, which is what happened on the first pass.
			const graded = await gradeAnswer(resolved.model, PROMPT, result.text ?? "");
			record.judgeScore = graded?.score ?? null;
			record.judgeReason = graded?.reason ?? null;
			record.judgeSkipped = graded === null;

			record.steps = result.steps;
			record.reason = result.reason;
			record.toolNames = [...new Set(called)].sort();
			record.exploreCalls = exploreCalls;
			record.explored = exploreCalls > 0;
			record.childrenStarted = children.length;
			record.parentTokens = result.usage.totalTokens;
			record.childTokens = childTokens;
			// What the run actually cost, whoever paid for it. This is the number to
			// compare arms on; `parentTokens` alone says delegation is free.
			record.totalTokens = result.usage.totalTokens + childTokens;
			record.readCalls = footprint.readCalls;
			record.filesTouched = footprint.filesTouched.length;
			record.fileList = footprint.filesTouched;
			record.correct = verdict.correct;
			record.namedHandler = verdict.namedHandler;
			record.namedShared = verdict.namedShared;
			record.answer = (result.text ?? "").slice(0, 400);
			record.infra = result.usage.totalTokens === 0 || result.reason === "error";
		} catch (error) {
			record.infra = true;
			record.error = error instanceof Error ? error.message : String(error);
		} finally {
			record.elapsedMs = Date.now() - startedAt;
			records.push(record);
			process.stdout.write(`[nah-explore-eval] ${JSON.stringify(record)}\n`);
			await mkdir(path.dirname(resultsPath), { recursive: true });
			await appendFile(
				resultsPath,
				`${JSON.stringify({ schemaVersion: 1, recordType: "explore_run", ...record })}\n`,
				"utf8",
			);
			await rm(workspace, { recursive: true, force: true });
		}

		// The harness ran. Whether the model delegated, and whether it answered
		// well, are the measurements — not pass conditions.
		expect(
			record.infra,
			`Infrastructure failure; metrics appended to ${resultsPath}: ${JSON.stringify(record)}`,
		).toBe(false);
	}, 600_000);
});
