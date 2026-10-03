import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as p from "node:path";
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV2 } from "ai/test";
import { runAgent } from "/Users/elias/Documents/Code/astracollab/astracollab-packages/packages/not-another-harness/src/agent.js";
import { createNodeEnvironment } from "/Users/elias/Documents/Code/astracollab/astracollab-packages/packages/not-another-harness/src/node.js";
import { createCodingTools } from "/Users/elias/Documents/Code/astracollab/astracollab-packages/packages/not-another-harness/src/tools.js";

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const dir = await mkdtemp(p.join(tmpdir(), "nah-repro-"));
const mk =
	(toolName: string, input: unknown, id = "c1") =>
	() =>
		simulateReadableStream<LanguageModelV2StreamPart>({
			chunkDelayInMs: 0,
			chunks: [
				{
					type: "tool-call",
					toolCallId: id,
					toolName,
					input: JSON.stringify(input),
				},
				{ type: "finish", finishReason: "tool-calls", usage: USAGE },
			],
		});
let call = 0;
const streams = [
	mk("write", { path: "out.txt", content: "hi\n" }),
	mk("read", { path: "out.txt" }, "c2"),
];
const model = new MockLanguageModelV2({
	doStream: async () => ({
		stream: streams[Math.min(call++, streams.length - 1)]?.(),
	}),
});
const run = runAgent({
	model,
	system: "s",
	prompt: "p",
	tools: createCodingTools(createNodeEnvironment(dir)),
});
for await (const e of run.events)
	console.log(e.type, (e as any).toolName ?? (e as any).error ?? "");
console.log((await run.result).reason);
