import { Code, DocHeader, DocSection, DocsShell, Note } from "@/components/docs/DocsShell";

const tuiSample = [
  "running ──────────────────────────────",
  "◆ read src/auth.ts",
  "◆ grep validateToken",
  "  3 matches",
  "assistant text streams here…",
  "",
  "steer › actually use the jose library",
].join("\n");

const sessionSample = [
  "nah                          # new session",
  "nah -c                      # resume the most recent",
  "nah --session a1b2c3d4e5f6  # resume exactly this one",
  "nah --session ./notes.jsonl # or an explicit path",
].join("\n");

const modesSample = [
  "nah                              # interactive",
  'nah "fix the flaky test"        # run prompt, then open the UI',
  'nah -p "summarize this diff"    # print answer and exit',
  'nah --mode json "inspect auth"  # JSONL events to stdout',
  'git diff | nah -p "review this" # include stdin as prompt context',
].join("\n");

const permissionSample = [
  'nah --permissions readonly -p "summarize src/auth"',
  'nah --permissions ask --mode json "inspect only"',
].join("\n");

const replSample = [
  "/help                 Show commands",
  "/model <spec>         Switch model",
  "/memory               Show memory tiers and what was injected",
  "/permissions [mode]   Set ask, yolo, or readonly",
  "/stats                Show session token usage",
  "/compact              Compact the transcript using truncation",
  "/clear                Drop the current transcript",
  "/session new|off      Start a JSONL session file or stop persisting",
  "/quit                 Exit",
].join("\n");

const workSample = [
  "/task                  Show the active plan",
  "/task clear            Clear the plan",
  "/branches              List session branches",
  "/branch <name>         Fork or switch branch",
  "/session list          List sessions for this directory",
  "/diff                  Show workspace changes",
  "/undo [step]           Undo the last turn or a step",
].join("\n");

const options = [
  ["-m, --model", "provider:model-id, such as anthropic:claude-sonnet-4-5 or openai:gpt-4.1."],
  ["-c, --continue", "Resume the most recent session for this working directory."],
  ["--session <id|path>", "Resume exactly that session, by id or by file path."],
  ["--no-session", "Keep the session in memory; do not persist it."],
  ["--no-tui", "Use the line renderer instead of the alternate-screen TUI."],
  ["-y, --yolo", "Allow mutating tool calls without prompting."],
  ["--permissions", "Set ask, yolo, or readonly behavior."],
  ["--sandbox [name]", "Use a Blaxel sandbox; requires BL_API_KEY and BL_WORKSPACE."],
  ["-h, --help", "Print the full CLI help."],
];

