import { describe, expect, it } from "vitest";

import { createNahHandler } from "../../src/js/handler.js";
import { scriptedModel, textChunks } from "./helpers/ai.js";

const build = (
	overrides: Partial<Parameters<typeof createNahHandler>[0]> = {},
) =>
	createNahHandler({
		agent: () => ({
			model: scriptedModel(textChunks("hello")),
			system: "s",
			tools: {},
		}),
		...overrides,
	});

const post = (body: unknown): Request =>
	new Request("http://localhost/api/nah", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

describe("the route handler", () => {
	it("runs a turn and streams it back", async () => {
		const { POST } = build();
		const response = await POST(post({ sessionId: "s1", input: "hi" }));

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain(
			"text/event-stream",
		);

		const body = await response.text();
		expect(body).toContain("event: turn-start");
		expect(body).toContain("event: text-delta");
		expect(body).toContain("event: finish");
	});

	it("refuses a body over the limit", async () => {
		const { POST } = build({ maxBodyBytes: 16 });
		const response = await POST(post({ input: "x".repeat(200) }));

		expect(response.status).toBe(413);
		expect((await response.json()).error).toBeTruthy();
	});

	it("refuses a body that is not JSON", async () => {
		const { POST } = build();
		const response = await POST(
			new Request("http://localhost/api/nah", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{not json",
			}),
		);

		expect(response.status).toBe(400);
	});

	it("refuses a body that is not an object", async () => {
		const { POST } = build();
		const response = await POST(
			new Request("http://localhost/api/nah", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "[1, 2, 3]",
			}),
		);

		expect(response.status).toBe(400);
	});

	it("reports that there is nothing to steer", async () => {
		const { POST } = build();
		const response = await POST(
			post({ action: "steer", sessionId: "nobody", text: "hello" }),
		);

		expect(response.status).toBe(409);
		const body = (await response.json()) as { ok: boolean; reason?: string };
		expect(body.ok).toBe(false);
		expect(body.reason).toBeTruthy();
	});

	it("follows a session on GET", async () => {
		const { GET, POST } = build();

		await POST(post({ sessionId: "s1", input: "hi" }));

		const response = await GET(
			new Request("http://localhost/api/nah?sessionId=s1"),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain(
			"text/event-stream",
		);
		expect(await response.text()).toContain("event: turn-start");
	});
});
