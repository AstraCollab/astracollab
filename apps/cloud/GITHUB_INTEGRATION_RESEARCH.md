# GitHub OAuth Integration Research for Nah Cloud

## Executive Summary

This document outlines a production-ready GitHub OAuth integration for Nah Cloud that allows users to:
1. Sign in with their GitHub accounts
2. Connect their GitHub repositories to agents
3. Enable GitHub-based authentication for agent operations
4. Maintain security best practices and organizational scoping

## Current Architecture Analysis

### Authentication System
- Uses **Better Auth** (v1.7.7) as the authentication provider
- Session-based authentication with organization scoping
- Custom `getViewer` and `requireOrganization` functions for tenancy
- Database schema includes `user`, `account`, `organization`, and `member` tables from Better Auth
- Sign-in/Sign-up handled via `/app/api/auth/[...all]/route.ts` (Better Auth catch-all)

### Key Components
- **Better Auth setup**: `src/server/auth/better-auth.ts`
- **Session management**: `src/server/session.ts` 
- **Database schema**: `src/server/db/schema.ts` + `auth-tables.ts`
- **Auth routes**: `src/app/api/auth/[...all]/route.ts`
- **Client auth**: `src/lib/auth-client.ts`
- **Auth forms**: `src/components/auth-form.tsx`

## GitHub OAuth Integration Options

### Option 1: Better Auth Built-in GitHub Provider (Recommended)
Better Auth has native OAuth provider support including GitHub.

**Pros:**
- Minimal code changes
- Handles OAuth flow, token storage, and refresh automatically
- Integrates seamlessly with existing session/organization model
- Supports both authentication and account linking
- Built-in security features (PKCE, state validation)

**Cons:**
- Less customization over OAuth flow
- Dependence on Better Auth's implementation

### Option 2: Manual GitHub OAuth Implementation
Implement GitHub OAuth flow manually using `@octokit/rest` or direct API calls.

**Pros:**
- Full control over OAuth flow and scopes
- Custom token handling and storage
- Direct access to GitHub API for advanced features

**Cons:**
- Significant development effort
- Manual handling of security concerns (CSRF, token storage, refresh)
- More surface area for bugs
- Duplicates functionality Better Auth already provides

### Option 3: Hybrid Approach
Use Better Auth for core GitHub OAuth, then extend with custom GitHub API functionality.

**Recommended Approach: Option 1** - Leveraging Better Auth's built-in GitHub provider offers the best balance of security, development speed, and maintainability.

## Implementation Plan

### Phase 1: Core GitHub OAuth Integration

#### 1. Environment Configuration
Add required environment variables:
```env
# .env.local
GITHUB_CLIENT_ID=your_github_oauth_app_client_id
GITHUB_CLIENT_SECRET=your_github_oauth_app_client_secret
```

#### 2. Better Auth Configuration Update
Modify `src/server/auth/better-auth.ts` to add GitHub provider:

```typescript
import { github } from "better-auth/plugins"

// In the createAuth() function plugins array:
plugins: [
  // ... existing plugins ...
  github({
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    // Optional: Request specific scopes
    // scope: ["user:email", "read:org", "repo"]
  })
]
```

#### 3. Database Migration
Better Auth automatically handles account table updates for OAuth providers. No schema changes needed.

#### 4. UI Updates
Update `src/components/auth-form.tsx` to add GitHub sign-in button:

```typescript
// Add to AuthForm component
<div className="space-y-4">
  {/* ... existing email/password form ... */}
  
  <div className="text-center">
    <p className="text-[var(--ink-muted)]">Or continue with</p>
    <div className="flex justify-center space-x-3 mt-3">
      <Button
        variant="outline"
        onClick={() => authClient.signIn.github()}
        className="w-[180px] flex items-center justify-center gap-2"
      >
        <img 
          src="https://github.com/fluidicon.png" 
          alt="GitHub" 
          className="w-4 h-4"
        />
        Sign in with GitHub
      </Button>
    </div>
  </div>
</div>
```

### Phase 2: Repository Connection Feature

#### 1. Database Schema Extension
Add GitHub connection tracking to organizations or agents:

```typescript
// In src/server/db/schema.ts
export const githubConnections = table(
  "github_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    githubInstallationId: text("github_installation_id").notNull().unique(),
    githubAccountId: text("github_account_id").notNull(),
    accessToken: text("access_token").notNull(), // Encrypted at rest
    refreshToken: text("refresh_token"),
    tokenExpiresAt: timestamp("token_expires_at"),
    selectedRepositories: text("selected_repositories"), // JSON array
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .notNull()
  },
  (t) => [
    index("github_connections_org_idx").on(t.organizationId)
  ]
)
```

#### 2. GitHub App vs OAuth App Decision
For repository access (beyond just authentication), consider GitHub App approach:

**GitHub App Benefits:**
- Fine-grained repository permissions
- Per-repository installation (users control which repos to connect)
- Short-lived tokens (better security)
- Can act as itself (for background operations) or on behalf of user
- Higher rate limits

