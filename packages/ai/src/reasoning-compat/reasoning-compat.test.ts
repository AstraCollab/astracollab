import { describe, expect, it } from "vitest";

import {
  applyReasoningContentCompat,
  callsATool,
  createReasoningContentCompat,
  hasReasoningPart,
  historyRequiresReasoning,
  injectReasoningPlaceholders,
  isGatewayThinkingModel,
  isMissingReasoningContentError,
  readThinkingSetting,
  REASONING_CONTENT_PLACEHOLDER,
  resolveRewriteMode,
  stripReasoning,
  type CompatMessage,
  type CompatPrompt,
} from "./index.js";

/**
 * The gateway compatibility layer.
 *
 * Every case here is a way the shim either fails to fire or fires wrongly. The
 * two that matter most are the placeholder value (an empty string reintroduces
 * the exact error being fixed) and idempotency (rewriting over the model's real
 * reasoning would silently discard it).
 */

const assistant = (parts: Array<Record<string, unknown>>): CompatMessage => ({
  role: "assistant",
  content: parts,
});

const toolCall = (id = "t1") => ({ type: "tool-call", toolCallId: id, toolName: "read", input: {} });
const reasoning = (text: string) => ({ type: "reasoning", text });

describe("the placeholder", () => {
  it("is a space, because an empty string is what the gateway rejects", () => {
    // The single most important line in this file. AIML treats absent OR empty as
    // missing, so "" would reintroduce the error this module exists to remove.
    expect(REASONING_CONTENT_PLACEHOLDER).toBe(" ");
    expect(REASONING_CONTENT_PLACEHOLDER.length).toBeGreaterThan(0);
  });

  it("is what gets written into the history", () => {
    const prompt: CompatPrompt = [assistant([toolCall()])];
    const next = injectReasoningPlaceholders(prompt)!;
    const part = (next[0]!.content as Array<Record<string, unknown>>)[0]!;
    expect(part).toEqual({ type: "reasoning", text: " " });
  });
});

describe("injecting", () => {
  it("adds the field to an assistant message that calls a tool", () => {
    const next = injectReasoningPlaceholders([assistant([toolCall()])])!;
    expect(hasReasoningPart(next[0]!)).toBe(true);
    expect(callsATool(next[0]!)).toBe(true);
  });

  it("leaves a message that already has reasoning alone", () => {
    // Overwriting the model's real reasoning with a placeholder would discard the
    // only trace of what it was actually thinking.
    const original = [assistant([reasoning("I should read the file first"), toolCall()])];
    expect(injectReasoningPlaceholders(original)).toBeUndefined();
    expect(original[0]!.content).toHaveLength(2);
  });

  it("returns undefined when there is nothing to do, so callers can tell", () => {
    expect(injectReasoningPlaceholders([{ role: "user", content: "hi" }])).toBeUndefined();
    expect(injectReasoningPlaceholders([assistant([{ type: "text", text: "no tools" }])])).toBeUndefined();
  });

  it("leaves user and tool messages untouched", () => {
    const prompt: CompatPrompt = [
      { role: "user", content: "read a.ts" },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", output: "x" }] },
      assistant([toolCall()]),
    ];
    const next = injectReasoningPlaceholders(prompt)!;
    expect(next[0]).toBe(prompt[0]);
    expect(next[1]).toBe(prompt[1]);
    expect(next[2]).not.toBe(prompt[2]);
  });

  it("is idempotent", () => {
    const once = injectReasoningPlaceholders([assistant([toolCall()])])!;
    expect(injectReasoningPlaceholders(once)).toBeUndefined();
  });
});

describe("stripping", () => {
  it("removes every reasoning part by default", () => {
    const next = stripReasoning([assistant([reasoning("thought"), toolCall()])])!;
    expect(hasReasoningPart(next[0]!)).toBe(false);
  });

  it("can keep real reasoning and drop only what this module added", () => {
    // Across a conversation, not within one message: inject only ever fires when
    // there is no reasoning part, so a message holds the model's reasoning or our
    // placeholder and never both. Turning thinking off mid-conversation should
    // drop the placeholder without erasing what the model actually thought.
    const prompt = [
      assistant([reasoning("I should read the file first"), toolCall()]),
      assistant([reasoning(REASONING_CONTENT_PLACEHOLDER), toolCall("t2")]),
    ];
    const next = stripReasoning(prompt, { placeholdersOnly: true })!;
    expect(hasReasoningPart(next[0]!)).toBe(true);
    expect(hasReasoningPart(next[1]!)).toBe(false);
  });

  it("returns undefined under placeholdersOnly when nothing was injected", () => {
    const prompt = [assistant([reasoning("real"), toolCall()])];
    expect(stripReasoning(prompt, { placeholdersOnly: true })).toBeUndefined();
  });

  it("removes a bare placeholder under placeholdersOnly", () => {
    const next = stripReasoning([assistant([reasoning(REASONING_CONTENT_PLACEHOLDER), toolCall()])], {
      placeholdersOnly: true,
    })!;
    expect(hasReasoningPart(next[0]!)).toBe(false);
  });
});

