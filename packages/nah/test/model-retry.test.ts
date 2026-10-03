import { afterEach, describe, expect, it, vi } from "vitest";

import { providerFetch } from "../src/model.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Factories, not values: a `Response` body is single-use, and cloning one just
 * to hand out a second copy leaves the cancel in the retry path hanging on the
 * tee. Building a fresh body per call is also what a real fetch does.
 */
const reply =
  (status: number, headers: Record<string, string> = {}): (() => Response) =>
  () =>
    new Response(status === 200 ? "ok" : "nope", { status, headers });

const fail = (message: string): (() => Error) => () => new TypeError(message);

const stubFetch = (responses: Array<() => Response | Error>) => {
  const calls: string[] = [];
  let index = 0;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const next = responses[Math.min(index, responses.length - 1)]!();
    index += 1;
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return calls;
};

const statusFor = (transport: ReturnType<typeof providerFetch>): string[] => {
  const seen: string[] = [];
  transport.setStatusHandler((status) => seen.push(String(status)));
  return seen;
};

const URL_UNDER_TEST = "https://api.example.test/v1/messages";

describe("providerFetch retries", () => {
  it("passes a healthy response straight through after one call", async () => {
    const calls = stubFetch([reply(200)]);
    const transport = providerFetch("Anthropic");
    statusFor(transport);

    const response = await transport.fetch(URL_UNDER_TEST);

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("repeats a 429 and returns the eventual success", async () => {
    // The bug this pins: the old transport printed "rate limited (429) · retrying"
    // and then returned that 429 to the caller. The promise was never kept.
    const calls = stubFetch([reply(429, { "retry-after": "0" }), reply(429, { "retry-after": "0" }), reply(200)]);
    const transport = providerFetch("Anthropic");
    const statuses = statusFor(transport);

    const response = await transport.fetch(URL_UNDER_TEST);

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(statuses.some((s) => s.includes("rate limited (429) · retrying"))).toBe(true);
  });

  it("repeats 502/503/504, the high-traffic statuses", async () => {
    for (const status of [502, 503, 504]) {
      const calls = stubFetch([reply(status, { "retry-after": "0" }), reply(200)]);
      const transport = providerFetch("OpenAI");

      const response = await transport.fetch(URL_UNDER_TEST);

      expect(response.status, `status ${status} should be retried`).toBe(200);
      expect(calls).toHaveLength(2);
    }
  });

  it("does not repeat a 401 or a 400 — the caller's problem, not a blip", async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const calls = stubFetch([reply(status)]);
      const transport = providerFetch("OpenAI");

      const response = await transport.fetch(URL_UNDER_TEST);

      expect(response.status).toBe(status);
      expect(calls, `status ${status} should not be retried`).toHaveLength(1);
    }
  });

  it("gives up after the attempt ceiling instead of looping forever", async () => {
    const calls = stubFetch([reply(503, { "retry-after": "0" })]);
    const transport = providerFetch("OpenAI");
    const statuses = statusFor(transport);

    const response = await transport.fetch(URL_UNDER_TEST);

    // The last response is handed back so the SDK raises its own error with the
    // status attached, rather than this layer inventing one.
    expect(response.status).toBe(503);
    expect(calls).toHaveLength(3);
    expect(statuses.at(-1)).toContain("giving up");
  });

  it("repeats a transient network failure, then surfaces the last one", async () => {
    const calls = stubFetch([fail("fetch failed"), fail("fetch failed"), fail("fetch failed")]);
    const transport = providerFetch("Provider");
    const statuses = statusFor(transport);

    await expect(transport.fetch(URL_UNDER_TEST)).rejects.toThrow("fetch failed");
    expect(calls).toHaveLength(3);
    expect(statuses.some((s) => s.includes("network error · retrying"))).toBe(true);
  }, 10_000);

  it("recovers when the network fails and then comes back", async () => {
    stubFetch([fail("fetch failed"), reply(200)]);
    const transport = providerFetch("Provider");

    const response = await transport.fetch(URL_UNDER_TEST);

    expect(response.status).toBe(200);
  }, 10_000);

  it("waits its own backoff when the server names no Retry-After", async () => {
    stubFetch([reply(503), reply(200)]);
    const transport = providerFetch("OpenAI");
    const startedAt = Date.now();

    const response = await transport.fetch(URL_UNDER_TEST);

    // The first gap is the 500ms base, so a transport that skipped the wait
    // entirely would land well under this.
    expect(response.status).toBe(200);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(450);
  }, 10_000);

  it("honours Retry-After rather than its own curve", async () => {
    const calls = stubFetch([reply(429, { "retry-after": "0" }), reply(200)]);
    const transport = providerFetch("Anthropic");
    const startedAt = Date.now();

    const response = await transport.fetch(URL_UNDER_TEST);

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(Date.now() - startedAt).toBeLessThan(400);
  });

  it("does not resurrect a run the caller aborted", async () => {
    const calls = stubFetch([reply(503, { "retry-after": "0" })]);
    const transport = providerFetch("OpenAI");
    statusFor(transport);
    const controller = new AbortController();
    controller.abort();

    await expect(
      transport.fetch(URL_UNDER_TEST, { signal: controller.signal }),
    ).rejects.toBeDefined();
    // An abort is a decision. Repeating it would resend a cancelled request.
    expect(calls).toHaveLength(1);
  });

  it("stops retrying when the signal aborts during the backoff wait", async () => {
    const calls = stubFetch([reply(429, { "retry-after": "30" })]);
    const transport = providerFetch("Anthropic");
    const controller = new AbortController();
    // Lands while the 30s Retry-After wait is still running.
    setTimeout(() => controller.abort(), 50);

    const startedAt = Date.now();
    await expect(
      transport.fetch(URL_UNDER_TEST, { signal: controller.signal }),
    ).rejects.toBeDefined();
    // The wait must be cut short, and no second request may be made.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(calls).toHaveLength(1);
  }, 10_000);
});
