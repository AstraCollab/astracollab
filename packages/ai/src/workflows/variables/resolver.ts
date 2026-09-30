const VARIABLE_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;

export const extractVariablePaths = (template: string): string[] => {
  const paths = new Set<string>();
  for (const match of template.matchAll(VARIABLE_PATTERN)) {
    const path = match[1]?.trim();
    if (path) paths.add(path);
  }
  return [...paths];
};

const readPath = (source: unknown, path: string): unknown => {
  const segments = path.split(".").filter(Boolean);
  let current: unknown = source;
  for (const segment of segments) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

export const resolveTemplate = (
  template: string,
  context: Record<string, unknown>,
): string =>
  template.replace(VARIABLE_PATTERN, (_full, rawPath: string) => {
    const path = rawPath.trim();
    const value = readPath(context, path);
    if (value === undefined || value === null) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  });

export const resolveTemplateObject = (
  input: Record<string, unknown>,
  context: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      out[key] = resolveTemplate(value, context);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = resolveTemplateObject(value as Record<string, unknown>, context);
    } else {
      out[key] = value;
    }
  }
  return out;
};

export const buildVariableContext = (state: {
  trigger: unknown;
  nodes: Record<string, unknown>;
  org?: unknown;
  actor?: unknown;
}): Record<string, unknown> => ({
  trigger: state.trigger,
  nodes: state.nodes,
  org: state.org,
  actor: state.actor,
});
