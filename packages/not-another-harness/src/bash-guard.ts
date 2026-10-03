/**
 * Refuse shell commands that rewrite source files from an inline script.
 *
 * The failure this exists to stop, from a real run: asked to delete two stray
 * blank lines from a 1,100-line component, the agent never opened the file and
 * instead ran
 *
 *     cd app && python3 - <<'PY'
 *     s = open('components/Dashboard.tsx').read()
 *     open('components/Dashboard.tsx','w').write(re.sub(r'\n\n\n+', '\n\n', s))
 *     PY
 *
 * which reported success and rewrote 117 lines — 35 insertions, 82 deletions —
 * across a file nobody had read. The whole run then burned half a million
 * tokens, and the damage was invisible until a human diffed it.
 *
 * Every guardrail in this harness is bypassed by that command. The read-before-
 * write gate never fires (no `read` happened). The approval gate sees only an
 * opaque `bash`. `onFileWrite` records nothing, so there is no undo entry. And
 * because the rewrite is one atomic call, the model gets no chance to notice a
 * scale it did not intend.
 *
 * The escape hatch is real, not rhetorical: write the codemod with `write` and
 * run it with `bash`. A saved script is reviewable, re-runnable, and shows up
 * in the diff. Real codemods (`prettier --write`, `tsc --fix`, `eslint --fix`)
 * are untouched — the problem is the inline interpreter, not the shell.
 *
 * Scope is deliberately narrow. This does not police redirection, `sed -i`,
 * heredocs that only write new files, or any read-only script: the last of
 * those is a legitimate way to analyse a file cheaply. It blocks exactly one
 * thing, the unreviewable whole-file rewrite smuggled past every other guard.
 */

export type ScriptedMutation = {
	/** The interpreter that was about to do the writing. */
	interpreter: string;
	/** The model-facing refusal. */
	message: string;
};

/**
 * Interpreters worth policing, anchored to a command head.
 *
 * Anchoring matters: `python3` inside a grep pattern or a filename is not an
 * invocation, and matching it would refuse ordinary search commands.
 */
const INTERPRETER_HEAD =
	/(?:^|[\n;&|]\s*|\bexec\s+|\bsudo\s+|\benv\s+)(python3?(?:\.\d+)?|pypy3?|node|perl|ruby|php)\b/g;

/**
 * An inline program rather than a path to a saved one.
 *
 * `python3 migrate.py` is reviewable and stays allowed; `python3 - <<'PY'`,
 * `python3 -c`, `perl -pi -e`, and `node -e` are not.
 */
const INLINE_PROGRAM =
	/(?:-[a-zA-Z]*c[a-zA-Z]*\s|-[a-zA-Z]*e[a-zA-Z]*\s|<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?)/;

/** Interpreter flags that write in place without an explicit `-e`/`-c`. */
const INPLACE_FLAG = /-(?:[a-zA-Z]*i)(?:[a-zA-Z]*)\b/;

/** Ways an inline program writes a file. */
const WRITE_INTENT = new RegExp(
	[
		// node / python / ruby API writes
		"\\b(?:writeFile|writeFileSync|appendFile|appendFileSync|write_text|write_bytes|createWriteStream)\\b",
		// `open(f,'w')`, `open(f, "a")`, `open(f, 'wb+')` — a read-only open has no mode.
		"\\bopen\\s*\\([^)]*['\"][waxr]\\+?b?['\"]",
		// bare `.write(`, `fs.write(`
		"\\.\\s*write\\s*\\(",
		// perl/ruby in-place
		INPLACE_FLAG.source,
		// shell redirection inside the script body
		"(?:^|[^<])>>?\\s*['\"]?[\\w@%+=:,./-]+\\.[A-Za-z0-9]{1,6}['\"]?\\s*$",
	].join("|"),
	"m",
);

/** Where one command ends, so a later unrelated command is not swept in. */
const COMMAND_END = /(?:\n|&&|\|\||;)/;

/**
 * The text a single interpreter invocation governs.
 *
 * A heredoc body has to be followed through to its terminator, which is why a
 * plain split on newlines would find the interpreter and then throw away the
 * write it was about to perform.
 */
const invocationText = (command: string, start: number): string => {
	const rest = command.slice(start);
	// Where this invocation's own command ends. A heredoc marker past this point
	// belongs to a *later* command, and following it would blame that later
	// command's write on the interpreter named first.
	const end = COMMAND_END.exec(rest);
	const head = end ? rest.slice(0, end.index) : rest;
	const heredoc = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(head);
	if (!heredoc) return head;
	// The body follows on the lines after the marker, so the command has to be
	// followed through to its terminator rather than cut at the newline.
	const terminator = new RegExp(`^\\s*${heredoc[1]}\\s*$`, "m");
	const after = terminator.exec(rest.slice(end ? end.index + 1 : 0));
	return after
		? rest.slice(0, (end ? end.index + 1 : 0) + after.index + after[0].length)
		: rest;
};

/**
 * The inline-script file rewrite in `command`, or null when there isn't one.
 */
export const detectScriptedMutation = (
	command: string,
): ScriptedMutation | null => {
	INTERPRETER_HEAD.lastIndex = 0;
	for (
		let match = INTERPRETER_HEAD.exec(command);
		match;
		match = INTERPRETER_HEAD.exec(command)
	) {
		const interpreter = match[1];
		if (!interpreter) continue;
		const invocation = invocationText(
			command,
			match.index + match[0].length - interpreter.length,
		);
		if (!INLINE_PROGRAM.test(invocation) && !INPLACE_FLAG.test(invocation))
			continue;
		if (!WRITE_INTENT.test(invocation)) continue;
		return { interpreter, message: scriptedMutationRefusal(interpreter) };
	}
	return null;
};

/**
 * The refusal, written for a model that has to pick a different tool next.
 *
 * It names the mechanism (no file was ever read, so nothing bounds the blast
 * radius) and the three honest alternatives, because a refusal without a route
 * forward just becomes a retry.
 */
const scriptedMutationRefusal = (interpreter: string): string =>
	`DENIED: \`${interpreter}\` with an inline program would rewrite files without your having read them. Nothing bounds the blast radius — the same script that removes two blank lines can silently reformat hundreds of lines you never saw, and it lands in one atomic write so nothing surfaces the scale. It also bypasses read-before-write, the approval prompt, and the undo record.\nUse \`edit\` with a few lines of surrounding context for a targeted change, \`replace_all\` when the same change repeats within one file, or \`write\` a codemod script and then run it with bash so the change is reviewable in the diff. Real tools are fine — \`prettier --write\`, \`tsc --fix\`, \`eslint --fix\`. To read or analyse a file with code, that is allowed: run the interpreter without writing anything.`;
