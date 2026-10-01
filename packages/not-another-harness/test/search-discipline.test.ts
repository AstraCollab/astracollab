import { mkdir, mkdtemp, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createNodeEnvironment } from "../src/node.js";
import { createMutationLedger, createSearchLedger } from "../src/search-ledger.js";
import { createCodingTools } from "../src/tools.js";

type ToolMap = Record<string, { execute: (input: never, ctx: unknown) => Promise<string> }>;

describe("the search ledger", () => {
  it("stays quiet on a genuinely new search", () => {
    const ledger = createSearchLedger();
    expect(ledger.note("useState", "src", ["a.ts", "b.ts"])).toBeNull();
  });

  it("names an exact repeat of a search already answered", () => {
    // The log showed the same grep emitted twice. Within one step the step memo
    // collapses it; across steps nothing did.
    const ledger = createSearchLedger();
    ledger.note("useState", "src", ["a.ts", "b.ts", "c.ts"]);
    const notice = ledger.note("useState", "src", ["a.ts", "b.ts", "c.ts"]);
    expect(notice).toMatch(/already searched/i);
    expect(notice).toContain("useState");
    expect(ledger.repeats).toBe(1);
  });

  it("names near-identical searches asked in different words", () => {
    // <button, then inline-flex, then btn-: the shape that burns a run on
    // triage without narrowing anything.
    const files = ["ui/Button.tsx", "ui/button-group.tsx", "ui/Icon.tsx", "ui/Field.tsx"];
    const ledger = createSearchLedger();
    expect(ledger.note("btn-", "ui", files)).toBeNull();
    const notice = ledger.note("inline-flex", "ui", files);
    expect(notice).toMatch(/redundant search/i);
    expect(notice).toContain("btn-");
  });

  it("does not cry wolf over a couple of files", () => {
    // Two searches matching the same one file is just reading the file.
    const ledger = createSearchLedger();
    ledger.note("alpha", undefined, ["a.ts", "b.ts"]);
    expect(ledger.note("beta", undefined, ["a.ts", "b.ts"])).toBeNull();
  });

  it("does not cry wolf over genuinely different results", () => {
    const ledger = createSearchLedger();
    ledger.note("useState", "src", ["a.ts", "b.ts", "c.ts", "d.ts"]);
    expect(ledger.note("useReducer", "src", ["a.ts", "z.ts"])).toBeNull();
  });

  it("forgets everything once a file could have changed", () => {
    // A stale "already searched" is worse than a duplicate search, so the
    // ledger has to be cleared on anything that can write.
    const ledger = createSearchLedger();
    ledger.note("useState", "src", ["a.ts", "b.ts", "c.ts"]);
    ledger.clear();
    expect(ledger.note("useState", "src", ["a.ts", "b.ts", "c.ts"])).toBeNull();
  });

  it("stays bounded on a long run", () => {
    const ledger = createSearchLedger();
    for (let i = 0; i < 200; i += 1) {
      ledger.note(`p${i}`, "src", [`f${i}.ts`]);
    }
    // The earliest searches are dropped, so an old repeat is no longer noticed.
    // Bounded memory matters more here than catching every duplicate.
    expect(ledger.note("p0", "src", ["f0.ts"])).toBeNull();
  });
});

