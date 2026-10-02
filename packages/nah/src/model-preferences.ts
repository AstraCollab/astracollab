/**
 * The last-used model.
 *
 * A thin wrapper over the shared `~/.nah/config.json` writer, which is where the
 * Cognitive Memory connection lives too. Both used to read-modify-write this file
 * on their own, which is a race with a lost update rather than a merge.
 */
import { readConfig, updateConfig } from "./nah-config.js";

export const loadLastModel = async (): Promise<string | undefined> => {
  const model = (await readConfig()).lastModel;
  return typeof model === "string" && model.trim() ? model.trim() : undefined;
};

export const saveLastModel = async (model: string): Promise<void> => {
  await updateConfig((current) => ({ ...current, lastModel: model }));
};
