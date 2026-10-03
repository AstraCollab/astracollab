import { writeFile as fsWriteFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectScriptedMutation } from "../src/bash-guard.js";
import { createNodeEnvironment } from "../src/node.js";
import { createCodingTools } from "../src/tools.js";

type ToolMap = Record<
	string,
	{ execute: (input: never, ctx: unknown) => Promise<string> }
>;

/**
 * The command from the run that motivated all of this, verbatim in shape: no
 * read, a regex applied to a whole file, and the result written back in one
 * atomic call. It reported success and rewrote 117 lines of a 1,100-line
 * component that no one in the run had opened.
 */
const UNREVIEWABLE_REWRITE =
	"cd resolvewise && python3 - <<'PY'\n" +
	"import re\n" +
	"f='components/dashboard/Dashboard.tsx'\n" +
	"s=open(f).read()\n" +
	"new=re.sub(r'\\n[ \\t]*\\n[ \\t]*\\n+', '\\n\\n', s)\n" +
	"open(f,'w').write(new)\n" +
	"print('collapsed')\n" +
	"PY\n" +
	"git diff --stat components/dashboard/Dashboard.tsx";

describe("inline scripts that rewrite files", () => {
	it("blocks the whole-file regex rewrite that caused the original failure", () => {
		const hit = detectScriptedMutation(UNREVIEWABLE_REWRITE);
		expect(hit?.interpreter).toBe("python3");
	});

	it("routes the model to a tool that can actually do the job", () => {
		// A refusal without a route forward just becomes a retry.
		const message = detectScriptedMutation(UNREVIEWABLE_REWRITE)?.message ?? "";
		expect(message).toContain("edit");
		expect(message).toContain("replace_all");
		expect(message).toContain("write");
	});

	it("explains why the blast radius is the problem, not the language", () => {
		const message = detectScriptedMutation(UNREVIEWABLE_REWRITE)?.message ?? "";
		expect(message).toMatch(/blast radius/i);
		// Real codemods write files and must stay allowed, so the message has to
		// distinguish them or the model will read it as "never use the shell".
		expect(message).toContain("prettier --write");
	});

	it("blocks the other interpreters doing the same thing", () => {
		const blocked = [
			"node -e \"require('fs').writeFileSync('a.ts','x')\"",
			"perl -pi -e 's/foo/bar/g' src/*.ts",
			"python -c \"open('a.txt','w').write('hi')\"",
			'ruby -e \'File.write("a.rb", "x")\'',
		];
		for (const command of blocked) {
			expect(detectScriptedMutation(command), command).not.toBeNull();
		}
	});

	it("allows an interpreter that only reads", () => {
		// Analysing a file with code is cheap and legitimate. The guard is about
		// writing, so refusing this would push the model toward reimplementing
		// analysis with the file tools.
		expect(
			detectScriptedMutation(
				"python3 - <<'PY'\nimport re\ns=open('a.ts').read()\nprint(len(re.findall(r'x', s)))\nPY",
			),
		).toBeNull();
		expect(
			detectScriptedMutation(`python3 -c "print(open('cfg.json').read())"`),
		).toBeNull();
	});

	it("allows a saved script, which is the honest version of the same thing", () => {
		// `write` the script, then run it: reviewable, re-runnable, in the diff.
		expect(detectScriptedMutation("python3 migrate.py")).toBeNull();
		expect(
			detectScriptedMutation("npx tsx scripts/cost-report.mts"),
		).toBeNull();
	});

	it("allows real codemod tools", () => {
		for (const command of [
			"npx prettier --write 'src/**/*.ts'",
			"npx tsc --noEmit --fix",
			"npm run lint -- --fix",
		]) {
			expect(detectScriptedMutation(command), command).toBeNull();
		}
	});

	it("does not fire on the word python inside a search or a path", () => {
		// Anchored to a command head, so ordinary search stays ordinary.
		expect(
			detectScriptedMutation("grep -rn 'python3' src/ && npm test"),
		).toBeNull();
		expect(detectScriptedMutation("ls node_modules/.bin/python3")).toBeNull();
	});

	it("blames the interpreter whose heredoc actually writes", () => {
		// Two interpreters, one command. The `-e` belongs to node; the heredoc and
		// its write belong to python. Getting this backwards would name the wrong
		// tool in the refusal.
		const hit = detectScriptedMutation(
			'node -e "console.log(1)" && python3 - <<\'PY\'\nopen("a","w").write("b")\nPY',
		);
		expect(hit?.interpreter).toBe("python3");
	});

	it("does not follow a later heredoc back to an earlier read-only command", () => {
		expect(
			detectScriptedMutation(
				"python3 -c \"print(open('f').read())\" && node -e \"require('fs').writeFileSync('a','b')\"",
			)?.interpreter,
		).toBe("node");
	});
});

