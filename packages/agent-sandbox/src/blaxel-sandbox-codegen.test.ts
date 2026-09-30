import { describe, expect, it } from "vitest";
import {
  encodeBlaxelWorkspacePathForUrl,
  normalizeBlaxelSandboxBaseUrl,
  pickBlaxelSandboxApiBaseUrl,
} from "./blaxel-sandbox-codegen.js";

describe("normalizeBlaxelSandboxBaseUrl", () => {
  it("strips trailing slashes", () => {
    expect(normalizeBlaxelSandboxBaseUrl("https://ex.example/blah/")).toBe(
      "https://ex.example/blah",
    );
  });
});

describe("encodeBlaxelWorkspacePathForUrl", () => {
  it("encodes each path segment", () => {
    expect(encodeBlaxelWorkspacePathForUrl("app/foo bar.tsx")).toBe(
      "app/foo%20bar.tsx",
    );
    expect(
      encodeBlaxelWorkspacePathForUrl("app/(dashboard)/orgs/[slug]/page.tsx"),
    ).toBe("app/(dashboard)/orgs/%5Bslug%5D/page.tsx");
  });

  it("uses dot for empty path", () => {
    expect(encodeBlaxelWorkspacePathForUrl("")).toBe(".");
    expect(encodeBlaxelWorkspacePathForUrl("///")).toBe(".");
  });
});

describe("pickBlaxelSandboxApiBaseUrl", () => {
  it("reads known keys", () => {
    expect(
      pickBlaxelSandboxApiBaseUrl({
        endpoint: "https://sbx-abc-us.bl.run/",
      }),
    ).toBe("https://sbx-abc-us.bl.run");
  });

  it("returns null for unknown shapes", () => {
    expect(pickBlaxelSandboxApiBaseUrl(null)).toBeNull();
    expect(pickBlaxelSandboxApiBaseUrl({})).toBeNull();
    expect(pickBlaxelSandboxApiBaseUrl({ endpoint: "not-a-url" })).toBeNull();
  });
});
