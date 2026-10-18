"use client"

import { useState } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Search, ChevronDown, ChevronUp, GitBranch, Settings, Save } from "lucide-react"
import { deleteGithubConnectionAction } from "@/app/dashboard/actions"

interface Organization {
  id: string
  name: string | null
  slug: string
  createdAt: Date | string
}

interface Connection {
  githubInstallationId: string | number
  createdAt: Date | string
  tokenExpiresAt: Date | string | null
  selectedRepositories: string | null
}

interface SettingsClientProps {
  org: Organization
  githubConnection: Connection | undefined
  orgId: string
}

export function SettingsClient({ org, githubConnection, orgId }: SettingsClientProps) {
  const [activeTab, setActiveTab] = useState<"workspace" | "github">("workspace")
  const [searchQuery, setSearchQuery] = useState("")
  const [showAllRepos, setShowAllRepos] = useState(false)
  const [orgName, setOrgName] = useState(org.name ?? "")
  const [orgSlug, setOrgSlug] = useState(org.slug)

  const repositories = githubConnection?.selectedRepositories
    ? JSON.parse(githubConnection.selectedRepositories)
    : []

  const filteredRepos = repositories.filter((repo: { full_name: string }) =>
    repo.full_name.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const displayRepos = showAllRepos ? filteredRepos : filteredRepos.slice(0, 5)
  const hasMore = filteredRepos.length > 5

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="workspace">
          <Settings className="mr-2 h-4 w-4" />
          Workspace
        </TabsTrigger>
        <TabsTrigger value="github">
          <GitBranch className="mr-2 h-4 w-4" />
          GitHub
        </TabsTrigger>
      </TabsList>

      {/* Workspace Tab */}
      <TabsContent value="workspace" className="mt-6 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Workspace Details</CardTitle>
            <CardDescription>
              Configure your workspace name and slug.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="workspace-name" className="text-sm font-medium">
                Workspace Name
              </label>
              <Input
                id="workspace-name"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="My Workspace"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="workspace-slug" className="text-sm font-medium">
                Workspace Slug
              </label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-[var(--ink-muted)]">app.nah.cloud/</span>
                <Input
                  id="workspace-slug"
                  value={orgSlug}
                  onChange={(e) => setOrgSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                  placeholder="my-workspace"
                  className="flex-1"
                />
              </div>
              <p className="text-xs text-[var(--ink-muted)]">
                Used in URLs. Lowercase, numbers, and hyphens only.
              </p>
            </div>
            <div className="pt-4 border-t">
              <Button>
                <Save className="mr-2 h-4 w-4" />
                Save Changes
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="text-destructive">Danger Zone</CardTitle>
            <CardDescription>
              Irreversible actions. Proceed with caution.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-[var(--ink-muted)] mb-4">
              Deleting your workspace will permanently remove all agents, runs, sandboxes, and
              integrations. This action cannot be undone.
            </p>
            <Button variant="destructive">Delete Workspace</Button>
          </CardContent>
        </Card>
      </TabsContent>

      {/* GitHub Tab */}
      <TabsContent value="github" className="mt-6 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <GitBranch className="h-5 w-5" />
              GitHub App Integration
            </CardTitle>
            <CardDescription>
              Connect a GitHub App installation to allow agents to access your repositories.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {githubConnection ? (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                  <Badge tone="busy">Connected</Badge>
                  <span className="font-mono-tech text-sm text-[var(--ink-muted)]">
                    Installation #{githubConnection.githubInstallationId}
                  </span>
                </div>
                <p className="text-sm text-[var(--ink-muted)]">
                  Connected on{" "}
                  {new Date(githubConnection.createdAt).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "long",
                    day: "numeric"
                  })}
                </p>
                {githubConnection.tokenExpiresAt && (
                  <p className="text-sm text-[var(--ink-muted)]">
                    Token expires{" "}
                    {new Date(githubConnection.tokenExpiresAt).toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "long",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit"
                    })}
                  </p>
                )}

                {repositories.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-[var(--ink-muted)]">
                        Selected repositories ({repositories.length})
                      </p>
                      <div className="relative max-w-xs">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ink-muted)]" />
                        <Input
                          type="search"
                          placeholder="Search repositories..."
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          className="pl-9 pr-3 text-sm"
                          aria-label="Search repositories"
                        />
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {displayRepos.map((repo: { id: number; name: string; full_name: string }) => (
                        <Badge key={repo.id} tone="neutral" className="truncate max-w-[200px]">
                          {repo.full_name}
                        </Badge>
                      ))}
                    </div>

                    {hasMore && !showAllRepos && searchQuery === "" && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-sm"
                        onClick={() => setShowAllRepos(true)}
                      >
                        <ChevronDown className="mr-1 h-3.5 w-3.5" />
                        Show all {repositories.length} repositories
                      </Button>
                    )}

                    {showAllRepos && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-sm"
                        onClick={() => setShowAllRepos(false)}
                      >
                        <ChevronUp className="mr-1 h-3.5 w-3.5" />
                        Show less
                      </Button>
                    )}

                    {searchQuery && filteredRepos.length === 0 && (
                      <p className="text-sm text-[var(--ink-muted)]">
                        No repositories matching "{searchQuery}"
                      </p>
                    )}
                  </div>
                )}

                <form action={deleteGithubConnectionAction}>
                  <input type="hidden" name="organizationId" value={orgId} />
                  <Button type="submit" variant="outline" className="rounded-[0.75rem]">
                    Disconnect GitHub App
                  </Button>
                </form>
              </div>
            ) : (
              <div className="text-center py-8">
                <GitBranch className="mx-auto h-12 w-12 text-[var(--ink-muted)] mb-4" />
                <h3 className="text-lg font-medium mb-2">No GitHub App connected</h3>
                <p className="text-sm text-[var(--ink-muted)] mb-6 max-w-md mx-auto">
                  Install the Nah Cloud GitHub App to enable repository access for your agents.
                  You can select which repositories the app can access during installation.
                </p>
                <form action="/api/github/install">
                  <Button type="submit" className="border-signal bg-signal text-[#09090b] hover:bg-signal/90">
                    <GitBranch className="mr-2 h-4 w-4" />
                    Install GitHub App
                  </Button>
                </form>
              </div>
            )}
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  )
}