describe("model detection", () => {
  it("knows the models that need the round-trip", () => {
    expect(isGatewayThinkingModel("deepseek-chat")).toBe(true);
    expect(isGatewayThinkingModel("deepseek/deepseek-r1")).toBe(true);
    expect(isGatewayThinkingModel("moonshotai/kimi-k2-5")).toBe(true);
    expect(isGatewayThinkingModel("kimi-k2.6-instruct")).toBe(true);
    expect(isGatewayThinkingModel("gpt-5")).toBe(false);
  });
});

describe("the thinking setting", () => {
  it("reads the documented spellings", () => {
    expect(readThinkingSetting({ THINKING: "1" })).toBe("enabled");
    expect(readThinkingSetting({ THINKING: "enabled" })).toBe("enabled");
    expect(readThinkingSetting({ THINKING: "on" })).toBe("enabled");
    expect(readThinkingSetting({ THINKING: "0" })).toBe("disabled");
    expect(readThinkingSetting({ THINKING: "off" })).toBe("disabled");
    expect(readThinkingSetting({ THINKING: "disabled" })).toBe("disabled");
  });

  it("treats unset and nonsense as unset, and lets the prompt decide", () => {
    expect(readThinkingSetting({})).toBe("unset");
    expect(readThinkingSetting({ THINKING: "  " })).toBe("unset");
    expect(readThinkingSetting({ THINKING: "maybe" })).toBe("unset");
  });

  it("honours a custom variable name", () => {
    expect(readThinkingSetting({ REASONING: "off" }, "REASONING")).toBe("disabled");
  });
});

describe("choosing a mode", () => {
  const midRoundTrip: CompatPrompt = [assistant([reasoning("thinking"), toolCall()])];

  it("does nothing for a model that does not need it", () => {
    expect(
      resolveRewriteMode({ modelId: "gpt-5", prompt: midRoundTrip, setting: "enabled" }),
    ).toBeUndefined();
  });

  it("strips when thinking is explicitly off", () => {
    expect(resolveRewriteMode({ modelId: "deepseek-chat", prompt: midRoundTrip, setting: "disabled" })).toBe("strip");
  });

  it("injects when thinking is explicitly on", () => {
    expect(
      resolveRewriteMode({
        modelId: "deepseek-chat",
        prompt: [assistant([toolCall()])],
        setting: "enabled",
      }),
    ).toBe("inject");
  });

  it("with no setting, follows the history", () => {
    // Unset resolves from what the conversation already did, so a round-trip in
    // progress stays consistent and a first turn is left alone.
    expect(resolveRewriteMode({ modelId: "deepseek-chat", prompt: midRoundTrip, setting: "unset" })).toBe("inject");
    expect(
      resolveRewriteMode({
        modelId: "deepseek-chat",
        prompt: [assistant([toolCall()])],
        setting: "unset",
      }),
    ).toBeUndefined();
  });

  it("recognises an added model", () => {
    expect(
      resolveRewriteMode({
        modelId: "some/new-gateway-model",
        prompt: midRoundTrip,
        setting: "unset",
        extraModels: ["some/new-gateway-model"],
      }),
    ).toBe("inject");
    // And without the list it is an unknown model, so nothing happens.
    expect(resolveRewriteMode({ modelId: "some/new-gateway-model", prompt: midRoundTrip, setting: "unset" })).toBeUndefined();
  });

  it("leaves a first turn alone with no setting, even for a known model", () => {
    // DeepSeek specifically: thinking stays off until the history shows a
    // round-trip is under way, so the first step is free to use tool_choice.
    expect(
      resolveRewriteMode({
        modelId: "deepseek-chat",
        prompt: [assistant([toolCall()])],
        setting: "unset",
      }),
    ).toBeUndefined();
  });
});