export default function CliPage() {
  return <DocsShell current="/docs/cli"><DocHeader eyebrow="CLI / REFERENCE" title="A terminal interface to the same runtime." description="Use the interactive session for collaborative work, print mode for one-shot prompts, or JSON mode when another program needs the event stream." />
    <DocSection id="tui" title="The interactive surface"><p>On a real terminal NAH runs an alternate-screen interface built on the same TUI library Pi uses: a scrollable transcript with the prompt pinned below it. That layout is the point — streamed output lives in its own region, so it can never land on the line you are typing.</p><Code language="text">{tuiSample}</Code><p>While a turn runs you can keep typing. Submitting steers that turn instead of queueing a new one; a slash command is held until the turn settles. <code className="font-mono text-[11px] text-zinc-300">Cmd+C</code> or <code className="font-mono text-[11px] text-zinc-300">Ctrl+Shift+C</code> copies the selection, and plain <code className="font-mono text-[11px] text-zinc-300">Ctrl+C</code> aborts.</p><Note title="When the TUI is not used">The alternate screen needs a TTY. Pipes, CI and dumb terminals fall back to a line-oriented renderer automatically, and <code>--no-tui</code> forces it. <code>NAH_NO_MOUSE=1</code> disables mouse tracking if your terminal mishandles SGR mouse reports; you lose drag-select and wheel scrolling but the interface stays usable.</Note></DocSection>

    <DocSection id="sessions" title="One session per run"><p>Each run of <code>nah</code> starts a <em>new</em> session in its own file, so a fresh run never silently appends onto the previous one&apos;s transcript. The first run in a directory uses its own id; later runs get suffixed ids.</p><Code>{sessionSample}</Code><p>Resuming replays the earlier turns into the transcript pane, so the history is visible before you type.</p></DocSection>

    <DocSection id="modes" title="Run modes"><Code>{modesSample}</Code><p>Use <code className="font-mono text-[11px] text-zinc-300">@path</code> arguments to include file contents in the initial prompt, and <code className="font-mono text-[11px] text-zinc-300">--cwd</code> to select the workspace root.</p></DocSection>

    <DocSection id="options" title="Common options"><div className="space-y-2">{options.map(([flag, desc]) => <div key={flag} className="grid gap-1 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 sm:grid-cols-[145px_1fr] sm:gap-4"><code className="font-mono text-[10px] text-violet-200">{flag}</code><span className="text-xs leading-5 text-zinc-500">{desc}</span></div>)}</div></DocSection>

    <DocSection id="permissions" title="Permission modes"><p>Interactive mode defaults to <code className="font-mono text-[11px] text-zinc-300">ask</code>. Answer <code className="font-mono text-[11px] text-zinc-300">y</code> once, <code className="font-mono text-[11px] text-zinc-300">a</code> to allow that whole tool for the session, or <code className="font-mono text-[11px] text-zinc-300">A</code> for only that exact call. Print and JSON modes default to <code className="font-mono text-[11px] text-zinc-300">yolo</code>, since the process cannot pause for an interactive prompt. Specify <code className="font-mono text-[11px] text-zinc-300">--permissions readonly</code> to make those modes read-only.</p><Code>{permissionSample}</Code></DocSection>

    <DocSection id="repl" title="Session commands"><p>Within interactive mode, use these slash commands to manage the active session. Typing <code className="font-mono text-[11px] text-zinc-300">/</code> opens a filtered command modal; press Enter to insert a command. Arguments are typed freely and nothing is suggested until the command is submitted.</p><Code>{replSample}</Code><Note title="Session storage">The CLI persists conversations as JSONL under <code>~/.nah/sessions</code>. Use <code>--no-session</code> to opt out for a run; <code>/session new</code> starts a new file mid-session.</Note></DocSection>

    <DocSection id="work-management" title="Plans, sessions, and undo"><p>For substantial multi-step work, the CLI gives the agent a <code>task_ledger</code> tool. It can discover executable checks, save an ordered plan and acceptance commands, record check attempts and exit codes, and track progress across turns. Use <code>/task</code> to inspect the saved plan and <code>/task clear</code> to remove it.</p><p>Conversations are stored as append-only JSONL entries under <code>~/.nah/sessions</code>, one file per session. <code>/session list</code> shows every session for the directory with timestamps.</p><p>Memory is separate from the transcript: it is stored per working directory and survives into later sessions. <code>/memory</code> shows the tiers and what was injected into each prompt.</p><p>Interactive turns keep recovery information for tool changes. Use <code>/diff</code> to inspect workspace changes and <code>/undo</code> to undo the last turn; <code>/undo &lt;step&gt;</code> targets a particular step from the latest turn.</p><Code>{workSample}</Code></DocSection>

    <DocSection id="delegation" title="Delegate independent work"><p>The interactive CLI provides a <code>delegate_task</code> tool for bounded, independent subtasks. A child starts from committed <code>HEAD</code> in a temporary detached Git worktree, so it cannot see uncommitted parent changes. The parent receives the child status, metrics, changed paths, and diff, then reviews and integrates any changes itself. Delegation requires approval under the ask permission mode and is limited to three concurrent children.</p><Note title="Choose a self-contained task">Give the child the context and acceptance criteria it needs, and delegate only work that does not depend on the current uncommitted diff or another unfinished child.</Note></DocSection>
  </DocsShell>;
}