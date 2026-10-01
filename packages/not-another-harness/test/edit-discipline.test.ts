import { describe, expect, it } from "vitest";

import { buildSystemPrompt } from "../src/prompt.js";
import { createCodingTools } from "../src/tools.js";
import { createNodeEnvironment } from "../src/node.js";
import { mkdtemp } from "node:fs/promises";
import * as nodePath from "node:path";
import { tmpdir } from "node:os";

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

  it("points at replace_all and a scripted pass for mechanical changes", () => {
    expect(prompt).toContain("replace_all");
    expect(prompt).toContain("scripted");
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
    expect(description.toLowerCase()).toContain("without the line-number prefixes");
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