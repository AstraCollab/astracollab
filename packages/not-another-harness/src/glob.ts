/**
 * Minimal glob matching for workspace file discovery.
 *
 * Discovery by name pattern is the missing primitive in a coding toolset:
 * without it an agent has to `list` its way down the tree or guess paths.
 * Supports `*` (within a segment), `**` (across segments), `?`, and `{a,b}`
 * alternation — which covers every pattern a model realistically writes.
 */

const escapeRe = (char: string): string =>
	char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const segmentToRegExp = (segment: string): string => {
	let out = "";
	for (let i = 0; i < segment.length; i += 1) {
		const char = segment[i]!;
		if (char === "*") {
			out += "[^/]*";
		} else if (char === "?") {
			out += "[^/]";
		} else if (char === "{") {
			const close = segment.indexOf("}", i);
			if (close < 0) {
				out += "\\{";
				continue;
			}
			const alternatives = segment
				.slice(i + 1, close)
				.split(",")
				.filter(Boolean);
			out +=
				alternatives.length > 0
					? `(?:${alternatives.map(segmentToRegExp).join("|")})`
					: "(?!)";
			i = close;
		} else {
			out += escapeRe(char);
		}
	}
	return out;
};

/** Compile a `/`-separated glob into an anchored RegExp. */
export const globToRegExp = (pattern: string): RegExp => {
	const segments = pattern.split("/");
	let source = "";
	for (let i = 0; i < segments.length; i += 1) {
		const segment = segments[i]!;
		const isLast = i === segments.length - 1;
		if (segment === "**") {
			if (isLast) {
				// `a/**` matches everything beneath `a`.
				source += source.endsWith("/") || source === "" ? ".*" : "(?:/.*)?";
			} else {
				// `**/` matches zero or more whole segments, separator included.
				source += "(?:[^/]+/)*";
			}
		} else {
			source += segmentToRegExp(segment);
			if (!isLast) {
				source += "/";
			}
		}
	}
	return new RegExp(`^${source}$`);
};

/** True when a value contains glob metacharacters and must not be treated as a literal path. */
export const hasGlobMagic = (value: string): boolean => /[*?[\]{}]/.test(value);

/**
 * Leading literal segments of a pattern, used to skip straight to the relevant
 * subtree instead of walking the whole workspace.
 */
export const globStaticPrefix = (pattern: string): string[] => {
	const out: string[] = [];
	for (const segment of pattern.split("/")) {
		if (!segment || hasGlobMagic(segment)) break;
		out.push(segment);
	}
	return out;
};
