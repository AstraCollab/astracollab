import { mkdtemp, mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { createWorkflowRegistry } from "not-another-harness";
import { describe, expect, it } from "vitest";
import { SLASH_COMMANDS } from "../src/commands.js";
import { handleSlashCommand } from "../src/repl.js";
import type { SessionState } from "../src/session.js";
import {
  WORKSPACE_WORKFLOW_DIR,
  listWorkspaceWorkflowFiles,
  loadWorkspaceWorkflows,
  resolveWorkspaceWorkflow,
  workspaceWorkflowBrief,
} from "../src/workspace-workflows.js";

/** An empty workspace with the workflow directory made, since nothing creates it yet. */
const workspace = async (): Promise<{ root: string; dir: string }> => {
  const root = await mkdtemp(join(tmpdir(), "nah-workspace-workflows-"));
  const dir = join(root, ...WORKSPACE_WORKFLOW_DIR.split("/"));
  await mkdir(dir, { recursive: true });
  return { root, dir };
};

const plain = (id: string) => `export default { __workflow: true, id: ${JSON.stringify(id)}, description: "does ${id}" };\n`;

describe("workspace workflows", () => {
  it("registers a workflow from a file that exports it", async () => {
    const { root, dir } = await workspace();
    await writeFile(join(dir, "release.mjs"), plain("release"));
    const registry = createWorkflowRegistry();

    const result = await loadWorkspaceWorkflows({ cwd: root, registry });

    expect(result.failed).toEqual([]);
    expect(result.loaded.flatMap(({ ids }) => ids)).toEqual(["release"]);
    expect(registry.get("release")?.description).toBe("does release");
  });

  it("hands the workflow API to a file that exports a factory", async () => {
    const { root, dir } = await workspace();
    await writeFile(join(dir, "built.mjs"), 'export default (nah) => ({ __workflow: true, id: "built", description: typeof nah.createWorkflow });\n');
    const registry = createWorkflowRegistry();

    await loadWorkspaceWorkflows({ cwd: root, registry });

    // "function" is the proof that the file could build a real workflow without
    // importing one, which is the whole reason the factory form exists.
    expect(registry.get("built")?.description).toBe("function");
  });

  it("takes several workflows out of one file", async () => {
    const { root, dir } = await workspace();
    await writeFile(
      join(dir, "library.mjs"),
      'export default { a: { __workflow: true, id: "a" }, b: { __workflow: true, id: "b" } };\n',
    );
    const registry = createWorkflowRegistry();

    const result = await loadWorkspaceWorkflows({ cwd: root, registry });

    expect(result.loaded[0]?.ids).toEqual(["a", "b"]);
    expect(registry.list().map(({ id }) => id)).toEqual(["a", "b"]);
  });

  it("names a broken file instead of losing the workflows that are fine", async () => {
    const { root, dir } = await workspace();
    await writeFile(join(dir, "good.mjs"), plain("good"));
    await writeFile(join(dir, "bad.mjs"), "export default 42;\n");
    const registry = createWorkflowRegistry();

    const result = await loadWorkspaceWorkflows({ cwd: root, registry });

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.file).toContain("bad.mjs");
    expect(result.failed[0]?.error).toContain("not a workflow");
    expect(registry.get("good")).toBeDefined();
  });

  it("reports a file that throws rather than the whole load failing", async () => {
    const { root, dir } = await workspace();
    await writeFile(join(dir, "throws.mjs"), 'throw new Error("cannot build this");\n');

    const result = await loadWorkspaceWorkflows({ cwd: root });

    expect(result.failed[0]?.error).toContain("cannot build this");
  });

  it("refuses two files claiming the same id", async () => {
    const { root, dir } = await workspace();
    await writeFile(join(dir, "first.mjs"), plain("release"));
    await writeFile(join(dir, "second.mjs"), plain("release"));
    const registry = createWorkflowRegistry();

    const result = await loadWorkspaceWorkflows({ cwd: root, registry });

    expect(result.loaded).toHaveLength(1);
    expect(result.failed[0]?.error).toContain('duplicate workflow id "release"');
  });

  it("finds a workflow written after the session started, without a reload", async () => {
    const { root, dir } = await workspace();
    const registry = createWorkflowRegistry();
    await writeFile(join(dir, "release.mjs"), plain("release"));

    const workflow = await resolveWorkspaceWorkflow({ cwd: root, registry, id: "release" });

    expect(workflow?.id).toBe("release");
    expect(registry.get("release")).toBe(workflow);
  });

  it("prefers a workflow already in the registry over the file that defines it", async () => {
    const { root, dir } = await workspace();
    const builtin = { __workflow: true, id: "release", description: "the built-in one" } as never;
    const registry = createWorkflowRegistry({ release: builtin });
    await writeFile(join(dir, "release.mjs"), plain("release"));

    const workflow = await resolveWorkspaceWorkflow({ cwd: root, registry, id: "release" });

    expect(workflow?.description).toBe("the built-in one");
  });

  it("keeps searching past a file that will not parse", async () => {
    const { root, dir } = await workspace();
    await writeFile(join(dir, "a-broken.mjs"), "export default 42;\n");
    await writeFile(join(dir, "b-wanted.mjs"), plain("wanted"));

    const workflow = await resolveWorkspaceWorkflow({ cwd: root, registry: createWorkflowRegistry(), id: "wanted" });

    expect(workflow?.id).toBe("wanted");
  });

  it("picks up a rewritten file instead of the cached first draft", async () => {
    const { root, dir } = await workspace();
    const file = join(dir, "release.mjs");
    await writeFile(file, plain("release"));
    const registry = createWorkflowRegistry();
    expect((await resolveWorkspaceWorkflow({ cwd: root, registry, id: "release" }))?.description).toBe("does release");

    await writeFile(file, 'export default { __workflow: true, id: "release", description: "the second draft" };\n');
    const later = new Date(Date.now() + 5000);
    await utimes(file, later, later);

    expect((await resolveWorkspaceWorkflow({ cwd: root, registry, id: "release" }))?.description).toBe("does release");
    // The registry keeps the definition it was given, which is why the lookup that
    // matters here is a fresh one: nah resolves from disk when a name is missing.
    const fresh = await resolveWorkspaceWorkflow({ cwd: root, registry: createWorkflowRegistry(), id: "release" });
    expect(fresh?.description).toBe("the second draft");
  });

  it("finds nothing in a workspace that never made one", async () => {
    const root = await mkdtemp(join(tmpdir(), "nah-empty-workspace-"));

    expect(await listWorkspaceWorkflowFiles(root)).toEqual([]);
    expect(await loadWorkspaceWorkflows({ cwd: root })).toEqual({ loaded: [], failed: [] });
  });

  it("tells the agent to ask before it builds, and to keep parameters out of memory", () => {
    const brief = workspaceWorkflowBrief("cut a release to a tag and open a PR");

    expect(brief).toContain("cut a release to a tag and open a PR");
    // The order is the contract: questions first, file second.
    expect(brief.indexOf("Ask before you build")).toBeLessThan(brief.indexOf("Once they answer, write one file"));
    expect(brief).toContain("Do not put this workflow's parameters in memory");
    expect(brief).toContain(WORKSPACE_WORKFLOW_DIR);
  });
});

