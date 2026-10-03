import type { ToolSet } from "ai";

import { wrapToolsWithSanitisers, type ToolSanitisers } from "./tool-input.js";

/**
 * Merge client tools into the harness map, keeping the sanitisers on both.
 *
 * The two inline coding-agent tools — `codebase_semantic_search` and
 * `write_codebase_profile` — stay in the client repo. They depend on the code
 * index, the pgvector store, the Blaxel codegen client and the codebase-profile
 * schema, none of which belong in a shared package. What changes for them is the
 * *registration*: they go into a NAH tool map instead of a Mastra `Agent`.
 *
 * They are sanitised like everything else. A tool this package has never heard of
 * still gets the coercion, because the failure it fixes — a provider writing
 * `"True"` for a boolean — is a property of the model, not of the tool.
 *
 * A name that collides with a harness tool replaces it: a workspace with its own
 * `list` or a repo-specific `grep` should not need the harness to change.
 */
export const withExtraTools = (tools: ToolSet, extra: ToolSet = {}, sanitisers?: ToolSanitisers): ToolSet =>
  wrapToolsWithSanitisers({ ...tools, ...extra }, sanitisers);
