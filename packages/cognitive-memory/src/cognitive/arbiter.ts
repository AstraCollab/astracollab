import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import type { ArbiterEvaluationResult, ArbiterFn } from "./types.js";

const ArbiterSchema = z.object({
  promotions: z.array(
    z.object({
      memoryId: z.string(),
      targetTier: z.literal("L1"),
      signalType: z.enum(["anticipatory", "tension", "proprioceptive", "recency"]),
      urgency: z.number().min(0).max(1),
    })
  ),
  demotions: z.array(
    z.object({
      memoryId: z.string(),
      targetTier: z.literal("L2"),
      reason: z.string(),
    })
  ),
  pins: z.array(
    z.object({
      memoryId: z.string(),
      targetTier: z.literal("L0"),
      reason: z.string(),
    })
  ),
  detectedTensions: z.array(
    z.object({
      claimA: z.string().describe("First conflicting claim or statement"),
      claimB: z.string().describe("Contradicting statement from code or user"),
      impact: z.enum(["low", "medium", "critical"]),
      actionableQuestion: z.string().describe("Specific clarifying question the agent should resolve"),
    })
  ),
  trajectoryPrediction: z
    .object({
      predictedDomains: z.array(z.string()),
      predictedFiles: z.array(z.string()),
      prefetchMemoryIds: z.array(z.string()),
      confidence: z.number().min(0).max(1),
    })
    .optional(),
  selfModelUpdate: z
    .object({
      domain: z.string(),
      success: z.boolean().optional(),
      failurePatternObserved: z.string().optional(),
    })
    .optional(),
});

export interface CreateModelArbiterOptions {
  /** Fast decision model (e.g., Gemini 1.5/2.5 Flash, Claude 3.5 Haiku, or GPT-4o-mini) */
  model: LanguageModel;
  /** Custom system prompt override if desired */
  systemPrompt?: string;
}

/**
 * Creates an Arbiter function powered by an AI SDK model with structured output.
 */
export const createModelArbiter = (options: CreateModelArbiterOptions): ArbiterFn => {
  return async ({ turnText, assistantReply, l0Prompt, l1Summaries, candidates }): Promise<ArbiterEvaluationResult> => {
    try {
      const prompt = `You are the Cache Arbiter for an AI coding agent.
Evaluate the latest turn and candidate memories to decide what should be HOT (L1), COLD (L2), or PINNED (L0).

CURRENT TURN:
User: "${turnText}"
Assistant: "${assistantReply}"

L0 CORE STATE:
${l0Prompt || "(none)"}

CURRENT HOT L1 SUMMARIES:
${JSON.stringify(l1Summaries, null, 2)}

WARM L2 CANDIDATE MEMORIES:
${JSON.stringify(candidates, null, 2)}

Analyze:
1. What will the agent likely need in the NEXT 1-2 turns? (Anticipatory -> promote candidate to L1)
2. Are any active L1 items no longer relevant? (Demote L1 to L2)
3. Did the conversation reveal a contradiction between user claims and known facts? (Flag as detectedTension)
4. Did the agent succeed or struggle in a specific domain? (Update self-model)`;

      const result = await generateObject({
        model: options.model,
        schema: ArbiterSchema,
        prompt,
      });

      return result.object;
    } catch {
      // Return safe empty fallback on model failure so the cache remains stable
      return {
        promotions: [],
        demotions: [],
        pins: [],
        detectedTensions: [],
      };
    }
  };
};
