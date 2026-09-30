/**
 * Provider-agnostic repo filesystem under a single absolute root (e.g. `/workspace/repo`).
 * Implemented by Blaxel today; other sandboxes can add their own adapters.
 */
export type RepoFsEntry = {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
};

export interface RepoSandboxFs {
  readonly repoRoot: string;

  readText(absolutePath: string): Promise<string>;
  writeText(
    absolutePath: string,
    content: string,
    options?: { recursive?: boolean },
  ): Promise<void>;
  appendText(absolutePath: string, content: string): Promise<void>;
  deletePath(absolutePath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  listDir(absolutePath: string, options?: { recursive?: boolean }): Promise<RepoFsEntry[]>;
  exists(absolutePath: string): Promise<boolean>;
  stat(absolutePath: string): Promise<{
    name: string;
    path: string;
    type: "file" | "directory";
    size: number;
    createdAt: Date;
    modifiedAt: Date;
  }>;
  copyFile(srcAbsolute: string, destAbsolute: string, options?: { overwrite?: boolean }): Promise<void>;
  moveFile(srcAbsolute: string, destAbsolute: string, options?: { overwrite?: boolean }): Promise<void>;
  mkdir(absolutePath: string, options?: { recursive?: boolean }): Promise<void>;
  rmdir(absolutePath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}
