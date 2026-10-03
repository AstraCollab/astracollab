import { mkdtemp, readFile as fsReadFile, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApprover } from "../src/permissions.js";
import { createCodingTools } from "not-another-harness";
import { createNodeEnvironment } from "not-another-harness/node";

type ToolMap = Record<string, { execute: (input: never, ctx: unknown) => Promise<string> }>;

/**
 * The command from the run this guards against, reduced to the part that
 * matters: a heredoc interpreter that reads a source file, rewrites it with a
 * regex, and writes it back — with no `read` anywhere in the turn.
 */
const REWRITE = (path: string): string =>
  `python3 - <<'PY'\nimport re\nf=${JSON.stringify(path)}\ns=open(f).read()\n` +
  `open(f,'w').write(re.sub(r'\\n\\n\\n+', '\\n\\n', s))\nPY`;

describe("nah does not let a turn rewrite source from an inline script", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(nodePath.join(tmpdir(), "nah-yolo-guard-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const build = (permissions: "yolo" | "ask"): ToolMap => {
    const approve = createApprover(() => permissions);
    return createCodingTools(createNodeEnvironment(dir), { approveToolCall: approve }) as ToolMap;
  };

  it("refuses in yolo mode, where no human would have caught it", async () => {
    // The failure happened with permissions wide open, so a guard that only
    // worked behind the approval prompt would not have prevented it.
    const tools = build("yolo");
    await fsWriteFile(nodePath.join(dir, "page.tsx"), "const a = 1;\n\n\n\nconst b = 2;\n");
    const out = await tools.bash!.execute({ command: REWRITE("page.tsx") } as never, {});
    expect(out).toContain("DENIED");
    expect(await fsReadFile(nodePath.join(dir, "page.tsx"), "utf8")).toBe(
      "const a = 1;\n\n\n\nconst b = 2;\n",
    );
  });

  it("refuses in ask mode without spending a prompt on it", async () => {
    // Asking a human to approve a destructive command is worse than not asking:
    // they cannot judge a regex they cannot see either.
    let prompted = 0;
    const approve = createApprover(() => "ask");
    const tools = createCodingTools(createNodeEnvironment(dir), {
      approveToolCall: async () => {
        prompted += 1;
        return true;
      },
    }) as ToolMap;
    void approve;
    await fsWriteFile(nodePath.join(dir, "page.tsx"), "x\n");
    const out = await tools.bash!.execute({ command: REWRITE("page.tsx") } as never, {});
    expect(out).toContain("DENIED");
    expect(prompted).toBe(0);
  });

  it("still runs ordinary commands and real codemods", async () => {
    const tools = build("yolo");
    await fsWriteFile(nodePath.join(dir, "a.txt"), "hello\n");
    const read = await tools.bash!.execute(
      { command: `python3 -c "print(open('a.txt').read().strip().upper())"` } as never,
      {},
    );
    expect(read).toContain("HELLO");
  });

  it("does not break the workspace environment helpers", async () => {
    // The guard lives in the bash tool, not the environment, so anything that
    // legitimately writes through the file tools is unaffected.
    const env = createNodeEnvironment(dir);
    const tools = createCodingTools(env) as ToolMap;
    await tools.write!.execute({ path: "b.ts", content: "const b = 1;\n" } as never, {});
    expect(await env.readFile("b.ts")).toBe("const b = 1;\n");
  });
});