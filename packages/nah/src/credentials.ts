/**
 * Secrets in the platform credential store.
 *
 * Provider keys and the Cognitive Memory key live in the same place, through the
 * same code, because "which OS am I on" is the only thing that should differ
 * between them. The service name is namespaced per kind so removing a Cognitive
 * Memory key can never take a provider key with it.
 *
 * Two ways in, both ending in the same store:
 *
 * - `storeSecretInteractively` hands the terminal to the OS (the macOS Keychain
 *   dialog, a desktop keyring on Linux, DPAPI on Windows). The secret never
 *   passes through this process.
 * - `storeSecretFromPrompt` reads a hidden paste here and writes it. On macOS it
 *   goes through `security -i` so the value travels on stdin: `security
 *   add-generic-password -w <key>` would put it in the process table, where any
 *   other process on the machine can read it for as long as the call takes.
 */
import { spawn } from "node:child_process";
import * as readline from "node:readline";
import * as nodePath from "node:path";

export type BuiltinProvider = "anthropic" | "openai" | "openrouter";

/** Which store an account belongs to. Never share a service name across kinds. */
export type SecretKind = "provider" | "cogmem";

const KEYCHAIN_SERVICE: Record<SecretKind, string> = {
  provider: "com.astracollab.nah.provider",
  cogmem: "com.astracollab.nah.cogmem",
};

/** libsecret attributes, which have no notion of a service *name* prefix. */
const LINUX_SERVICE: Record<SecretKind, string> = {
  provider: "astracollab-nah",
  cogmem: "astracollab-nah-cogmem",
};

/**
 * The kind stays its own attribute rather than being folded into the service
 * name, because that is the tuple existing provider keys were written under.
 * libsecret matches every attribute exactly, so changing the shape would leave
 * every already-stored key unreachable — a silent loss, on the one platform with
 * no dialog to notice it in.
 */
const linuxAttributes = (kind: SecretKind): string[] => ["service", LINUX_SERVICE[kind], kind];

const run = (
  command: string,
  args: string[],
  options: { input?: string; inherit?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    stdio: options.inherit ? "inherit" : [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    windowsHide: true,
    env: process.env,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  if (options.input !== undefined) child.stdin?.end(options.input);
});

const powershell = (script: string): string[] => [
  "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
];

const dpapiPath = (kind: SecretKind, account: string): string | null => {
  const dir = process.env.LOCALAPPDATA;
  if (!dir) return null;
  return nodePath.join(dir, "NAH", kind === "provider" ? "providers" : "cogmem", `${account}.dpapi`);
};

/**
 * One `add-generic-password` line for `security -i`.
 *
 * Exported for the test that asserts the secret is not on the command line,
 * which is the only property here worth a test: everything else is a spawn
 * against the OS.
 */
export const macKeychainAddCommand = (service: string, account: string, secret: string): string =>
  `add-generic-password -U -s ${JSON.stringify(service)} -a ${JSON.stringify(account)} -w ${JSON.stringify(secret)}`;

/**
 * Secrets cannot be quoted into `security -i` without ambiguity, and a mangled
 * key looks exactly like a wrong key at 3am. Refuse rather than guess.
 */
const assertQuotable = (secret: string): void => {
  if (/["\\\n\r]/.test(secret)) {
    throw new Error(
      "That value contains a quote or a newline and cannot be stored safely on this platform. " +
        "Use the native prompt instead (choose 'keychain' in /cogmem setup), or set COGNITIVE_MEMORY_KEY.",
    );
  }
};

export const getStoredSecret = async (kind: SecretKind, account: string): Promise<string | undefined> => {
  try {
    if (process.platform === "darwin") {
      const result = await run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE[kind], "-a", account, "-w"]);
      return result.code === 0 ? result.stdout.replace(/[\r\n]+$/, "") || undefined : undefined;
    }
    if (process.platform === "linux") {
      const result = await run("secret-tool", ["lookup", ...linuxAttributes(kind), account]);
      return result.code === 0 ? result.stdout.replace(/[\r\n]+$/, "") || undefined : undefined;
    }
    if (process.platform === "win32") {
      const path = dpapiPath(kind, account);
      if (!path) return undefined;
      const script = `$p=${JSON.stringify(path)}; if (Test-Path -LiteralPath $p) { $s=Get-Content -Raw -LiteralPath $p | ConvertTo-SecureString; $c=New-Object System.Net.NetworkCredential('', $s); [Console]::Out.Write($c.Password) }`;
      const result = await run("powershell.exe", powershell(script));
      return result.code === 0 ? result.stdout || undefined : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const promptHidden = (question: string): Promise<string | undefined> => {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== "function") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const out = process.stdout;
    const wasRaw = input.isRaw;
    let value = "";
    const finish = (secret?: string) => {
      input.off("keypress", onKeypress);
      input.setRawMode(Boolean(wasRaw));
      out.write("\n");
      resolve(secret);
    };
    const onKeypress = (sequence: string, key: readline.Key) => {
      if (key.ctrl && key.name === "c") return finish();
      if (key.name === "return") return finish(value || undefined);
      if (key.name === "backspace") {
        value = Array.from(value).slice(0, -1).join("");
        out.write("\b \b");
        return;
      }
      if (!key.ctrl && !key.meta && sequence && sequence >= " " && sequence !== "\u007f") {
        value += sequence;
        out.write("•".repeat(Array.from(sequence).length));
      }
    };
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    input.on("keypress", onKeypress);
    out.write(question);
  });
};

