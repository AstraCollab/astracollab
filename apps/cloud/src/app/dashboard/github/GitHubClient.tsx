"use client"

import { useState } from "react"
import { deleteGithubConnectionAction } from "@/app/dashboard/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Search, ChevronDown, ChevronUp } from "lucide-react"

interface Repository {
  id: number
  name: string
  full_name: string
}

interface Connection {
  githubInstallationId: string | number
  createdAt: Date | string
  tokenExpiresAt: Date | string | null
  selectedRepositories: string | null
}

interface GitHubClientProps {
  connection: Connection | undefined
  orgId: string
}

export function GitHubClient({ connection, orgId }: GitHubClientProps) {
  const [searchQuery, setSearchQuery] = useState("")
  const [showAll, setShowAll] = useState(false)

  const repositories: Repository[] = connection?.selectedRepositories
    ? JSON.parse(connection.selectedRepositories)
    : []

  const filteredRepos = repositories.filter((repo) =>
    repo.full_name.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const displayRepos = showAll ? filteredRepos : filteredRepos.slice(0, 5)
  const hasMore = filteredRepos.length > 5

  if (!connection) {
    return (
      <div className="mt-4">
        <p className="text-sm text-[var(--ink-muted)]">
          No GitHub App installation connected yet.
        </p>
        <form action="/api/github/install">
          <Button
            type="submit"
            className="mt-3 rounded-[0.75rem] border-signal bg-signal text-[#09090b] hover:bg-signal/90"
          >
            Install GitHub App
          </Button>
        </form>
      </div>
    )
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone="busy">connected</Badge>
        <span className="font-mono-tech text-sm text-[var(--ink-muted)]">
          Installation #{connection.githubInstallationId}
        </span>
      </div>
      <p className="text-sm text-[var(--ink-muted)]">
        Connected on{" "}
        {new Date(connection.createdAt).toLocaleDateString(undefined, {
          year: "numeric",
          month: "long",
          day: "numeric"
        })}
      </p>
      {connection.tokenExpiresAt && (
        <p className="text-sm text-[var(--ink-muted)]">
          Token expires{" "}
          {new Date(connection.tokenExpiresAt).toLocaleDateString(undefined, {
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit"
          })}
        </p>
      )}

      {repositories.length > 0 && (
        <div className="mt-2">
          <div className="flex items-center justify-between mb-2">
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

          <div className="mt-1 flex flex-wrap gap-2">
            {displayRepos.map((repo) => (
              <Badge key={repo.id} tone="neutral" className="truncate max-w-[200px]">
                {repo.full_name}
              </Badge>
            ))}
          </div>

          {hasMore && !showAll && searchQuery === "" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2 text-sm"
              onClick={() => setShowAll(true)}
            >
              <ChevronDown className="mr-1 h-3.5 w-3.5" />
              Show all {repositories.length} repositories
            </Button>
          )}

          {showAll && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2 text-sm"
              onClick={() => setShowAll(false)}
            >
              <ChevronUp className="mr-1 h-3.5 w-3.5" />
              Show less
            </Button>
          )}

          {searchQuery && filteredRepos.length === 0 && (
            <p className="text-sm text-[var(--ink-muted)] mt-2">
              No repositories matching "{searchQuery}"
            </p>
          )}
        </div>
      )}

      <form action={deleteGithubConnectionAction}>
        <input type="hidden" name="organizationId" value={orgId} />
        <Button type="submit" variant="outline" className="rounded-[0.75rem]">
          Disconnect
        </Button>
      </form>
    </div>
  )
}