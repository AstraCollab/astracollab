import type {
  CopyOptions,
  FileContent,
  FileEntry,
  FileStat,
  ListOptions,
  ProviderStatus,
  ReadOptions,
  RemoveOptions,
  WorkspaceFilesystem,
  WriteOptions,
} from "@mastra/core/workspace";
import {
  DirectoryNotFoundError,
  FileNotFoundError,
  IsDirectoryError,
  NotDirectoryError,
  PermissionError,
} from "@mastra/core/workspace";
import type { SandboxInstance } from "@blaxel/core";
import type { RepoSandboxFs } from "../../sandbox-fs/repo-fs-port.js";
import { normalizeUnderRepoRoot, RepoPathError } from "../../sandbox-fs/path-utils.js";
import { createBlaxelRepoSandboxFs } from "../../sandbox-fs/blaxel-repo-fs.js";

export type RepoWorkspaceFilesystemOptions = {
  repoFs: RepoSandboxFs;
  repoRoot: string;
};

/**
 * Mastra {@link WorkspaceFilesystem} backed by a provider-agnostic {@link RepoSandboxFs}.
 */
export class RepoWorkspaceFilesystem implements WorkspaceFilesystem {
  readonly id = "astra-repo-sandbox-fs";
  readonly name = "RepoWorkspaceFilesystem";
  readonly provider = "sandbox-repo";
  readonly basePath: string;
  /** Blaxel-backed repo FS is usable as soon as the sandbox instance exists. */
  readonly status: ProviderStatus = "ready";

  private readonly repoFs: RepoSandboxFs;

  constructor(options: RepoWorkspaceFilesystemOptions) {
    this.repoFs = options.repoFs;
    this.basePath = options.repoRoot.endsWith("/")
      ? options.repoRoot.slice(0, -1)
      : options.repoRoot;
  }

  private resolve(path: string): string {
    try {
      return normalizeUnderRepoRoot(this.basePath, path);
    } catch (e) {
      if (e instanceof RepoPathError) {
        throw new PermissionError(path, "read");
      }
      throw e;
    }
  }

  getInstructions(): string {
    return `All file paths are under the repository root \`${this.basePath}\`. Use absolute paths under that root or paths relative to it.`;
  }

  async readFile(path: string, options?: ReadOptions): Promise<string | Buffer> {
    const abs = this.resolve(path);
    const text = await this.repoFs.readText(abs);
    if (options?.encoding && options.encoding !== "utf8" && options.encoding !== "utf-8") {
      return Buffer.from(text, options.encoding as BufferEncoding);
    }
    return text;
  }

  async writeFile(path: string, content: FileContent, options?: WriteOptions): Promise<void> {
    const abs = this.resolve(path);
    const str =
      typeof content === "string"
        ? content
        : Buffer.isBuffer(content)
          ? content.toString("utf8")
          : Buffer.from(content).toString("utf8");
    await this.repoFs.writeText(abs, str, { recursive: options?.recursive });
  }

  async appendFile(path: string, content: FileContent): Promise<void> {
    const abs = this.resolve(path);
    const str =
      typeof content === "string"
        ? content
        : Buffer.isBuffer(content)
          ? content.toString("utf8")
          : Buffer.from(content).toString("utf8");
    await this.repoFs.appendText(abs, str);
  }

  async deleteFile(path: string, options?: RemoveOptions): Promise<void> {
    const abs = this.resolve(path);
    const exists = await this.repoFs.exists(abs);
    if (!exists && options?.force) {
      return;
    }
    if (!exists) {
      throw new FileNotFoundError(abs);
    }
    const st = await this.repoFs.stat(abs);
    if (st.type === "directory") {
      throw new IsDirectoryError(abs);
    }
    await this.repoFs.deletePath(abs, { recursive: false, force: options?.force });
  }

  async copyFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    await this.repoFs.copyFile(this.resolve(src), this.resolve(dest), {
      overwrite: options?.overwrite,
    });
  }

  async moveFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    await this.repoFs.moveFile(this.resolve(src), this.resolve(dest), {
      overwrite: options?.overwrite,
    });
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.repoFs.mkdir(this.resolve(path), options);
  }

  async rmdir(path: string, options?: RemoveOptions): Promise<void> {
    await this.repoFs.rmdir(this.resolve(path), options);
  }

  async readdir(path: string, options?: ListOptions): Promise<FileEntry[]> {
    const abs = this.resolve(path);
    const exists = await this.repoFs.exists(abs);
    if (!exists) {
      throw new DirectoryNotFoundError(abs);
    }
    const st = await this.repoFs.stat(abs);
    if (st.type !== "directory") {
      throw new NotDirectoryError(abs);
    }
    const entries = await this.repoFs.listDir(abs, { recursive: options?.recursive });
    return entries.map((e) => ({
      name: e.name,
      type: e.type,
      size: e.size,
    }));
  }

  async exists(path: string): Promise<boolean> {
    return this.repoFs.exists(this.resolve(path));
  }

  async stat(path: string): Promise<FileStat> {
    const abs = this.resolve(path);
    const exists = await this.repoFs.exists(abs);
    if (!exists) {
      throw new FileNotFoundError(abs);
    }
    const s = await this.repoFs.stat(abs);
    return {
      name: s.name,
      path: s.path,
      type: s.type,
      size: s.size,
      createdAt: s.createdAt,
      modifiedAt: s.modifiedAt,
    };
  }

  resolveAbsolutePath(path: string): string | undefined {
    return this.resolve(path);
  }
}

export const createRepoWorkspaceFilesystemFromBlaxel = (options: {
  getBlaxelInstance: () => SandboxInstance;
  repoRoot: string;
}): WorkspaceFilesystem => {
  const repoFs = createBlaxelRepoSandboxFs({
    repoRoot: options.repoRoot,
    getInstance: options.getBlaxelInstance,
  });
  return new RepoWorkspaceFilesystem({ repoFs, repoRoot: options.repoRoot });
};
