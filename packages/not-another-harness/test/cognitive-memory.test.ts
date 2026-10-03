import { describe, expect, it } from "vitest";
import { CognitiveMemory, runFastGate } from "../src/index.js";

describe("CognitiveMemory", () => {
	it("initializes and returns clean prompt context", () => {
		const mem = new CognitiveMemory();
		expect(mem.getPromptContext()).toBe("");
	});

	it("handles fast gate contradiction signals without LLM delay", () => {
		const normal = runFastGate("Please refactor the user controller");
		expect(normal.action).toBe("proceed");

		const contradiction = runFastGate(
			"Actually, we switched from Postgres to MongoDB yesterday",
		);
		expect(contradiction.action).toBe("inject_caution");
		expect(contradiction.cautionNote).toBeDefined();

		const mem = new CognitiveMemory();
		const contextWithCaution = mem.getPromptContext(
			"Actually, we moved to DynamoDB",
		);
		expect(contextWithCaution).toContain("Correction Detected In This Message");
	});

	it("pins active tensions in L0 and renders them into context", () => {
		const mem = new CognitiveMemory();
		mem.addTension({
			id: "ten-1",
			status: "active",
			claimA: {
				source: "user",
				statement: "Use SQLite for tests",
				timestamp: Date.now(),
			},
			claimB: {
				source: ".env",
				statement: "DATABASE_URL=postgres://...",
				timestamp: Date.now(),
			},
			impact: "critical",
			taskRelevance: 1.0,
			actionableQuestion: "Are we testing against SQLite or Postgres?",
		});

		const ctx = mem.getPromptContext();
		expect(ctx).toContain("CRITICAL");
		expect(ctx).toContain("Unresolved Contradictions");
		expect(ctx).toContain("Are we testing against SQLite or Postgres?");
	});

	it("marks tensions resolved and removes them from active L0 prompt context", () => {
		const mem = new CognitiveMemory();
		mem.addTension({
			id: "ten-1",
			status: "active",
			claimA: {
				source: "user",
				statement: "Use SQLite for tests",
				timestamp: Date.now(),
			},
			claimB: {
				source: ".env",
				statement: "DATABASE_URL=postgres://...",
				timestamp: Date.now(),
			},
			impact: "critical",
			taskRelevance: 1.0,
			actionableQuestion: "Are we testing against SQLite or Postgres?",
		});

		const resolved = mem.resolveTension("ten-1", {
			resolvedBy: "user confirmed SQLite in tests",
			pattern: "Use in-memory sqlite when NODE_ENV=test",
		});
		expect(resolved).toBe(true);

		const ctx = mem.getPromptContext();
		expect(ctx).not.toContain("CRITICAL");
	});

	it("tracks per-domain reliability and surfaces warnings for weak domains", () => {
		const mem = new CognitiveMemory({
			initialSelfModel: {
				activeDomains: ["auth"],
				domains: {
					auth: {
						reliabilityScore: 0.5,
						sampleCount: 4,
						knownFailurePatterns: ["Token refresh timing race condition"],
						recommendedStrategies: ["Write integration test first"],
					},
				},
			},
		});

		const ctx = mem.getPromptContext();
		expect(ctx).toContain("Weak Domains — Under 75% Reliability");
		expect(ctx).toContain("50%");
		expect(ctx).toContain("Token refresh timing race condition");
	});

	it("pre-stages hot L1 memories and retains them across turns", async () => {
		const mem = new CognitiveMemory();
		mem.addMemory(
			{
				id: "mem-auth-pattern",
				content:
					"JWT tokens in this service expire after 15m; refresh uses Redis key prefix 'sess:'.",
				bookmark: "JWT 15m expiry with Redis sess: prefix",
				tier: "L1",
				metadata: {
					domains: ["auth"],
					createdAt: Date.now(),
					lastAccessedAt: Date.now(),
					accessCount: 1,
				},
			},
			"L1",
		);

		const ctx = mem.getPromptContext();
		expect(ctx).toContain("JWT tokens in this service expire after 15m");

		// Perform post-turn async
		await mem.postTurnAsync({
			userMessage: "How does the token refresh work?",
			assistantResponse: "It uses the Redis sess prefix to check validity.",
			detectedDomains: ["auth"],
		});

		const snapshot = mem.getSnapshot();
		expect(snapshot.stats.totalTurnsProcessed).toBe(1);
		expect(snapshot.l1.length).toBeGreaterThan(0);
	});
});
