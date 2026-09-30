import { spawn } from "node:child_process";
import * as readline from "node:readline";
import * as nodePath from "node:path";

export type BuiltinProvider = "anthropic" | "openai" | "openrouter";

const keychainService = "com.astracollab.nah.provider";
const linuxAttributes = ["service", "astracollab-nah", "provider"];

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

export const getStoredProviderKey = async (provider: BuiltinProvider): Promise<string | undefined> => {
  try {
    if (process.platform === "darwin") {
      const result = await run("security", ["find-generic-password", "-s", keychainService, "-a", provider, "-w"]);
      return result.code === 0 ? result.stdout.replace(/[\r\n]+$/, "") || undefined : undefined;
    }
    if (process.platform === "linux") {
      const result = await run("secret-tool", ["lookup", ...linuxAttributes, provider]);
      return result.code === 0 ? result.stdout.replace(/[\r\n]+$/, "") || undefined : undefined;
    }
    if (process.platform === "win32") {
      const dir = process.env.LOCALAPPDATA ? nodePath.join(process.env.LOCALAPPDATA, "NAH", "providers") : "";
      if (!dir) return undefined;
      const path = nodePath.join(dir, `${provider}.dpapi`);
      const script = `$p=${JSON.stringify(path)}; if (Test-Path -LiteralPath $p) { $s=Get-Content -Raw -LiteralPath $p | ConvertTo-SecureString; $c=New-Object System.Net.NetworkCredential('', $s); [Console]::Out.Write($c.Password) }`;
      const result = await run("powershell.exe", powershell(script));
      return result.code === 0 ? result.stdout || undefined : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const promptHidden = (): Promise<string | undefined> => {
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
    out.write("Paste API key (input hidden): ");
  });
};

export const storeProviderKey = async (provider: BuiltinProvider): Promise<void> => {
  if (process.platform === "darwin") {
    process.stdout.write("Paste the API key into the macOS Keychain prompt.\n");
    const result = await run("security", ["add-generic-password", "-U", "-s", keychainService, "-a", provider, "-w"], { inherit: true });
    if (result.code !== 0) throw new Error("macOS Keychain did not save the provider key");
    return;
  }
  if (process.platform === "linux") {
    const secret = await promptHidden();
    if (!secret) throw new Error("No API key entered");
    let result: { code: number; stderr: string };
    try {
      result = await run("secret-tool", ["store", "--label=NAH provider API key", ...linuxAttributes, provider], { input: secret });
    } finally {
      process.stdout.write("\n");
    }
    if (result.code !== 0) throw new Error("Linux Secret Service could not store the key; check that a desktop keyring is available");
    return;
  }
  if (process.platform === "win32") {
    const secret = await promptHidden();
    if (!secret) throw new Error("No API key entered");
    const dir = nodePath.join(process.env.LOCALAPPDATA ?? "", "NAH", "providers");
    const path = nodePath.join(dir, `${provider}.dpapi`);
    const script = `$p=${JSON.stringify(path)}; $d=Split-Path -Parent $p; New-Item -ItemType Directory -Force -Path $d | Out-Null; $i=[Console]::In.ReadToEnd(); $s=ConvertTo-SecureString $i -AsPlainText -Force; ConvertFrom-SecureString $s | Set-Content -NoNewline -LiteralPath $p`;
    const result = await run("powershell.exe", powershell(script), { input: secret });
    if (result.code !== 0) throw new Error("Windows DPAPI could not save the provider key");
    return;
  }
  throw new Error(`Secure provider key storage is not supported on ${process.platform}`);
};

export const removeProviderKey = async (provider: BuiltinProvider): Promise<void> => {
  if (process.platform === "darwin") {
    const result = await run("security", ["delete-generic-password", "-s", keychainService, "-a", provider]);
    if (result.code !== 0) throw new Error("No stored key was found for that provider");
    return;
  }
  if (process.platform === "linux") {
    const result = await run("secret-tool", ["clear", ...linuxAttributes, provider]);
    if (result.code !== 0) throw new Error("No stored key was found for that provider");
    return;
  }
  if (process.platform === "win32") {
    const path = nodePath.join(process.env.LOCALAPPDATA ?? "", "NAH", "providers", `${provider}.dpapi`);
    const script = `if (Test-Path -LiteralPath ${JSON.stringify(path)}) { Remove-Item -LiteralPath ${JSON.stringify(path)} -Force } else { exit 1 }`;
    const result = await run("powershell.exe", powershell(script));
    if (result.code !== 0) throw new Error("No stored key was found for that provider");
    return;
  }
  throw new Error(`Secure provider key storage is not supported on ${process.platform}`);
};
