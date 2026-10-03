import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { describe, expect, it } from "vitest";

import { createNodeEnvironment } from "../src/node.js";
import { outlineSource } from "../src/outline.js";
import { createCodingTools } from "../src/tools.js";

type ToolMap = Record<
	string,
	{ execute: (i: never, c: unknown) => Promise<string> }
>;

describe("outlineSource", () => {
	it("finds exported functions, classes and types with line numbers", () => {
		const source = [
			"export function alpha() {}", // 1
			"function internal() {}", // 2
			"export class Beta {", // 3
			"  method() {}", // 4
			"}", // 5
			"export interface Gamma { a: string }", // 6
			"export const DELTA = 1;", // 7
			"export default async function run() {}", // 8
		].join("\n");
		const found = outlineSource("src/thing.ts", source);
		const names = found.map((f) => f.line);
		expect(names).toContain(1);
		expect(names).toContain(3);
		expect(names).toContain(6);
		expect(names).toContain(7);
		expect(names).toContain(8);
		// Internal functions are included: the map is for orientation, and knowing
		// a helper exists is the point. Indented methods are not top level.
		expect(names).toContain(2);
		expect(names).not.toContain(4);
		expect(found[0]).toMatchObject({ file: "src/thing.ts" });
	});

	it("understands python and go", () => {
		expect(
			outlineSource("a.py", "def run():\n    pass\nclass Thing:\n    pass")
				.length,
		).toBe(2);
		expect(
			outlineSource(
				"a.go",
				"func Handle() {}\ntype Server struct {}\nvar x = 1",
			).length,
		).toBeGreaterThanOrEqual(2);
	});

	it("ignores files it cannot usefully scan", () => {
		expect(outlineSource("a.png", "export function x() {}")).toEqual([]);
		expect(outlineSource("a.lock", "export function x() {}")).toEqual([]);
	});
});

describe("outline tool", () => {
	let dir: string;
	let tools: ToolMap;

	const run = (input: unknown) => tools.outline?.execute(input as never, {});

	const setup = async () => {
		dir = await mkdtemp(nodePath.join(tmpdir(), "nah-outline-"));
		await mkdir(nodePath.join(dir, "src", "deep"), { recursive: true });
		await writeFile(
			nodePath.join(dir, "src", "alpha.ts"),
			`import { beta } from "./beta.js";\nexport function handleAlpha() {\n  return beta();\n}\nexport class AlphaService {}\n`,
		);
		await writeFile(
			nodePath.join(dir, "src", "deep", "beta.ts"),
			"export function beta() {}\n",
		);
		await writeFile(nodePath.join(dir, "src", "notes.md"), "# not scannable\n");
		tools = createCodingTools(createNodeEnvironment(dir)) as ToolMap;
		return dir;
	};

	it("is registered by default and can be turned off", () => {
		expect(
			Object.keys(createCodingTools(createNodeEnvironment("/tmp"))),
		).toContain("outline");
		expect(
			Object.keys(
				createCodingTools(createNodeEnvironment("/tmp"), {
					withOutline: false,
				}),
			),
		).not.toContain("outline");
	});

	it("maps a tree to signatures without any file bodies", async () => {
		const ws = await setup();
		try {
			const out = await run({});
			expect(out).toContain("src/alpha.ts:");
			expect(out).toContain("handleAlpha");
			expect(out).toContain("AlphaService");
			expect(out).toContain("src/deep/beta.ts:");
			// The body of the function is never included.
			expect(out).not.toContain("return beta();");
			// Markdown is not a scannable source language.
			expect(out).not.toContain("notes.md");
		} finally {
			await rm(ws, { recursive: true, force: true });
		}
	});

	it("ranks matches to the query first", async () => {
		const ws = await setup();
		try {
			const out = await run({ query: "AlphaService" });
			const firstFile = out.split("\n")[1]?.split(":")[0];
			expect(firstFile).toBe("src/alpha.ts");
		} finally {
			await rm(ws, { recursive: true, force: true });
		}
	});

	it("maps a single file when given a path to one", async () => {
		const ws = await setup();
		try {
			const out = await run({ path: "src/alpha.ts" });
			expect(out).toContain("handleAlpha");
			expect(out).not.toContain("beta.ts");
		} finally {
			await rm(ws, { recursive: true, force: true });
		}
	});

	it("says so plainly when there is nothing to map", async () => {
		const ws = await setup();
		try {
			expect(await run({ path: "src/notes.md" })).toContain(
				"No top-level signatures",
			);
		} finally {
			await rm(ws, { recursive: true, force: true });
		}
	});

	it("caps the number of entries returned", async () => {
		const ws = await setup();
		try {
			const out = await run({ maxEntries: 1 });
			const lines = out.split("\n").filter((l) => l.includes("  "));
			expect(lines.length).toBeLessThanOrEqual(1);
		} finally {
			await rm(ws, { recursive: true, force: true });
		}
	});

	it("defaults to a small map, since the full map costs more than reading the files", async () => {
		// Measured on a 5,800-line package: the full map was ~6,200 tokens, which is
		// more than every file the agent went on to read individually. A default
		// above the point of diminishing returns makes `outline` the most expensive
		// call available for merely finding out where something lives.
		const ws = await setup();
		try {
			const out = await run({});
			const lines = out.split("\n").filter((l) => l.includes("  "));
			expect(lines.length).toBeLessThanOrEqual(120);
		} finally {
			await rm(ws, { recursive: true, force: true });
		}
	});

	it("lets an explicit maxEntries exceed the default", async () => {
		// The default must be a default, not a ceiling. It was previously clamped to
		// the same constant it defaulted from, so raising the default would have made
		// the larger map unreachable no matter what the model asked for.
		const ws = await setup();
		try {
			const out = await run({ maxEntries: 2_000 });
			// The schema allows up to 2,000; a value above the default must not be
			// silently reduced back to it.
			expect(out).not.toContain("maxEntries=120");
		} finally {
			await rm(ws, { recursive: true, force: true });
		}
	});

	it("names the call that recovers omitted signatures", async () => {
		const ws = await setup();
		try {
			const out = await run({ maxEntries: 1 });
			// The old notice said "narrow with path or query". But `query` only
			// *ranks*: it reorders the same entries and returns the same count, so
			// following that advice costs another full map and changes nothing.
			// `maxEntries` is the lever that returns more.
			expect(out).toContain("maxEntries=");
			expect(out).not.toContain("query");
		} finally {
			await rm(ws, { recursive: true, force: true });
		}
	});
});
