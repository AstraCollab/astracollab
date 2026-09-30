import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

type NahPreferences = {
  lastModel?: string;
};

const preferencesPath = (): string => nodePath.join(os.homedir(), ".nah", "config.json");

export const loadLastModel = async (): Promise<string | undefined> => {
  try {
    const raw = await fs.readFile(preferencesPath(), "utf8");
    const parsed = JSON.parse(raw) as NahPreferences;
    return typeof parsed.lastModel === "string" && parsed.lastModel.trim()
      ? parsed.lastModel.trim()
      : undefined;
  } catch {
    return undefined;
  }
};

export const saveLastModel = async (model: string): Promise<void> => {
  const path = preferencesPath();
  const directory = nodePath.dirname(path);
  let preferences: NahPreferences = {};
  try {
    preferences = JSON.parse(await fs.readFile(path, "utf8")) as NahPreferences;
  } catch {
    preferences = {};
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify({ ...preferences, lastModel: model }, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(temporaryPath, path);
  await fs.chmod(path, 0o600);
};
