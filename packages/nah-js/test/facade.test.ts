import { describe, expect, it } from "vitest";

import { createNahHandler, createNahRuntime } from "not-another-harness/js";
import { useNahChat } from "not-another-harness/js/client";

describe("nah-js", () => {
	it("re-exports the Web runtime", () => {
		expect(typeof createNahHandler).toBe("function");
		expect(typeof createNahRuntime).toBe("function");
		expect(typeof useNahChat).toBe("function");
	});
});
