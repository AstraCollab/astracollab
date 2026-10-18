"use strict";

/**
 * Initiate GitHub App installation.
 *
 * This redirects the user to the GitHub App installation page.
 * After installation, GitHub redirects to the Setup URL configured in the
 * GitHub App settings with an `installation_id` parameter.
 * The Setup URL should point to /api/github/setup.
 */

import { redirect } from "next/navigation";
import { requireOrganization } from "@/server/session";
import { getConfig } from "@/server/github/installation-tokens";

export async function GET() {
  const viewer = await requireOrganization();
  const orgId = viewer.organizationId;

  const config = getConfig();
  const appSlug = config.appSlug;

  if (!appSlug) {
    return new Response(
      JSON.stringify({ error: "GitHub App not configured: GITHUB_APP_SLUG is missing" }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  // State parameter to prevent CSRF and carry organization ID
  const state = Buffer.from(JSON.stringify({ orgId, ts: Date.now() })).toString("base64url");

  // GitHub App installation URL — redirects the user to install the app.
  // After installation, GitHub redirects to the "Setup URL" configured in the
  // GitHub App settings on github.com. That Setup URL MUST point to
  // /api/github/setup on your live domain, otherwise GitHub falls back to the
  // app's settings page.
  //
  // The `setup_action=install` parameter tells GitHub to redirect to the
  // Setup URL (instead of leaving the user on GitHub). The `state` parameter
  // is echoed back to the Setup URL for CSRF verification.
  const params = new URLSearchParams({
    setup_action: "install",
    state,
  });

  const url = `https://github.com/apps/${appSlug}/installations/new?${params.toString()}`;
  redirect(url);
}