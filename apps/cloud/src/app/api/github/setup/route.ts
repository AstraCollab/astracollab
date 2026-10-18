"use strict";

/**
 * GitHub App Setup URL callback.
 *
 * After the user installs the GitHub App, GitHub redirects to this URL
 * with an `installation_id` parameter. We exchange this for an installation
 * token and store the connection.
 *
 * This is the "Setup URL" configured in the GitHub App settings.
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { githubConnections } from "@/server/db/schema";
import { requireOrganization } from "@/server/session";
import { encryptOrgTokens } from "@/server/crypto/github-token-crypto";
import { getConfig, mintInstallationToken } from "@/server/github/installation-tokens";

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
  const installationId = searchParams.get("installation_id");
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

  if (!installationId) {
    return new Response(JSON.stringify({ error: "Missing installation_id" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const installationIdNum = Number(installationId);
  if (isNaN(installationIdNum)) {
    return new Response(JSON.stringify({ error: "Invalid installation_id" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  // Mint installation token using the installation ID
  const tokenResult = await mintInstallationToken(installationIdNum);
  if (!tokenResult) {
    return new Response(JSON.stringify({ error: "Failed to mint installation token" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  // Fetch repositories the installation can access
  const repositories = await fetchInstallationRepositories(tokenResult.token);

  // Check if there's already a connection for this org
  const db = getDb();
  const [existing] = await db
    .select()
    .from(githubConnections)
    .where(eq(githubConnections.organizationId, orgId))
    .limit(1);

  const encrypted = await encryptOrgTokens({
    accessToken: tokenResult.token,
    refreshToken: null,
  });

  if (existing) {
    // Update existing connection
    await db
      .update(githubConnections)
      .set({
        githubInstallationId: String(installationIdNum),
        accessToken: encrypted.encryptedAccessToken,
        refreshToken: encrypted.encryptedRefreshToken,
        tokenExpiresAt: tokenResult.expiresAt,
        selectedRepositories: JSON.stringify(repositories),
        updatedAt: new Date(),
      })
      .where(eq(githubConnections.id, existing.id));
  } else {
    // Create new connection
    await db.insert(githubConnections).values({
      organizationId: orgId,
      githubInstallationId: String(installationIdNum),
      githubAccountId: viewer.userId ?? "",
      accessToken: encrypted.encryptedAccessToken,
      refreshToken: encrypted.encryptedRefreshToken,
      tokenExpiresAt: tokenResult.expiresAt,
      selectedRepositories: JSON.stringify(repositories),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  revalidatePath("/dashboard/github");

  // Redirect back to the dashboard GitHub page
  return redirect("/dashboard/github");
}