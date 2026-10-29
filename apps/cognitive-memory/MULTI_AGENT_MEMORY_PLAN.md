# Multi-Agent / Multi-Project Memory Organization Plan

## Current State Analysis

The Cognitive Memory system currently supports:
- **Organization** (tenant isolation via Better Auth)
- **Library** (optional scope via `libraryId` — null = org-wide)
- **Session** (conversation grouping via `sessionId`)
- **Domains** (tags for filtering via `domains[]`)
- **Four Tiers** (L0-L3) for priority/cost management

**Gaps for multi-agent/multi-project use:**
| Need | Current Support | Gap |
|------|----------------|-----|
| Project isolation | `libraryId` (generic, optional) | No explicit project concept; not enforced in all queries |
| Agent identity | `sessionId` (conversation only) | No agent type/name tracking |
| Hierarchical scope | Flat `libraryId` | No project → agent → session hierarchy |
| Cross-agent sharing | Via shared `libraryId` | No access control or ownership model |
| Query filtering | `libraryId`, `tier`, `domains` | No agent/project filter in recall/search |

---

## Proposed Solutions (3 Options)

### Option 1: Explicit Project + Agent Model (Recommended)

Add first-class `projectId` and `agentId` fields, with `libraryId` becoming a derived concept.

**Schema Changes:**
```typescript
// MemoryItem metadata additions
interface MemoryMetadata {
  projectId: string;           // Required: "web-dashboard", "api-service"
  agentId: string;             // Required: "code-reviewer", "docs-writer"
  agentType: string;           // Optional: "coding", "research", "support"
  sessionId: string;           // Existing: conversation grouping
  libraryId: string | null;    // Derived: `${projectId}:${agentId}` or org-wide
  domains: string[];
  // ... existing fields
}
```

**Query API:**
```typescript
// Recall with explicit filters
recall(query, { 
  projectId: "web-dashboard", 
  agentId: "code-reviewer", 
  agentType: "coding",
  domains: ["auth", "api"],
  tier: "L1"
});

// List memories scoped to project
list({ projectId: "web-dashboard" });

// Cross-agent recall within project (explicit opt-in)
recall(query, { projectId: "web-dashboard", includeAllAgents: true });
```

**Migration:** Backfill `libraryId` → `projectId` + `agentId` (split on `:` if using `project:agent` convention).

---

### Option 2: Hierarchical Scopes (Flexible)

Keep `libraryId` as the primary scope, but add a `scopePath` for hierarchy.

**Schema:**
```typescript
interface MemoryMetadata {
  scopePath: string;           // e.g., "org/web-dashboard/code-reviewer/session-123"
  scopeLevel: "org" | "project" | "agent" | "session";  // For indexing
  projectId?: string;          // Extracted from scopePath
  agentId?: string;
  sessionId?: string;
  domains: string[];
}
```

**Query:**
```typescript
// Recall at project level (includes all agents)
recall(query, { scopePath: "org/web-dashboard", scopeLevel: "project" });

// Recall at agent level
recall(query, { scopePath: "org/web-dashboard/code-reviewer", scopeLevel: "agent" });
```

**Pros:** Single field, flexible depth. **Cons:** String parsing, less type-safe.

---

### Option 3: Tag-Based with Virtual Libraries (Minimal Change)

Use `domains` for project/agent tagging, add virtual library views.

**Schema:** No new fields. Use conventions:
- `domains` includes: `project:web-dashboard`, `agent:code-reviewer`, `type:coding`
- Virtual library = saved query over domains

**Query:**
```typescript
// Virtual library: "my project memories"
recall(query, { domains: ["project:web-dashboard"] });

// Virtual library: "all coding agents in project"
recall(query, { domains: ["project:web-dashboard", "type:coding"] });
```

**Pros:** Zero schema change. **Cons:** No enforcement, domains array grows, query complexity.

---

## Recommendation: Option 1 (Explicit Project + Agent)

**Why:**
- Type-safe, enforceable at DB level
- Clear mental model: project → agent → session
- Enables access control later (agent A can't write to agent B's memory)
- Backward compatible: `libraryId` becomes derived/computed
- Matches how teams actually organize: "this project, this agent type"

---

## Implementation Plan

### Phase 1: Schema & Types (Week 1)
1. **Add fields to `Memory` type** (`packages/cognitive-memory/src/types.ts`):
   - `projectId: string` (required)
   - `agentId: string` (required) 
   - `agentType?: string`
   - Make `libraryId` computed: `${projectId}:${agentId}` or `org-wide`

