/**
 * Installation token management for GitHub App integrations.
 *
 * Installation tokens are short-lived (1 hour) and scoped to specific
 * repositories. This module handles minting, caching, and rotating them.
 */

import { createHash, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { getDb } from "@/server/db/client";
import { githubConnections } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import { decryptOrgTokens, encryptOrgTokens } from "@/server/crypto/github-token-crypto";

const GITHUB_API = "https://api.github.com";

export interface InstallationTokenResult {
  token: string;
  expiresAt: Date;
  repositories: Array<{ id: number; name: string; full_name: string }>;
  permissions: Record<string, string>;
}

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
  appSlug: string;
}

let cachedConfig: GitHubAppConfig | null = null;

export function getConfig(): GitHubAppConfig {
  if (cachedConfig) return cachedConfig;

  const appId = process.env.GITHUB_APP_ID?.trim();
  const privateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
  let privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.trim();

  // If the env var looks like a file path, read the key from the file
  if (privateKeyPath && (privateKeyPath.endsWith(".pem") || privateKeyPath.endsWith(".key"))) {
    try {
      privateKey = readFileSync(privateKeyPath, "utf8").trim();
    } catch {
      // Fall back to the env var as-is if file read fails
    }
  }

  const clientId = process.env.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret =
    process.env.GITHUB_APP_CLIENT_SECRET?.trim() || process.env.GITHUB_APP_SECRET?.trim();
  const appSlug = process.env.GITHUB_APP_SLUG?.trim();

  if (!appId || !privateKey || !clientId || !clientSecret || !appSlug) {
    throw new Error(
      "GitHub App configuration missing. Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY (or path to .pem file), " +
      "GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, and GITHUB_APP_SLUG. " +
      "See .env.example for variable names."
    );
  }

  cachedConfig = { appId, privateKey, clientId, clientSecret, appSlug };
  return cachedConfig;
}

/**
 * Generate a JWT for GitHub App authentication.
 */
async function generateAppJWT(config: GitHubAppConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60,
    exp: now + 600,
    iss: config.appId,
  };

  const encodedHeader = btoa(JSON.stringify(header)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const encodedPayload = btoa(JSON.stringify(payload)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const unsigned = `${encodedHeader}.${encodedPayload}`;

  // GitHub App private keys are typically PKCS#1 ("BEGIN RSA PRIVATE KEY"),
  // but Web Crypto's importKey("pkcs8") only accepts PKCS#8 DER. Normalize any
  // PEM (PKCS#1 or PKCS#8) into PKCS#8 DER so signing works regardless of format.
  const privateKeyDer = privateKeyToPkcs8Der(config.privateKey);

  const key = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyDer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  return `${unsigned}.${encodedSignature}`;
}

/**
 * Mint a new installation access token from GitHub.
 */
export async function mintInstallationToken(installationId: number): Promise<InstallationTokenResult | null> {
  const config = getConfig();
  const jwt = await generateAppJWT(config);

  try {
    const resp = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!resp.ok) {
      console.error("Failed to mint installation token:", await resp.text());
      return null;
    }

    const data = await resp.json() as {
      token: string;
      expires_at: string;
      repositories: Array<{ id: number; name: string; full_name: string }>;
      permissions: Record<string, string>;
    };

    return {
      token: data.token,
      expiresAt: new Date(data.expires_at),
      repositories: data.repositories,
      permissions: data.permissions,
    };
  } catch (err) {
    console.error("Error minting installation token:", err);
    return null;
  }
}

/**
 * Get a valid installation token for an organization.
 * Returns cached token if still valid, otherwise mints a new one.
 */
