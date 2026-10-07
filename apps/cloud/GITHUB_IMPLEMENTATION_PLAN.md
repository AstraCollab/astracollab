# GitHub OAuth Implementation Plan for Nah Cloud

## Immediate Next Steps (Week 1)

### 1. Environment Setup
```bash
# Add to .env files
echo "GITHUB_CLIENT_ID=your_client_id_here" >> .env.local
echo "GITHUB_CLIENT_SECRET=your_client_secret_here" >> .env.local
```

### 2. Better Auth Configuration
Edit `src/server/auth/better-auth.ts`:

```typescript
import { github } from "better-auth/plugins"
// ... other imports ...

return betterAuth({
  // ... existing config ...
  plugins: [
    // ... existing plugins ...
    github({
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      // Optional scopes - start with minimal
      scope: ["read:user", "user:email"]
    })
  ]
})
```

### 3. UI Updates
Edit `src/components/auth-form.tsx`:

```typescript
// Add inside the form, after email/password fields but before submit button
{/* GitHub Sign-in Button */}
<div className="space-y-4">
  <p className="text-[var(--ink-muted)] text-center">Or continue with</p>
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
```

### 4. Testing
1. Register GitHub OAuth App at https://github.com/settings/developers
2. Set callback URL to: `http://localhost:3000/api/auth/callback/github`
3. Test login flow with test GitHub account
4. Verify user appears in database with GitHub account linked

## Week 2: Repository Connection Feature

### 1. Database Migration
Create migration script for github_connections table (see research doc for schema)

### 2. GitHub Connection Service
Create `src/server/services/github.ts`:
```typescript
import { getAuth } from "@/server/auth/better-auth"
import { getDb } from "@/server/db/client"
import { eq } from "drizzle-orm"
import { githubConnections } from "@/server/db/schema"

export class GithubService {
  static async connectRepository(
    organizationId: string,
    installationId: string,
    accountId: string,
    accessToken: string,
    refreshToken?: string,
    expiresAt?: Date
  ) {
    const db = getDb()
    return await db.insert(githubConnections).values({
      organizationId,
      githubInstallationId: installationId,
      githubAccountId: accountId,
      accessToken: this.encryptToken(accessToken),
      refreshToken: refreshToken ? this.encryptToken(refreshToken) : undefined,
      tokenExpiresAt: expiresAt,
      selectedRepositories: JSON.stringify([]), // Start with none selected
      createdAt: new Date(),
      updatedAt: new Date()
    })
  }

  // Add methods for token encryption/decryption, retrieval, updating, etc.
}
```

### 3. Connection UI
Create `/app/dashboard/github/page.tsx` with:
- List of connected GitHub accounts
- Button to connect new GitHub account (triggers OAuth flow)
- Repository selection interface (after connection)
- Save selected repositories for agent use

## Week 3: Agent-GitHub Integration

### 1. Extend Agent Schema
Add GitHub fields to AgentConfig in `src/server/db/schema.ts`:
```typescript
export interface AgentConfig {
  // ... existing fields ...
  readonly githubRepository?: string // "owner/repo"
  readonly githubBranch?: string
  readonly githubAccessLevel?: "read" | "write" | "admin"
}
```

### 2. Runtime Integration
Modify `src/server/runs/launcher.ts` to:
- Fetch GitHub token from organization's githubConnections
- Decrypt token
- Make available as GITHUB_TOKEN environment variable or via Octokit instance
- Pass to agent sandbox/environment

### 3. Security Implementation
- Implement token encryption using Node.js crypto module
- Add middleware to validate GitHub webhook signatures
- Implement rate limiting for GitHub API calls per organization

## Production Readiness Checklist

### Security
- [ ] Token encryption at rest implemented
- [ ] Minimum required GitHub scopes requested
- [ ] PKCE and state parameters verified in OAuth flow
- [ ] Rate limiting implemented for GitHub API calls
- [ ] Webhook signature validation (if using webhooks)
- [ ] Audit logging for GitHub API access

### Performance
- [ ] Database indexes on github_connections table
- [ ] Caching layer for frequently accessed GitHub data
- [ ] Connection pooling for database operations
- [ ] Efficient token retrieval without N+1 queries

### Monitoring & Observability
- [ ] GitHub API error rate alerts
- [ ] Token expiration monitoring
- [ ] Authentication success/failure metrics
- [ ] Usage analytics for GitHub-connected agents

### Documentation & Compliance
- [ ] Updated privacy policy covering GitHub data usage
- [ ] User documentation for connecting GitHub accounts
- [ ] Data export/delete functionality for GitHub connections
- [ ] Compliance review completed (if applicable)

## Rollback Plan
1. Better Auth GitHub provider can be disabled by removing the plugin
2. GitHub connection data can be preserved or deleted based on business requirements
3. No breaking changes to existing authentication flow
4. Feature flags can be used to gradually roll out to users

## Success Metrics
- Percentage of new sign-ups using GitHub OAuth
- Number of organizations connecting GitHub repositories
- Agent usage rate with GitHub-connected agents
- Reduction in support requests related to authentication
- GitHub API error rate and performance metrics