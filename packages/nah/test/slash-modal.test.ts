import { describe, expect, it } from "vitest";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";

import { createSlashCommandProvider } from "../src/tui/slash-autocomplete.js";
import { exclusiveCommands, renderCommandHelp, SLASH_COMMANDS } from "../src/commands.js";

const provider: AutocompleteProvider = createSlashCommandProvider(
  SLASH_COMMANDS.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint })),
);

const suggest = (line: string, cursorLine = 0, cursorCol = line.length) =>
  provider.getSuggestions([line], cursorLine, cursorCol, { signal: new AbortController().signal });

describe("slash-command modal", () => {
  it("opens on `/` at the start of a line and lists every command", async () => {
    const result = await suggest("/");
    expect(result).not.toBeNull();
    expect(result!.items.length).toBe(SLASH_COMMANDS.length);
    expect(result!.items.map((i) => i.value)).toContain("model");
  });

  it("filters as you type", async () => {
    // Fuzzy: `/mod` matches both `model` and `mode`, best match first.
    const result = await suggest("/mod");
    expect(result!.items.map((i) => i.value)).toEqual(["model", "mode"]);

    // A longer prefix ranks the exact match first, with fuzzy hits behind it.
    const narrowed = (await suggest("/mode"))!.items.map((i) => i.value);
    expect(narrowed[0]).toBe("mode");
    expect(narrowed).toContain("model");

    const fuzzy = await suggest("/st");
    expect(fuzzy!.items.map((i) => i.value)).toContain("stats");
  });

  it("shows nothing once the command name is settled, until Enter", async () => {
    // Explicit requirement: `/model ` must not pop a list of models.
    expect(await suggest("/model ")).toBeNull();
    expect(await suggest("/model a")).toBeNull();
    expect(await suggest("/permissions ")).toBeNull();
  });

  it("closes when nothing matches", async () => {
    expect(await suggest("/zzzznope")).toBeNull();
  });

  it("stays closed for ordinary prose and for `@file` mentions", async () => {
    expect(await suggest("add a docs section")).toBeNull();
    expect(await suggest("@src/a.ts")).toBeNull();
    expect(await suggest("see /model for details")).toBeNull();
  });

  it("does not reopen on a later line of a multi-line prompt", async () => {
    expect(await suggest("/model", 1, 6)).toBeNull();
  });

  it("completes to the command name, replacing what was typed", async () => {
    const items = (await suggest("/mod"))!.items;
    const applied = provider.applyCompletion(["/mod"], 0, 4, items[0]!, "/mod");
    // Not "/modmodel" — the prefix is replaced.
    expect(applied.lines[0]).toBe("/model ");
    expect(applied.cursorCol).toBe("/model ".length);
  });

  it("keeps text after the cursor when completing mid-line", async () => {
    const items = (await suggest("/hel"))!.items;
    const applied = provider.applyCompletion(["/hel and then this"], 0, 4, items[0]!, "/hel");
    expect(applied.lines[0]).toBe("/help  and then this");
  });
});

describe("command registry", () => {
  it("is the single source for /help", () => {
    const help = renderCommandHelp();
    for (const command of SLASH_COMMANDS) {
      expect(help).toContain(`/${command.name}`);
      expect(help).toContain(command.description);
    }
  });

  it("marks the terminal-owning commands as exclusive", () => {
    const exclusive = exclusiveCommands();
    expect(exclusive.has("model")).toBe(true);
    expect(exclusive.has("provider")).toBe(true);
    // `/cogmem` asks questions and takes a key paste, so it needs the terminal
    // released the same way. Miss this and readline paints over the alternate
    // screen and the prompt is never answered.
    expect(exclusive.has("cogmem")).toBe(true);
    // These must stay available mid-turn, just deferred.
    expect(exclusive.has("stats")).toBe(false);
    expect(exclusive.has("task")).toBe(false);
  });

  it("has no duplicate command names", () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