describe("recognising the gateway error", () => {
  it("matches the error the gateway actually returns", () => {
    expect(
      isMissingReasoningContentError(new Error("reasoning_content is missing in assistant tool call message")),
    ).toBe(true);
    expect(isMissingReasoningContentError(new Error("reasoning_content must be passed back"))).toBe(true);
  });

  it("ignores errors it cannot fix", () => {
    // Rate limits and bad keys must not send a caller into a rewrite-and-retry
    // loop that could never help.
    expect(isMissingReasoningContentError(new Error("rate limit exceeded"))).toBe(false);
    expect(isMissingReasoningContentError(new Error("401 unauthorized"))).toBe(false);
    expect(isMissingReasoningContentError(undefined)).toBe(false);
  });

  it("reads a string error, because providers do not always throw Errors", () => {
    expect(isMissingReasoningContentError("reasoning_content is missing in assistant tool call message")).toBe(true);
  });
});

describe("the middleware", () => {
  const prompt: CompatPrompt = [
    { role: "user", content: [{ type: "text", text: "read a.ts" }] },
    assistant([toolCall()]),
  ];
  const params = { prompt, temperature: 0.2 } as never;
  const model = { modelId: "deepseek/deepseek-chat" } as never;

  it("rewrites the prompt before it is sent", async () => {
    const middleware = createReasoningContentCompat({ env: { THINKING: "enabled" } });
    const next = await middleware.transformParams!({ params, model, type: "stream" });
    const parts = (next.prompt as CompatPrompt)[1]!.content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: "reasoning", text: " " });
    // The rest of the request is untouched: temperature, tools and all.
    expect((next as { temperature: number }).temperature).toBe(0.2);
  });

  it("returns the same params when there is nothing to change", async () => {
    const middleware = createReasoningContentCompat({ env: {} });
    const next = await middleware.transformParams!({ params, model: { modelId: "gpt-5" } as never, type: "stream" });
    expect(next).toBe(params);
  });

  it("declares no specification version, because wrapLanguageModel never reads one", () => {
    // `doWrap` destructures only transformParams/wrapGenerate/wrapStream/override*,
    // and the shim sets `specificationVersion` on the model it returns. Setting a
    // version here would be documentation the SDK ignores — and the field is
    // spelled differently on either side of the v2/v4 boundary, so an ignored
    // field is an ignored field that can only rot.
    const middleware = createReasoningContentCompat() as Record<string, unknown>;
    expect(Object.keys(middleware).sort()).toEqual(["transformParams", "wrapGenerate", "wrapStream"]);
    expect(middleware.middlewareVersion).toBeUndefined();
    expect(middleware.specificationVersion).toBeUndefined();
  });
});