describe("grep reports redundancy in place", () => {
  let dir: string;
  let tools: ToolMap;

  const grep = (pattern: string, path?: string): Promise<string> =>
    tools.grep!.execute({ pattern, ...(path ? { path } : {}) } as never, {});

  beforeEach(async () => {
    dir = await mkdtemp(nodePath.join(tmpdir(), "nah-search-"));
    await mkdir(nodePath.join(dir, "ui"), { recursive: true });
    for (const name of ["Button.tsx", "button-group.tsx", "Icon.tsx", "Field.tsx"]) {
      await fsWriteFile(nodePath.join(dir, "ui", name), 'className="btn inline-flex"\n');
    }
    tools = createCodingTools(createNodeEnvironment(dir)) as ToolMap;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("still answers the search, then says it is a repeat", async () => {
    // The result is the point; the notice is a postscript. Suppressing the
    // answer would break the run, which is why this is a notice and not a
    // block the way the script guard is.
    await grep("btn", "ui");
    const second = await grep("btn", "ui");
    expect(second).toContain("ui/Button.tsx");
    expect(second).toMatch(/already searched/i);
  });

  it("catches the overlapping-greps pattern", async () => {
    await grep("btn", "ui");
    const out = await grep("inline-flex", "ui");
    expect(out).toMatch(/redundant search/i);
  });

  it("clears after an edit, so a re-search is not called redundant", async () => {
    await grep("btn", "ui");
    // The read is what the edit gate wants, and it also stands in for the agent
    // having actually looked at the file.
    await tools.read!.execute({ path: "ui/Icon.tsx" } as never, {});
    await tools.edit!.execute(
      { path: "ui/Icon.tsx", old_string: "btn", new_string: "btn-lg" } as never,
      {},
    );
    const out = await grep("btn", "ui");
    expect(out).not.toMatch(/already searched/i);
  });

  it("keeps the ledger when a mutation was refused, because nothing changed", async () => {
    await grep("btn", "ui");
    // A failed edit wrote nothing, so the earlier answer is still the answer.
    // Clearing here would teach the model that any attempt resets the ledger.
    const refused = await tools.edit!.execute(
      { path: "ui/NeverRead.tsx", old_string: "x", new_string: "y" } as never,
      {},
    );
    expect(refused).toContain("read");
    expect(await grep("btn", "ui")).toMatch(/already searched/i);
  });
});

describe("a change reports its own size", () => {
  let dir: string;
  let tools: ToolMap;

  beforeEach(async () => {
    dir = await mkdtemp(nodePath.join(tmpdir(), "nah-scale-"));
    tools = createCodingTools(createNodeEnvironment(dir)) as ToolMap;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("stays quiet on a targeted edit", async () => {
    // Below the threshold the notice would fire on nearly every edit, and a
    // notice that always fires is a notice nobody reads.
    await tools.write!.execute({ path: "a.ts", content: "const a = 1;\nconst b = 2;\n" } as never, {});
    const out = await tools.edit!.execute(
      { path: "a.ts", old_string: "const a = 1;", new_string: "const a = 2;" } as never,
      {},
    );
    expect(out).not.toMatch(/changed \d+ line/);
  });

  it("says so when a write rewrote far more than it intended", async () => {
    const original = Array.from({ length: 200 }, (_, i) => `const v${i} = ${i};`).join("\n");
    await tools.write!.execute({ path: "big.ts", content: original } as never, {});
    // The read-before-write gate is satisfied by the write above, which is what
    // makes this reachable in practice.
    const rewritten = Array.from({ length: 5 }, (_, i) => `const n${i} = ${i};`).join("\n");
    const out = await tools.write!.execute({ path: "big.ts", content: rewritten } as never, {});
    expect(out).toMatch(/\[changed 5 line\(s\), removed 200\]/);
    expect(out).toMatch(/larger than a targeted edit/);
  });

  it("reports the size of a replace_all sweep", async () => {
    const body = Array.from({ length: 40 }, (_, i) => `  btn-${i}`).join("\n");
    await tools.write!.execute({ path: "grid.ts", content: `${body}\n` } as never, {});
    const out = await tools.edit!.execute(
      { path: "grid.ts", old_string: "  btn-", new_string: "  <Button kind=", replace_all: true } as never,
      {},
    );
    expect(out).toMatch(/Replaced 40 occurrences/);
    expect(out).toMatch(/changed 40 line\(s\)/);
  });
});

describe("the mutation ledger", () => {
  it("counts only the tools that change something", () => {
    const ledger = createMutationLedger();
    expect(ledger.note("grep")).toBe(false);
    expect(ledger.note("read")).toBe(false);
    expect(ledger.note("edit")).toBe(true);
    expect(ledger.note("bash")).toBe(true);
    expect(ledger.mutations).toBe(2);
  });
});