**Implementation:** Would require registering a GitHub App instead of OAuth App and using the `@octokit/app` SDK.

#### 3. Repository Selection UI
Create new dashboard page for connecting GitHub repositories:
- `/app/dashboard/github/page.tsx`
- Shows connected organizations/repos
- Allows selecting specific repositories for agent access
- Manages installation permissions

### Phase 3: Agent-GitHub Integration

#### 1. Agent Configuration Extension
Extend `AgentConfig` interface to include GitHub-specific settings:

```typescript
export interface AgentConfig {
  readonly model?: string
  readonly env?: Readonly<Record<string, string>>
  readonly cpu?: number
  readonly memoryMb?: number
  readonly timeoutMs?: number
  readonly noEnv?: boolean
  // GitHub-specific
  readonly githubRepository?: string // format: "owner/repo"
  readonly githubBranch?: string
  readonly githubAccessLevel?: "read" | "write" | "admin"
}
```

#### 2. Agent Runtime Enhancement
Modify agent launcher to provide GitHub credentials:
- Fetch GitHub token from user's organization connection
- Make available as environment variable or via injected SDK
- Scope to specific repository if configured

#### 3. Security Considerations
- Encrypt GitHub tokens at rest using application-level encryption
- Implement token refresh handling
- Scope tokens to minimum required permissions
- Audit GitHub API usage per organization
- Implement webhook secret validation for incoming GitHub events

## Production Considerations

### Security
1. **Token Storage**: Encrypt GitHub tokens at rest using AES-256-GCM or similar
2. **Scope Minimization**: Request only necessary GitHub scopes:
   - For authentication: `read:user`, `user:email`
   - For repository access: `repo` (specific repos) or `public_repo`
3. **Rate Limiting**: Implement application-level rate limiting for GitHub API calls
4. **Webhook Security**: Validate incoming GitHub webhooks with secret signatures
5. **Session Security**: Ensure GitHub OAuth flow uses PKCE and state parameters

### Scalability
1. **Database Indexes**: Add indexes on `github_connections` table for organization lookups
2. **Caching**: Cache GitHub API responses where appropriate (repository metadata, etc.)
3. **Background Jobs**: Use queues for long-running GitHub operations (cloning, large fetches)
4. **Monitoring**: Track GitHub API usage, errors, and rate limit approaches

### Compliance & Audit
1. **Audit Logging**: Log all GitHub API calls made on behalf of users
2. **Data Export**: Provide ability to export/delete GitHub connection data
3. **Privacy**: Clearly disclose what GitHub data is accessed and stored
4. **Compliance**: Ensure implementation meets SOC 2, GDPR requirements if applicable

## Testing Strategy

### Unit Tests
- Better Auth GitHub provider configuration
- GitHub connection creation/deletion
- Agent configuration validation with GitHub fields

### Integration Tests
- End-to-end GitHub OAuth flow
- Repository connection and selection
- Agent runtime with GitHub credentials
- Token refresh scenarios

### Manual Testing
1. Test GitHub OAuth flow with test GitHub account
2. Verify organization scoping (users can only see their org's connections)
3. Test agent operations with GitHub access
4. Verify token expiration and refresh handling
5. Test error cases (network failure, invalid credentials, rate limiting)

## Deployment Checklist

### Pre-deployment
1. [ ] Register GitHub OAuth App (or GitHub App) in GitHub Developer Settings
2. [ ] Configure redirect URLs: `https://your-domain.com/api/auth/callback/github`
3. [ ] Set environment variables in all environments (staging/production)
4. [ ] Run database migrations for new tables
5. [ ] Update privacy policy and terms of service
6. [ ] Implement monitoring alerts for GitHub API errors/rate limits

### Post-deployment
1. [ ] Monitor authentication success/failure rates
2. [ ] Track GitHub API usage patterns
3. [ ] Verify token encryption at rest
4. [ ] Test backup/restore procedures include GitHub connection data
5. [ ] Conduct security review of implementation

## Alternative: GitHub App Approach

If deeper GitHub integration is needed (webhooks, background operations, marketplace listing), consider GitHub App:

### Changes Required
1. Register GitHub App instead of OAuth App
2. Use `@octokit/app` SDK for JWT authentication
3. Implement webhook endpoint for GitHub events
4. Add installation tracking and permission management
5. Handle repository selection during installation flow

### Benefits
- Better for automated agent operations (can act as itself)
- Granular repository permissions per installation
- Appears in GitHub Marketplace (if desired)
- Higher API rate limits
- No user-facing OAuth consent for each repo access

## Recommendation

**Start with Better Auth GitHub Provider** for user authentication and basic profile access. This provides:
- Fastest time to value
- Least implementation risk
- Seamless integration with existing auth system
- Production-ready security foundations

**Evolve to GitHub App** if needing:
- Background agent operations without user context
- Webhook integration for real-time repo events
- Marketplace distribution
- Advanced repository permissions control

This approach allows iterative improvement while delivering immediate value.