describe("the /workflow command", () => {
  const state = (over: Partial<SessionState> = {}): SessionState =>
    ({ workflows: createWorkflowRegistry(), ...over }) as unknown as SessionState;

  const run = async (line: string, cwd: string, s: SessionState) => {
    const output: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        output.push(String(chunk));
        done();
      },
    });
    const result = await handleSlashCommand(line, s, cwd, stream);
    return { prompt: typeof result === "object" ? result.prompt : null, text: output.join("") };
  };

  it("is in the command registry, so /help and the modal list it", () => {
    expect(SLASH_COMMANDS.some(({ name }) => name === "workflow")).toBe(true);
    expect(SLASH_COMMANDS.some(({ name }) => name.startsWith("workspace"))).toBe(false);
  });

  it("hands the turn a brief built from what the user typed", async () => {
    const { root } = await workspace();

    const { prompt } = await run("/workflow new cut a release to a tag", root, state());

    // A prompt rather than output: the questions have to come back from a turn.
    expect(prompt).toContain("cut a release to a tag");
    expect(prompt).toContain("Ask before you build");
  });

  it("takes the whole sentence after `new`, not just one word of it", async () => {
    const { root } = await workspace();

    const { prompt } = await run("/workflow new A workflow that does...", root, state());

    expect(prompt).toContain("A workflow that does...");
  });

  it("takes a quoted description the way a shell passes one", async () => {
    const { root } = await workspace();

    const { prompt } = await run(`/workflow new 'cut a release to a tag'`, root, state());

    expect(prompt).toContain("cut a release to a tag");
    // The wrapping quotes are the shell's, not the user's sentence.
    expect(prompt).not.toContain("'cut a release to a tag'");
  });

  it("asks for the description instead of building nothing", async () => {
    const { root } = await workspace();

    const { prompt, text } = await run("/workflow new", root, state());

    expect(prompt).toBeNull();
    expect(text).toContain("/workflow new <description>");
  });

  it("lists the workspace's own workflows and registers them", async () => {
    const { root, dir } = await workspace();
    await writeFile(join(dir, "release.mjs"), plain("release"));
    const s = state();

    const { text } = await run("/workflow", root, s);

    expect(text).toContain("release.mjs");
    expect(text).toContain("release");
    expect(s.workflows?.get("release")).toBeDefined();
  });

  it("names a file it cannot load instead of staying quiet about it", async () => {
    const { root, dir } = await workspace();
    await writeFile(join(dir, "broken.mjs"), "export default 42;\n");

    const { text } = await run("/workflow", root, state());

    expect(text).toContain("broken.mjs");
    expect(text).toContain("not a workflow");
  });

  it("says how to start when the workspace has none", async () => {
    const { root } = await workspace();

    const { text } = await run("/workflow", root, state());

    expect(text).toContain("No workspace workflows yet");
    expect(text).toContain("/workflow new");
  });

  it("says nothing can be built in a sandbox", async () => {
    const { root } = await workspace();
    const s = state({ workflows: undefined });

    const { prompt, text } = await run("/workflow new cut a release", root, s);

    expect(prompt).toBeNull();
    expect(text).toContain("sandboxed");
  });

  it("runs a workflow file the registry has never seen", async () => {
    const { root, dir } = await workspace();
    const s = state({
      orchestrator: {
        runWorkflow: async (workflow: { id: string }) => ({ status: "success", result: { id: workflow.id }, steps: {} }),
      },
    } as unknown as Partial<SessionState>);
    // Written after the session started, and never listed: this is the file the agent
    // wrote a moment ago, which is the whole reason `resolveWorkspaceWorkflow` exists.
    await writeFile(join(dir, "release.mjs"), plain("release"));

    const { text } = await run("/workflow release", root, s);

    expect(text).not.toContain("no workflow named");
    expect(text).toContain("running release");
    expect(text).toContain("release");
  });

  it("names the file that will not load when the name is not found", async () => {
    const { root, dir } = await workspace();
    await writeFile(join(dir, "broken.mjs"), "export default 42;\n");

    const { text } = await run("/workflow nope", root, state());

    expect(text).toContain("no workflow named");
    // The likeliest reason a name the user believes they created is missing.
    expect(text).toContain("broken.mjs");
    expect(text).toContain("not a workflow");
  });
});