export async function getValidInstallationToken(organizationId: string): Promise<InstallationTokenResult | null> {
  const db = getDb();

  const [conn] = await db
    .select()
    .from(githubConnections)
    .where(eq(githubConnections.organizationId, organizationId))
    .limit(1);

  if (!conn || !conn.githubInstallationId) {
    return null;
  }

  const installationId = Number(conn.githubInstallationId);

  // Check if we have a valid cached token (with 5 min buffer)
  if (conn.tokenExpiresAt && conn.accessToken) {
    const expiresAt = new Date(conn.tokenExpiresAt);
    const bufferMs = 5 * 60 * 1000; // 5 minutes
    if (expiresAt.getTime() - Date.now() > bufferMs) {
      // Token is still valid
      try {
        const { accessToken } = await decryptOrgTokens({
          encryptedAccessToken: conn.accessToken,
          encryptedRefreshToken: conn.refreshToken ?? undefined,
        });
        return {
          token: accessToken,
          expiresAt,
          repositories: conn.selectedRepositories ? JSON.parse(conn.selectedRepositories) : [],
          permissions: {},
        };
      } catch {
        // Fall through to mint new token
      }
    }
  }

  // Mint new token
  const tokenResult = await mintInstallationToken(installationId);
  if (!tokenResult) return null;

  // Store encrypted token
  const encrypted = await encryptOrgTokens({
    accessToken: tokenResult.token,
    refreshToken: null, // Installation tokens don't have refresh tokens
  });

  await db
    .update(githubConnections)
    .set({
      accessToken: encrypted.encryptedAccessToken,
      tokenExpiresAt: tokenResult.expiresAt,
      selectedRepositories: JSON.stringify(tokenResult.repositories),
      updatedAt: new Date(),
    })
    .where(eq(githubConnections.id, conn.id));

  return tokenResult;
}

/**
 * List all installations for the GitHub App.
 */
export async function listInstallations(): Promise<Array<{
  id: number;
  account: { login: string; avatar_url: string; type: string };
  repositories: Array<{ id: number; name: string; full_name: string }>;
  permissions: Record<string, string>;
}>> {
  const config = getConfig();
  const jwt = await generateAppJWT(config);

  try {
    const resp = await fetch(`${GITHUB_API}/app/installations`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!resp.ok) return [];
    return (await resp.json()) as Array<{
      id: number;
      account: { login: string; avatar_url: string; type: string };
      repositories: Array<{ id: number; name: string; full_name: string }>;
      permissions: Record<string, string>;
    }>;
  } catch {
    return [];
  }
}

/**
 * Get repositories accessible by an installation.
 */
export async function getInstallationRepositories(installationId: number): Promise<Array<{
  id: number;
  name: string;
  full_name: string;
  private: boolean;
}>> {
  const config = getConfig();
  const jwt = await generateAppJWT(config);

  try {
    const resp = await fetch(`${GITHUB_API}/installation/repositories`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!resp.ok) return [];
    const data = await resp.json() as { repositories: Array<{ id: number; name: string; full_name: string; private: boolean }> };
    return data.repositories;
  } catch {
    return [];
  }
}

/**
 * Verify a GitHub webhook signature.
 */
export async function verifyWebhookSignature(payload: string, signature: string): Promise<boolean> {
  const webhookSecret = process.env.GITHUB_APP_WEBHOOK_SECRET?.trim();
  if (!webhookSecret) return false;

  const expected = "sha256=" + createHash("sha256").update(payload).digest("hex");
  return signature === expected;
}

/**
 * Exchange an OAuth code for a user access token (for the initial install flow).
 */
export async function exchangeCodeForToken(code: string): Promise<{ accessToken: string; installationId?: number } | null> {
  const config = getConfig();

  try {
    const resp = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
      }),
    });

    if (!resp.ok) {
      console.error("Token exchange failed:", await resp.text());
      return null;
    }

    const data = await resp.json() as { access_token: string; installation_id?: number };
    return {
      accessToken: data.access_token,
      installationId: data.installation_id,
    };
  } catch (err) {
    console.error("Error exchanging code for token:", err);
    return null;
  }
}

/**
 * Convert a PEM private key (PKCS#1 or PKCS#8) into PKCS#8 DER bytes.
 *
 * GitHub App private keys are usually PKCS#1 ("BEGIN RSA PRIVATE KEY"), but
 * Web Crypto's importKey("pkcs8") only accepts PKCS#8 DER. Node's
 * createPrivateKey normalizes any PEM into a key object whose export() yields
 * PKCS#8 DER, so we can sign with Web Crypto regardless of the input format.
 */
function privateKeyToPkcs8Der(pem: string): ArrayBuffer {
  const key = createPrivateKey(pem);
  const der = key.export({ type: "pkcs8", format: "der" }) as Uint8Array;
  return new Uint8Array(der).buffer;
}