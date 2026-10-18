"use strict";

/**
 * Handle GitHub App OAuth callback.
 *
 * After the user installs the GitHub App, GitHub redirects here with a `code`
 * and optionally a state parameter. We exchange the code for an installation
 * token and store it in the github_connections table.
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { githubConnections } from "@/server/db/schema";
import { requireOrganization } from "@/server/session";
import { encryptOrgTokens } from "@/server/crypto/github-token-crypto";

const GITHUB_API = "https://api.github.com";

async function fetchInstallationRepositories(
  accessToken: string,
): Promise<Array<{ id: number; name: string; full_name: string }>> {
  try {
    const resp = await fetch(`${GITHUB_API}/installation/repositories`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!resp.ok) {
      console.error("Failed to fetch installation repositories:", await resp.text());
      return [];
    }

    const data = await resp.json() as {
      repositories: Array<{ id: number; name: string; full_name: string }>;
    };
    return data.repositories ?? [];
  } catch (err) {
    console.error("Error fetching installation repositories:", err);
    return [];
  }
}

export async function GET(request: Request) {
  const viewer = await requireOrganization();
  const orgId = viewer.organizationId;

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code") ?? "";
  const state = searchParams.get("state") ?? "";

  // Verify state parameter (basic CSRF protection)
  let parsedState;
  try {
    parsedState = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
  } catch {
    return new Response(JSON.stringify({ error: "Invalid state parameter" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (parsedState?.orgId !== orgId) {
    return new Response(JSON.stringify({ error: "Organization mismatch" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  // Exchange code for installation token
  const tokenData = await exchangeCodeForToken(code);
  if (!tokenData) {
    return new Response(JSON.stringify({ error: "Failed to exchange code for token" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const installationId = tokenData.installationId ?? 0;

  // Fetch repositories the installation can access
  const repositories = await fetchInstallationRepositories(tokenData.accessToken);

  // Check if there's already a connection for this org
  const db = getDb();
  const [existing] = await db
    .select()
    .from(githubConnections)
    .where(eq(githubConnections.organizationId, orgId))
    .limit(1);

  const encrypted = await encryptOrgTokens({
    accessToken: tokenData.accessToken,
    refreshToken: null,
  });

  if (existing) {
    // Update existing connection
    await db
      .update(githubConnections)
      .set({
        githubInstallationId: String(installationId),
        accessToken: encrypted.encryptedAccessToken,
        refreshToken: encrypted.encryptedRefreshToken,
        tokenExpiresAt: new Date(Date.now() + 55 * 60 * 1000), // ~55 minutes, tokens expire in 1 hour
        selectedRepositories: JSON.stringify(repositories),
        updatedAt: new Date(),
      })
      .where(eq(githubConnections.id, existing.id));
  } else {
    // Create new connection
    await db.insert(githubConnections).values({
      organizationId: orgId,
      githubInstallationId: String(installationId),
      githubAccountId: viewer.userId ?? "",
      accessToken: encrypted.encryptedAccessToken,
      refreshToken: encrypted.encryptedRefreshToken,
      tokenExpiresAt: new Date(Date.now() + 55 * 60 * 1000),
      selectedRepositories: JSON.stringify(repositories),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  revalidatePath("/dashboard/github");

  // Redirect back to the dashboard GitHub page
  return redirect("/dashboard/github");
}

async function exchangeCodeForToken(code: string): Promise<{ accessToken: string; installationId?: number } | null> {
  const clientId = process.env.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret =
    process.env.GITHUB_APP_CLIENT_SECRET?.trim() || process.env.GITHUB_APP_SECRET?.trim();

  if (!clientId || !clientSecret) return null;

  try {
    const resp = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
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