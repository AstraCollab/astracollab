"use server";

/**
 * GitHub webhook endpoint for receiving installation events.
 *
 * This receives events from GitHub when repositories are added/removed from
 * an installation, or when the app is installed/uninstalled.
 *
 * Webhook payload verification uses the X-Hub-Signature-256 header with the
 * GITHUB_APP_WEBHOOK_SECRET.
 *
 * See: https://docs.github.com/en/webhooks/working-with-webhooks/validating-webhook-signatures
 */

import { headers } from "next/headers";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getDb } from "@/server/db/client";
import { githubConnections } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import { mintInstallationToken } from "@/server/github/installation-tokens";
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

export async function POST(req: Request) {
  const headersList = await headers();
  const signature = headersList.get("x-hub-signature-256") ?? "";
  const eventType = headersList.get("x-github-event") ?? "push";
  const deliveryId = headersList.get("x-github-delivery") ?? "";

  // Read raw body for signature verification
  const body = await req.text();

  // Verify signature
  if (!verifySignature(body, signature)) {
    console.error("Invalid webhook signature", { deliveryId });
    return new Response("Forbidden", { status: 403 });
  }

  // Parse payload
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  // Log event for debugging
  console.log("GitHub webhook received", { eventType, deliveryId });

  // Handle installation events
  if (eventType === "installation") {
    const event = payload as { action: string; installation: { id: number }; repository?: { name: string } };
    await handleInstallationEvent(event);
  }

  // Handle repository addition/removal
  if (eventType === "repository") {
    const event = payload as { action: string; installation: { id: number }; repository: { name: string } };
    await handleRepositoryEvent(event);
  }

  return new Response("OK", { status: 200 });
}

export async function GET() {
  // Webhook subscriptions can verify by making a GET request
  // GitHub will append ?challenge=<random-string>
  const url = new URL(new Request("").url);
  const challenge = url.searchParams.get("challenge") ?? "";

  if (challenge) {
    return new Response(challenge, { status: 200 });
  }

  return new Response("Webhook endpoint", { status: 200 });
}

function verifySignature(payload: string, signature: string): boolean {
  const webhookSecret = process.env.GITHUB_APP_WEBHOOK_SECRET?.trim();

  if (!webhookSecret) {
    console.error(
      "GITHUB_APP_WEBHOOK_SECRET is not set. Set it to the \"Webhook secret\" " +
      "value from your GitHub App settings (github.com → App settings → Webhooks)."
    );
    return false;
  }

  if (!signature.startsWith("sha256=")) {
    console.error("Missing or malformed X-Hub-Signature-256 header");
    return false;
  }

  const expected =
    "sha256=" +
    createHmac("sha256", webhookSecret).update(payload).digest("hex");

  // Timing-safe comparison with length guard (timingSafeEqual throws on
  // length mismatch, so guard first to return false instead of crashing)
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== signatureBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, signatureBuffer);
}

async function handleInstallationEvent(event: { action: string; installation: { id: number }; repository?: { name: string } }) {
  console.log("GitHub installation event", { action: event.action, installationId: event.installation.id });

  const db = getDb();
  const installationId = String(event.installation.id);

  // Handle installation added (app installed or new repo added)
  if (event.action === "created" || event.action === "added") {
    // Find the connection for this installation
    const [conn] = await db
      .select()
      .from(githubConnections)
      .where(eq(githubConnections.githubInstallationId, installationId))
      .limit(1);

    if (conn) {
      // Mint new token and update repositories
      const tokenResult = await mintInstallationToken(event.installation.id);
      if (tokenResult) {
        const repositories = await fetchInstallationRepositories(tokenResult.token);
        const encrypted = await encryptOrgTokens({
          accessToken: tokenResult.token,
          refreshToken: null,
        });

        await db
          .update(githubConnections)
          .set({
            accessToken: encrypted.encryptedAccessToken,
            refreshToken: encrypted.encryptedRefreshToken,
            tokenExpiresAt: tokenResult.expiresAt,
            selectedRepositories: JSON.stringify(repositories),
            updatedAt: new Date(),
          })
          .where(eq(githubConnections.id, conn.id));

        console.log("Updated installation repositories", { installationId, repoCount: repositories.length });
      }
    } else {
      console.log("No connection found for installation", { installationId });
    }
  }

  // Handle installation deleted (app uninstalled or all repos removed)
  if (event.action === "deleted" || event.action === "removed") {
    // Mark connection as disconnected by clearing the installation ID
    await db
      .update(githubConnections)
      .set({
        githubInstallationId: "0",
        accessToken: "",
        refreshToken: null,
        tokenExpiresAt: null,
        selectedRepositories: null,
        updatedAt: new Date(),
      })
      .where(eq(githubConnections.githubInstallationId, installationId));

    console.log("Marked installation as disconnected", { installationId });
  }
}

async function handleRepositoryEvent(event: { action: string; installation: { id: number }; repository: { name: string } }) {
  console.log("GitHub repository event", { action: event.action, repository: event.repository.name });

  const db = getDb();
  const installationId = String(event.installation.id);

  const [conn] = await db
    .select()
    .from(githubConnections)
    .where(eq(githubConnections.githubInstallationId, installationId))
    .limit(1);

  if (conn) {
    // Re-fetch all repositories for this installation
    const tokenResult = await mintInstallationToken(event.installation.id);
    if (tokenResult) {
      const repositories = await fetchInstallationRepositories(tokenResult.token);
      const encrypted = await encryptOrgTokens({
        accessToken: tokenResult.token,
        refreshToken: null,
      });

      await db
        .update(githubConnections)
        .set({
          accessToken: encrypted.encryptedAccessToken,
          refreshToken: encrypted.encryptedRefreshToken,
          tokenExpiresAt: tokenResult.expiresAt,
          selectedRepositories: JSON.stringify(repositories),
          updatedAt: new Date(),
        })
        .where(eq(githubConnections.id, conn.id));

      console.log("Updated installation repositories from repo event", { installationId, repoCount: repositories.length });
    }
  }
}