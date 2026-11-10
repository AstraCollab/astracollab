import { tool, type Tool } from "ai";
import { z } from "zod";
import type { SessionState } from "./session.js";
import { saveSessionName } from "./session.js";

const MAX_NAME = 64;

/** `name_session`: lets the agent give the current session a memorable label. */
export const createNameSessionTool = (state: SessionState): Tool =>
  tool({
    description: "Give this session a memorable name based on the task at hand, so it can be found again with /session list or nah --session. Call this once at the start of a session with a short name like \"fix-login-flow\" or \"upgrade-dependencies\".",
    inputSchema: z.object({
      name: z.string().min(1).max(MAX_NAME).describe("A short session name, e.g. fix-login-flow"),
    }),
    execute: async ({ name }) => {
      if (!state.store) return "Error: this session is not persisted, so it cannot be named.";
      state.name = name;
      await saveSessionName(state.store, name);
      return `Session named “${name}”.`;
    },
  });