describe("self-healing when the gateway still complains", () => {
  /**
   * The AI SDK type says `doGenerate()` takes no arguments, which reads as
   * "middleware cannot reissue this call with different parameters". It can: the
   * call is bound to a closure over the params object, and the object handed to
   * the middleware is that same object.
   */
  const rejectingModel = (failures: number) => {
    const prompts: unknown[] = [];
    let remaining = failures;
    return {
      prompts,
      modelId: "deepseek/deepseek-chat",
      doGenerate: async () => {
        if (remaining > 0) {
          remaining -= 1;
          throw new Error("reasoning_content is missing in assistant tool call message");
        }
        return { content: [], finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, warnings: [] };
      },
    };
  };

  it("re-sends with the field injected after the provider asks for it", async () => {
    const fake = rejectingModel(1);
    const params = { prompt: [{ role: "assistant", content: [toolCall()] }] };
    const middleware = createReasoningContentCompat({ env: {} });

    await middleware.wrapGenerate!({
      doGenerate: async () => {
        await fake.doGenerate();
        return { ok: true };
      },
      params,
      model: { modelId: fake.modelId },
    } as never);

    // The retry carried the field, which is the whole point.
    const sent = params.prompt as CompatPrompt;
    expect(hasReasoningPart(sent[0]!)).toBe(true);
    expect((sent[0]!.content as Array<Record<string, unknown>>)[0]).toEqual({
      type: "reasoning",
      text: REASONING_CONTENT_PLACEHOLDER,
    });
  });

  it("retries exactly once, and lets a second failure propagate", async () => {
    // An SDK that stops aliasing the params object would make the mutation a
    // no-op; the retry then fails identically. That has to surface, not loop.
    let attempts = 0;
    const params = { prompt: [{ role: "assistant", content: [toolCall()] }] };
    const middleware = createReasoningContentCompat({ env: {} });

    await expect(
      middleware.wrapGenerate!({
        doGenerate: async () => {
          attempts += 1;
          throw new Error("reasoning_content is missing in assistant tool call message");
        },
        params,
        model: { modelId: "deepseek/deepseek-chat" },
      } as never),
    ).rejects.toThrow(/reasoning_content/);
    expect(attempts).toBe(2);
  });

  it("does not retry an error it cannot fix", async () => {
    let attempts = 0;
    const middleware = createReasoningContentCompat({ env: {} });
    await expect(
      middleware.wrapGenerate!({
        doGenerate: async () => {
          attempts += 1;
          throw new Error("rate limit exceeded");
        },
        params: { prompt: [{ role: "assistant", content: [toolCall()] }] },
        model: { modelId: "deepseek/deepseek-chat" },
      } as never),
    ).rejects.toThrow(/rate limit/);
    // A duplicate request we cannot fix is money spent for nothing.
    expect(attempts).toBe(1);
  });

  it("does not retry when there is nothing left to add", async () => {
    // The gateway wants the field on a message with no tool call, which is not
    // the rule we model. Retrying would fail identically.
    let attempts = 0;
    const middleware = createReasoningContentCompat({ env: {} });
    await expect(
      middleware.wrapGenerate!({
        doGenerate: async () => {
          attempts += 1;
          throw new Error("reasoning_content is missing in assistant tool call message");
        },
        params: { prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
        model: { modelId: "deepseek/deepseek-chat" },
      } as never),
    ).rejects.toThrow(/reasoning_content/);
    expect(attempts).toBe(1);
  });

  it("calls the function it was given, not the other one", async () => {
    // The SDK hands `doStream` middleware a doGenerate as well. Using the wrong
    // one turns every streaming call into a non-streaming request — a bug that a
    // stubbed unit test cannot see, because the stub only ever provides one.
    const middleware = createReasoningContentCompat({ env: {} });
    let streamed = 0;
    let generated = 0;
    const params = { prompt: [{ role: "assistant", content: [toolCall()] }] };

    await middleware.wrapStream!({
      doGenerate: async () => {
        generated += 1;
        return { generated: true };
      },
      doStream: async () => {
        streamed += 1;
        return { streamed: true };
      },
      params,
      model: { modelId: "deepseek/deepseek-chat" },
    } as never);

    expect(streamed).toBe(1);
    expect(generated).toBe(0);
  });

  it("can be turned off", async () => {
    const middleware = createReasoningContentCompat({ env: {}, healOnError: false }) as Record<string, unknown>;
    expect(middleware.wrapGenerate).toBeUndefined();
    expect(middleware.wrapStream).toBeUndefined();
    expect(typeof middleware.transformParams).toBe("function");
  });
});

describe("applying to stored history", () => {
  it("normalises a transcript written before the middleware existed", () => {
    // The runtime equivalent of Mastra's `fix()`: rows already in a database are
    // what the transform cannot reach, and re-persisting them once is cheaper
    // than a retry path that has to exist forever.
    const stored = [assistant([toolCall()])];
    const fixed = applyReasoningContentCompat(stored, { modelId: "deepseek-chat", env: { THINKING: "enabled" } });
    expect(hasReasoningPart((fixed as CompatPrompt)[0]!)).toBe(true);
  });

  it("leaves an unknown model alone", () => {
    const stored = [assistant([toolCall()])];
    expect(applyReasoningContentCompat(stored, { modelId: "gpt-5", env: { THINKING: "enabled" } })).toBe(stored);
  });

  it("returns non-arrays untouched rather than throwing", () => {
    expect(applyReasoningContentCompat(undefined, { modelId: "deepseek-chat", env: {} })).toBeUndefined();
    expect(applyReasoningContentCompat("not a prompt", { modelId: "deepseek-chat", env: {} })).toBe("not a prompt");
  });
});

describe("historyRequiresReasoning", () => {
  it("needs a tool call and non-blank reasoning together", () => {
    expect(historyRequiresReasoning([assistant([reasoning(" "), toolCall()])])).toBe(false);
    expect(historyRequiresReasoning([assistant([reasoning("real")])])).toBe(false);
    expect(historyRequiresReasoning([assistant([reasoning("real"), toolCall()])])).toBe(true);
  });
});