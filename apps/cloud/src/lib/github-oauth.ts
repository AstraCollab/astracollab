"use strict";

/** GitHub OAuth provider options. */
export interface GithubOAuthOptions {
  clientId: string | undefined;
  clientSecret: string | undefined;
  scopes?: string[];
  redirectURI?: string;
}

/** GitHub user profile response. */
interface GitHubProfile {
  id: number;
  login: string;
  avatar_url: string;
  name?: string;
  email?: string | null;
}

/** GitHub email response. */
interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

/**
 * GitHub OAuth provider helper for Better Auth genericOAuth.
 *
 * GitHub OAuth endpoints:
 *   - Authorize:  https://github.com/login/oauth/authorize
 *   - Token:      https://github.com/login/oauth/access_token
 *   - User info:  https://api.github.com/user
 *
 * See: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
 */
function github(options: GithubOAuthOptions) {
  const { clientId, clientSecret, scopes, redirectURI } = options;

  if (!clientId || !clientSecret) {
    throw new Error(
      "GitHub OAuth clientId and clientSecret must be defined. " +
        "Check GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET environment variables."
    );
  }

  const defaultScopes = ["read:user", "user:email"];

  const getUserInfo = async (tokens: {
    accessToken?: string;
  }): Promise<{
    id?: string | number | null;
    name?: string | undefined;
    email?: string | null;
    image?: string | undefined;
    emailVerified: boolean;
  } | null> => {
    if (!tokens.accessToken) return null;

    let profile: GitHubProfile;
    try {
      const resp = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${tokens.accessToken}` }
      });
      if (!resp.ok) return null;
      profile = await resp.json();
    } catch {
      return null;
    }

    // GitHub returns email=null when the profile email is private; fetch emails as fallback.
    // https://docs.github.com/en/rest/users/emails lists the available endpoints/scopes.
    let primaryEmail: string | null = profile.email ?? null;
    let emailVerified: boolean = false;

    if (primaryEmail !== null) {
      // Profile email is public and verified
      emailVerified = true;
    } else if (!primaryEmail) {
      // Try to get email from the emails endpoint
      try {
        const emailResp = await fetch("https://api.github.com/user/emails", {
          headers: { Authorization: `Bearer ${tokens.accessToken}` }
        });
        if (emailResp.ok) {
          const emails: GitHubEmail[] = await emailResp.json();
          // Find primary verified email
          const primaryVerified = emails.find(e => e.primary && e.verified);
          if (primaryVerified) {
            primaryEmail = primaryVerified.email;
            emailVerified = true;
          } else {
            // Fallback to first email if no primary verified
            const firstEmail = emails[0];
            if (firstEmail) {
              primaryEmail = firstEmail.email;
              emailVerified = firstEmail.verified;
            }
          }
        }
      } catch {
        // keep primaryEmail null, emailVerified false
      }
    }

    // Return null if we can't get a stable subject identifier
    if (!profile.id) return null;

    // Better Auth expects email to be a string, not null
    const email = primaryEmail ?? undefined;

    return {
      id: profile.id.toString(),
      name: profile.name ?? undefined,
      email,
      image: profile.avatar_url ?? undefined,
      emailVerified
    };
  };

  return {
    providerId: "github",
    authorizationUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userInfoUrl: "https://api.github.com/user",
    clientId,
    clientSecret,
    scopes: scopes ?? defaultScopes,
    redirectURI,
    getUserInfo
  };
}

export { github };