/** Read a secret here, hidden, and write it to the platform store. */
export const storeSecretFromPrompt = async (
  kind: SecretKind,
  account: string,
  question = "Paste API key (input hidden): ",
): Promise<void> => {
  const secret = await promptHidden(question);
  if (!secret) throw new Error("No secret entered");

  if (process.platform === "darwin") {
    assertQuotable(secret);
    // `security -i` reads commands from stdin, so the value is never an argv
    // entry. If batch mode is unavailable, fall back rather than fail: the user
    // has already pasted, and re-pasting into a dialog beats losing the key.
    const batch = await run("security", ["-i"], { input: `${macKeychainAddCommand(KEYCHAIN_SERVICE[kind], account, secret)}\n` });
    if (batch.code === 0) return;
    process.stdout.write("Batch write was refused; paste into the Keychain prompt instead.\n");
    await run("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE[kind], "-a", account, "-w"], { inherit: true });
    return;
  }
  if (process.platform === "linux") {
    try {
      const result = await run("secret-tool", ["store", `--label=NAH ${kind} secret`, ...linuxAttributes(kind), account], { input: secret });
      if (result.code !== 0) throw new Error(`exit ${result.code}`);
    } finally {
      process.stdout.write("\n");
    }
    return;
  }
  if (process.platform === "win32") {
    const path = dpapiPath(kind, account);
    if (!path) throw new Error("LOCALAPPDATA is not set, so there is nowhere to store the key");
    const script = `$p=${JSON.stringify(path)}; $d=Split-Path -Parent $p; New-Item -ItemType Directory -Force -Path $d | Out-Null; $i=[Console]::In.ReadToEnd(); $s=ConvertTo-SecureString $i -AsPlainText -Force; ConvertFrom-SecureString $s | Set-Content -NoNewline -LiteralPath $p`;
    const result = await run("powershell.exe", powershell(script), { input: secret });
    if (result.code !== 0) throw new Error("Windows DPAPI could not save the key");
    return;
  }
  throw new Error(`Secure secret storage is not supported on ${process.platform}`);
};

/** Hand the terminal to the OS so the secret never passes through this process. */
export const storeSecretInteractively = async (
  kind: SecretKind,
  account: string,
  options: { platformMessage?: string } = {},
): Promise<void> => {
  if (process.platform === "darwin") {
    process.stdout.write(options.platformMessage ?? "Paste the secret into the macOS Keychain prompt.\n");
    const result = await run("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE[kind], "-a", account, "-w"], { inherit: true });
    if (result.code !== 0) throw new Error("macOS Keychain did not save the secret");
    return;
  }
  if (process.platform === "linux") {
    const secret = await promptHidden("Paste API key (input hidden): ");
    if (!secret) throw new Error("No API key entered");
    let result: { code: number; stderr: string };
    try {
      result = await run("secret-tool", ["store", `--label=NAH ${kind} secret`, ...linuxAttributes(kind), account], { input: secret });
    } finally {
      process.stdout.write("\n");
    }
    if (result.code !== 0) throw new Error("Linux Secret Service could not store the key; check that a desktop keyring is available");
    return;
  }
  if (process.platform === "win32") {
    const secret = await promptHidden("Paste API key (input hidden): ");
    if (!secret) throw new Error("No API key entered");
    const path = dpapiPath(kind, account);
    if (!path) throw new Error("LOCALAPPDATA is not set, so there is nowhere to store the key");
    const script = `$p=${JSON.stringify(path)}; $d=Split-Path -Parent $p; New-Item -ItemType Directory -Force -Path $d | Out-Null; $i=[Console]::In.ReadToEnd(); $s=ConvertTo-SecureString $i -AsPlainText -Force; ConvertFrom-SecureString $s | Set-Content -NoNewline -LiteralPath $p`;
    const result = await run("powershell.exe", powershell(script), { input: secret });
    if (result.code !== 0) throw new Error("Windows DPAPI could not save the key");
    return;
  }
  throw new Error(`Secure secret storage is not supported on ${process.platform}`);
};

export const removeSecret = async (kind: SecretKind, account: string): Promise<void> => {
  if (process.platform === "darwin") {
    const result = await run("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE[kind], "-a", account]);
    if (result.code !== 0) throw new Error(`No stored key was found for that ${kind === "cogmem" ? "Cognitive Memory" : "provider"} key`);
    return;
  }
  if (process.platform === "linux") {
    const result = await run("secret-tool", ["clear", ...linuxAttributes(kind), account]);
    if (result.code !== 0) throw new Error(`No stored key was found for that ${kind === "cogmem" ? "Cognitive Memory" : "provider"} key`);
    return;
  }
  if (process.platform === "win32") {
    const path = dpapiPath(kind, account);
    if (!path) throw new Error("LOCALAPPDATA is not set, so there is nothing stored");
    const script = `if (Test-Path -LiteralPath ${JSON.stringify(path)}) { Remove-Item -LiteralPath ${JSON.stringify(path)} -Force } else { exit 1 }`;
    const result = await run("powershell.exe", powershell(script));
    if (result.code !== 0) throw new Error(`No stored key was found for that ${kind === "cogmem" ? "Cognitive Memory" : "provider"} key`);
    return;
  }
  throw new Error(`Secure secret storage is not supported on ${process.platform}`);
};

// --- Provider keys, unchanged in behaviour -------------------------------------

export const getStoredProviderKey = async (provider: BuiltinProvider): Promise<string | undefined> =>
  getStoredSecret("provider", provider);

export const storeProviderKey = async (provider: BuiltinProvider): Promise<void> =>
  storeSecretInteractively("provider", provider, {
    platformMessage: "Paste the API key into the macOS Keychain prompt.\n",
  });

export const removeProviderKey = async (provider: BuiltinProvider): Promise<void> =>
  removeSecret("provider", provider);
