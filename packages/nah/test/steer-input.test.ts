import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type * as readline from "node:readline/promises";

import { protectTypedInput, renderTurn } from "../src/repl.js";
import type { HarnessEvent } from "@astracollab/not-another-harness";

/** Minimal stand-in for the parts of a readline interface we consult. */
const fakeRl = (line: string): readline.Interface => ({ line }) as readline.Interface;

const makeOut = (sink: string[]): NodeJS.WriteStream => {
  const out = new Writable({
    write(chunk, _encoding, callback) {
      sink.push(String(chunk));
      callback();
    },
  }) as unknown as NodeJS.WriteStream;
  (out as { isTTY: boolean }).isTTY = true;
  (out as { columns: number }).columns = 100;
  return out;
};

async function* collect(): AsyncGenerator<HarnessEvent> {
  // A tool call starts the spinner, then a delay lets the render tick fire and
  // actually attempt a carriage-return redraw. Without both, the spinner never
  // draws and the render assertions would pass for the wrong reason.
  yield {
    type: "tool-call",
    step: 1,
    toolCallId: "c1",
    toolName: "read",
    input: { path: "x" },
  };
  await new Promise((resolve) => setTimeout(resolve, 250));
  yield {
    type: "finish",
    reason: "completed",
    text: "hi",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}

describe("protectTypedInput", () => {
  it("drops the renderer's carriage-return redraw while the user is typing", () => {
    const guard = protectTypedInput(fakeRl("use TypeScript"));
    // This is the exact sequence the spinner writes to erase its own line.
    expect(guard("\r\u001b[2K⠋ working")).toBe(false);
  });

  it("allows the redraw when nothing has been typed", () => {
    expect(protectTypedInput(fakeRl(""))("\r\u001b[2K⠋ working")).toBe(true);
  });

  it("always allows ordinary output", () => {
    const guard = protectTypedInput(fakeRl("use TypeScript"));
    expect(guard("some streamed model text\n")).toBe(true);
    expect(guard("\n")).toBe(true);
  });
});

describe("renderTurn with a typed steer line in flight", () => {
  it("never emits a line-clearing sequence that would erase the input", async () => {
    const chunks: string[] = [];

    await renderTurn(
      collect(),
      makeOut(chunks),
      () => "working",
      () => [],
      protectTypedInput(fakeRl("actually use TypeScript")),
    );

    expect(chunks.filter((chunk) => chunk.startsWith("\r\u001b[2K"))).toEqual([]);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("proves the spinner really does redraw when nothing is being typed", async () => {
    // Keeps the test above honest: the same render with an empty input line
    // must emit carriage-return redraws.
    const chunks: string[] = [];

    await renderTurn(collect(), makeOut(chunks), () => "working", () => [], protectTypedInput(fakeRl("")));

    expect(chunks.filter((chunk) => chunk.startsWith("\r\u001b[2K")).length).toBeGreaterThan(0);
  });
});