describe("the bash tool enforces it before anything runs", () => {
	let dir: string;
	let tools: ToolMap;

	const run = (command: string): Promise<string> =>
		tools.bash?.execute({ command } as never, {});

	beforeEach(async () => {
		dir = await mkdtemp(nodePath.join(tmpdir(), "nah-guard-"));
		tools = createCodingTools(createNodeEnvironment(dir)) as ToolMap;
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("refuses the command and leaves the file untouched", async () => {
		await fsWriteFile(
			nodePath.join(dir, "a.ts"),
			"const a = 1;\n\n\n\nconst b = 2;\n",
		);
		const out = await run(
			UNREVIEWABLE_REWRITE.replace(
				"components/dashboard/Dashboard.tsx",
				"a.ts",
			),
		);
		expect(out).toContain("DENIED");
		// The point of refusing before execution rather than after: the file must
		// never reach a rewritten state, even briefly.
		const after = await createNodeEnvironment(dir).readFile("a.ts");
		expect(after).toBe("const a = 1;\n\n\n\nconst b = 2;\n");
	});

	it("refuses even when nothing would prompt the user", async () => {
		// In yolo mode there is no approval gate to catch this, so the tool has to.
		// A guard that only worked in the permissioned path would not have stopped
		// the run this came from.
		const dir2 = await mkdtemp(nodePath.join(tmpdir(), "nah-guard-yolo-"));
		const yolo = createCodingTools(createNodeEnvironment(dir2), {
			approveToolCall: async () => true,
		}) as ToolMap;
		const out = await yolo.bash?.execute(
			{ command: UNREVIEWABLE_REWRITE } as never,
			{},
		);
		expect(out).toContain("DENIED");
		await rm(dir2, { recursive: true, force: true });
	});

	it("refuses without spending an approval prompt on it", async () => {
		// The wrapper order matters. `withApproval` sits outside the tool, so a
		// guard implemented inside `bash` would run *after* the prompt — asking a
		// human to approve a regex they cannot see, which looks like diligence and
		// decides nothing.
		let prompted = 0;
		const dir2 = await mkdtemp(nodePath.join(tmpdir(), "nah-guard-ask-"));
		const gated = createCodingTools(createNodeEnvironment(dir2), {
			approveToolCall: async (name) => {
				if (name === "bash") prompted += 1;
				return true;
			},
		}) as ToolMap;
		const out = await gated.bash?.execute(
			{ command: UNREVIEWABLE_REWRITE } as never,
			{},
		);
		expect(out).toContain("DENIED");
		expect(prompted).toBe(0);
		await rm(dir2, { recursive: true, force: true });
	});

	it("still runs the command when the caller opts out", async () => {
		const dir2 = await mkdtemp(nodePath.join(tmpdir(), "nah-guard-open-"));
		const open = createCodingTools(createNodeEnvironment(dir2), {
			allowScriptedMutation: true,
		}) as ToolMap;
		await fsWriteFile(nodePath.join(dir2, "a.ts"), "x\n");
		const out = await open.bash?.execute(
			{ command: `python3 -c "open('a.ts','w').write('y\\n')"` } as never,
			{},
		);
		expect(out).toContain("exit 0");
		await rm(dir2, { recursive: true, force: true });
	});
});
