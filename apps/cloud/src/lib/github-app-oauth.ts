"use strict";

/**
 * GitHub App OAuth provider for Better Auth genericOAuth.
 *
 * This implements the GitHub App installation flow:
 * 1. User initiates installation via /api/github/install
 * 2. GitHub redirects to callback with installation_id
 * 3. We exchange the code for an installation access token
 * 4. Store the installation_id and tokens for the organization
 *
 * See: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
 */

import { createHash, createPrivateKey } from "node:crypto";
import { randomBytes } from "node:crypto";

export interface GithubAppOAuthOptions {
  clientId: string;
  clientSecret: string;
  appId: string;
  privateKey: string;
  webhookSecret: string;
  scopes?: string[];
  redirectURI?: string;
}

export interface GitHubAppProfile {
  id: number;
  login: string;
  avatar_url: string;
  name?: string;
  email?: string | null;
  type: "User" | "Organization";
}

export interface GitHubInstallation {
  id: number;
  account: GitHubAppProfile;
  repositories: Array<{ id: number; name: string; full_name: string }>;
  permissions: Record<string, string>;
  events: string[];
}

export interface GitHubInstallationToken {
  token: string;
  expires_at: string;
  repositories: Array<{ id: number; name: string; full_name: string }>;
  permissions: Record<string, string>;
}

const GITHUB_API = "https://api.github.com";

function githubApp(options: GithubAppOAuthOptions) {
  const { clientId, clientSecret, appId, privateKey, webhookSecret, scopes, redirectURI } = options;

  if (!clientId || !clientSecret || !appId || !privateKey || !webhookSecret) {
    throw new Error(
      "GitHub App OAuth requires clientId, clientSecret, appId, privateKey, and webhookSecret. " +
      "Check GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_WEBHOOK_SECRET."
    );
  }

  const defaultScopes = ["repo", "read:org", "read:user", "user:email"];

  /**
   * Generate a JWT for GitHub App authentication.
   * See: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
   */
  async function generateAppJWT(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const payload = {
      iat: now - 60,
      exp: now + 600,
      iss: appId,
    };

    const encodedHeader = btoa(JSON.stringify(header)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const encodedPayload = btoa(JSON.stringify(payload)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const unsigned = `${encodedHeader}.${encodedPayload}`;

    const key = await crypto.subtle.importKey(
      "pkcs8",
      privateKeyToPkcs8Der(privateKey),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
    const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

    return `${unsigned}.${encodedSignature}`;
  }

  /**
   * Get an installation access token for a given installation ID.
   * See: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
   */
  async function getInstallationToken(installationId: number): Promise<GitHubInstallationToken | null> {
    try {
      const jwt = await generateAppJWT();
      const resp = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });

      if (!resp.ok) {
        console.error("Failed to get installation token:", await resp.text());
        return null;
      }

      return (await resp.json()) as GitHubInstallationToken;
    } catch (err) {
      console.error("Error getting installation token:", err);
      return null;
    }
  }

  /**
   * Get the GitHub App installation for the current user/organization.
   */
  async function getInstallations(jwt: string): Promise<GitHubInstallation[]> {
    try {
      const resp = await fetch(`${GITHUB_API}/app/installations`, {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });

      if (!resp.ok) return [];
      return (await resp.json()) as GitHubInstallation[];
    } catch {
      return [];
    }
  }

  /**
   * Get user info using an installation token.
   */
  const getUserInfo = async (tokens: { accessToken?: string; installationId?: number }): Promise<{
    id?: string | number | null;
    name?: string | undefined;
    email?: string | null;
    image?: string | undefined;
    emailVerified: boolean;
    installationId?: number;
  } | null> => {
    if (!tokens.accessToken && !tokens.installationId) return null;

    let accessToken = tokens.accessToken;
    const installationId = tokens.installationId;

    // If we only have installationId, get a fresh token
    if (!accessToken && installationId) {
      const tokenData = await getInstallationToken(installationId);
      if (!tokenData) return null;
      accessToken = tokenData.token;
    }

    if (!accessToken) return null;

    try {
      const resp = await fetch(`${GITHUB_API}/user`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!resp.ok) return null;
      const profile = await resp.json() as GitHubAppProfile;

      // Get primary email
      let primaryEmail: string | null = profile.email ?? null;
      let emailVerified = false;

      if (!primaryEmail) {
        const emailResp = await fetch(`${GITHUB_API}/user/emails`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (emailResp.ok) {
          const emails = await emailResp.json() as Array<{ email: string; primary: boolean; verified: boolean }>;
          const primaryVerified = emails.find(e => e.primary && e.verified);
          if (primaryVerified) {
            primaryEmail = primaryVerified.email;
            emailVerified = true;
          } else if (emails[0]) {
            primaryEmail = emails[0].email;
            emailVerified = emails[0].verified;
          }
        }
      } else {
        emailVerified = true;
      }

      if (!profile.id) return null;

      return {
        id: profile.id.toString(),
        name: profile.name ?? undefined,
        email: primaryEmail ?? undefined,
        image: profile.avatar_url ?? undefined,
        emailVerified,
        installationId,
      };
    } catch {
      return null;
    }
  };

  return {
    providerId: "github-app",
    authorizationUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userInfoUrl: `${GITHUB_API}/user`,
    clientId,
    clientSecret,
    scopes: scopes ?? defaultScopes,
    redirectURI,
    getUserInfo,
    // GitHub App specific methods
    generateAppJWT,
    getInstallationToken,
    getInstallations,
    // Webhook verification
    verifyWebhookSignature(payload: string, signature: string): boolean {
      const expected = "sha256=" + createHash("sha256").update(payload).digest("hex");
      return signature === expected;
    },
  };
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

export { githubApp };