2. **Update DB schema** (`apps/cognitive-memory/src/server/db/schema.ts`):
   - Add `projectId`, `agentId`, `agentType` columns to `memories` table
   - Add indexes: `(organizationId, projectId)`, `(organizationId, projectId, agentId)`
   - Keep `libraryId` for backward compat (populated on write)

3. **Update request types**:
   - `RememberRequest`: require `projectId`, `agentId`, optional `agentType`
   - `ListMemoriesParams`, `RecallRequest`: add `projectId`, `agentId`, `agentType` filters

### Phase 2: Engine Updates (Week 1-2)
1. **In-process engine** (`packages/cognitive-memory/src/cognitive/memory.ts`):
   - Add `projectId`, `agentId` to `CognitiveMemoryOptions` constructor
   - Scope all internal maps by `(projectId, agentId)` composite key
   - `search()` / `planInjection()` respect project/agent scope
   - `getSnapshot()` / `loadSnapshot()` include scope

2. **HTTP resources** (`packages/cognitive-memory/src/resources/*.ts`):
   - Pass project/agent params through to service

### Phase 3: Service Layer (Week 2)
1. **API routes** (`apps/cognitive-memory/src/app/api/v1/`):
   - Validate `projectId`, `agentId` on all memory endpoints
   - Enforce org-scoped project/agent isolation
   - Add `projectId`/`agentId` to injection logs, usage events

2. **Dashboard updates** (`apps/cognitive-memory/src/app/dashboard/`):
   - Project selector in header
   - Agent filter in memory list
   - Show project/agent in memory detail

### Phase 4: SDK & Migration (Week 2-3)
1. **Client SDK** (`packages/cognitive-memory/src/cogmem.ts`):
   - `createClient({ apiKey, projectId, agentId, agentType })` — sets defaults
   - `client.forProject(projectId).forAgent(agentId)` — scoped sub-clients
   - Auto-include `projectId`/`agentId` in all requests

2. **Migration script**:
   - Backfill existing memories: parse `libraryId` (if `project:agent` format) or assign to default project
   - Update `libraryId` to computed value

---

## API Design Examples

### Creating a Scoped Client
```typescript
import { createClient } from "cognitive-memory";

const memory = createClient({
  apiKey: process.env.COGMEM_KEY,
  projectId: "web-dashboard",
  agentId: "code-reviewer",
  agentType: "coding",
});

// All calls automatically scoped
await memory.memories.create({ items: [{ content: "Use React Server Components" }] });
const ctx = await memory.context.build({ userMessage: "How do I fetch data?" });
```

### Cross-Agent Recall (Explicit Opt-In)
```typescript
// Only this agent's memories
const myMemories = await memory.recall.ask("auth patterns");

// All agents in project (requires explicit flag)
const teamMemories = await memory.recall.ask("auth patterns", { 
  includeAllAgents: true 
});

// Specific other agent
const reviewerMemories = await memory.recall.ask("auth patterns", { 
  agentId: "security-reviewer" 
});
```

### Project-Level Admin
```typescript
// List all agents in project
const agents = await memory.projects.agents.list("web-dashboard");

// Promote memory across agents
await memory.memories.promote(memoryId, "L1", { 
  targetAgents: ["code-reviewer", "security-reviewer"] 
});
```

---

## Backward Compatibility

| Existing Code | Behavior |
|---------------|----------|
| No `projectId`/`agentId` | Assigned to `projectId: "default"`, `agentId: "default"` |
| `libraryId` only | Parsed as `projectId:agentId` if contains `:`, else `projectId: libraryId, agentId: "default"` |
| `sessionId` only | Works unchanged; scoped within project/agent |

---

## Acceptance Criteria

- [ ] Multiple agents on same project can share memories via `includeAllAgents: true`
- [ ] Agent A cannot accidentally read/write Agent B's memories without opt-in
- [ ] Project-level dashboard shows memory stats per agent
- [ ] Recall latency unchanged (<5ms p50)
- [ ] Migration script converts 100% of existing memories
- [ ] All existing tests pass + new multi-agent tests added

---

## Open Questions

1. **Default project/agent**: Should `createClient()` require them, or allow `default`?
2. **Agent registration**: Should agents be registered (CRUD) or implicit on first write?
3. **Cross-project recall**: Ever needed? (Probably not — separate orgs for that)
4. **Memory ownership**: Can Agent A delete Agent B's memory? (Admin only?)

---

## Next Steps

1. Review and confirm Option 1 approach
2. Create GitHub issues for each phase
3. Start with Phase 1: types + schema
4. Prototype in `packages/cognitive-memory` first, then service + dashboard