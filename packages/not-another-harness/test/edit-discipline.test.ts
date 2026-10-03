import { describe, expect, it } from "vitest";

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { createNodeEnvironment } from "../src/node.js";
import { buildSystemPrompt } from "../src/prompt.js";
import { createCodingTools } from "../src/tools.js";

const prompt = buildSystemPrompt({ cwdLabel: "/tmp" });

describe("the prompt teaches the edit phase", () => {
	it("says to plan the edit list before editing", () => {
		// The run that prompted this: 27 steps, two of them edits.
		expect(prompt).toContain("Plan the edit list, then edit");
	});

	it("says not to read a file it is about to replace", () => {
		// Reading first is safe but not free - every line is resent on every later
		// step of the turn.
		expect(prompt).toContain("Do not read a file you are about to replace");
	});

	it("points at replace_all, and keeps codemods to real tools", () => {
		expect(prompt).toContain("replace_all");
		expect(prompt).toContain("codemod");
		// The clause used to say "one scripted bash pass" for a regex change, which
		// is the instruction that produced an unread 117-line rewrite.
		expect(prompt).not.toContain("one scripted `bash` pass");
		expect(prompt).toMatch(/refuses inline interpreter scripts/);
	});

	it("forbids the whole-file rewrite that replaces a targeted change", () => {
		expect(prompt).toContain(
			"Never rewrite a whole file to make a small change",
		);
	});

	it("warns that repeated greps mean the question is not narrowing", () => {
		expect(prompt).toMatch(/the question is not narrowing/);
	});

	it("still advertises outline, which was shipped but never mentioned", () => {
		expect(prompt).toContain("**outline**");
	});

	it("maps shell-as-search onto the real tools", () => {
		expect(prompt).toMatch(/`grep -r`[\s\S]*grep/);
		expect(prompt).toContain("Never reach for bash to look at code");
	});
});

describe("the edit tool explains itself", () => {
	const editDescription = async (): Promise<string> => {
		const dir = await mkdtemp(nodePath.join(tmpdir(), "nah-editdesc-"));
		const tools = createCodingTools(createNodeEnvironment(dir)) as Record<
			string,
			{ description?: string }
		>;
		return tools.edit?.description ?? "";
	};

	it("says when to use it and when not to", async () => {
		const description = await editDescription();
		expect(description).toMatch(/use .write. for a new file or a full rewrite/);
	});

	it("explains the uniqueness rule and what replace_all is for", async () => {
		const description = await editDescription();
		expect(description).toMatch(/exactly once unless .replace_all./);
		// Scope matters: a model that thinks replace_all is project-wide will
		// rewrite files it never read.
		expect(description).toMatch(/never reaches other files/);
	});

	it("warns about the line-number prefixes read adds", async () => {
		// The single most common way an exact-match edit fails.
		const description = await editDescription();
		expect(description.toLowerCase()).toContain(
			"without the line-number prefixes",
		);
	});

	it("says an edit does not require a prior read", async () => {
		const description = await editDescription();
		expect(description).toMatch(/do not need to read a file before replacing/);
	});

	it("is long enough to actually be a description", async () => {
		// Anthropic's guidance: "aim for at least 3-4 sentences". The original was
		// one, which is what left uniqueness and read-first behaviour to guesswork.
		const description = await editDescription();
		expect(description.split(". ").length).toBeGreaterThanOrEqual(4);
	});
});

describe("the bash tool says it will refuse scripted rewrites", () => {
	const bashDescription = async (): Promise<string> => {
		const dir = await mkdtemp(nodePath.join(tmpdir(), "nah-bashdesc-"));
		const tools = createCodingTools(createNodeEnvironment(dir)) as Record<
			string,
			{ description?: string }
		>;
		return tools.bash?.description ?? "";
	};

	it("warns before the refusal, not just after", async () => {
		// A guard the model has never heard of reads as a broken tool.
		const description = await bashDescription();
		expect(description).toMatch(/will refuse an inline interpreter script/);
		expect(description).toMatch(/edit\/replace_all/);
	});

	it("says reading with an interpreter is still allowed", async () => {
		// Otherwise the model concludes the shell is off-limits for analysis too
		// and starts reimplementing counting with file tools.
		const description = await bashDescription();
		expect(description).toMatch(/purely to read or analyse is fine/);
	});
});
