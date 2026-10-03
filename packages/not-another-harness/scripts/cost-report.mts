/**
 * What did a session cost, and what would a different context policy have cost?
 *
 * Answers the question you would otherwise need a fresh agent run to ask, from
 * the trajectory already on disk. No model calls, no money, deterministic.
 *
 *   npx tsx scripts/cost-report.mts ~/.nah/sessions/<file>.jsonl [staticPrefixTokens]
 *
 * The static prefix is the system prompt plus tool schemas, re-sent every step.
 * 6000 is typical; pass the real figure if you know it.
 *
 * These are *processed* tokens - what the transcript asked for. What you are
 * billed is lower by whatever the provider served from cache; measure that with
 * cache-probe.mts / cache-growth.mts.
 */
import { readFileSync } from "node:fs";

import {
	type ContextPolicy,
	analysePolicies,
	hasReasoning,
	messagesFromSessionJsonl,
} from "../src/cost-model.js";

const file = process.argv[2];
if (!file) {
	process.stderr.write(
		"usage: cost-report.mts <session.jsonl> [staticPrefixTokens]\n",
	);
	process.exit(2);
}
const staticPrefix = Number(process.argv[3] ?? 6000);

const messages = messagesFromSessionJsonl(readFileSync(file, "utf8"));
const steps = messages.filter((m) => m.role === "assistant").length;

const policies: ContextPolicy[] = [
	{ kind: "none" },
	{ kind: "recent-rounds", keep: 8 },
	{ kind: "recent-rounds", keep: 6 },
	{ kind: "recent-rounds", keep: 4 },
	{ kind: "recent-rounds", keep: 3 },
	{ kind: "token-budget", tokens: 2000 },
	{ kind: "token-budget", tokens: 1000 },
];

const reports = analysePolicies(messages, policies, staticPrefix);
const base = reports[0]?.totalProcessed;

const label = (p: ContextPolicy): string =>
	p.kind === "none"
		? "no pruning"
		: p.kind === "recent-rounds"
			? `keep ${p.keep} rounds`
			: `budget ${p.tokens} tok`;

process.stdout.write(`${file}\n`);
process.stdout.write(
	`messages ${messages.length}   steps ${steps}   reasoning ${hasReasoning(messages)}\n`,
);
process.stdout.write(
	`static prefix ${staticPrefix} tok re-sent every step\n\n`,
);
process.stdout.write(
	`${"policy".padEnd(18)}${"processed".padStart(11)}${"peak".padStart(9)}${"tool tail".padStart(11)}${"saved".padStart(8)}\n`,
);
for (const report of reports) {
	const saved =
		base === 0 ? 0 : Math.round((1 - report.totalProcessed / base) * 100);
	process.stdout.write(
		`${label(report.policy).padEnd(18)}${String(report.totalProcessed).padStart(11)}${String(report.peakRequest).padStart(9)}` +
			`${String(report.tailToolTokens).padStart(11)}${(saved ? `-${saved}%` : "-").padStart(8)}\n`,
	);
}
const best = reports[reports.length - 1]!;
process.stdout.write(
	`\nbest modelled: ${label(best.policy)} at ${best.totalProcessed} processed (${best.peakRequest} peak).\n`,
);
