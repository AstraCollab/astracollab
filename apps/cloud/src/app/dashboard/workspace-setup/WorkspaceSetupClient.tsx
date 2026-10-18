"use client"
import Link from 'next/link'

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Search, GitBranch, Save, Check } from "lucide-react"

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

interface Organization {
  id: string
  name: string | null
  slug: string
  createdAt: Date | string
  defaultRepository: string | null
}

interface WorkspaceSetupClientProps {
  org: Organization
  githubConnection: Connection
  orgId: string
}

export function WorkspaceSetupClient({ org, githubConnection, orgId }: WorkspaceSetupClientProps) {
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedRepo, setSelectedRepo] = useState<string>("")
  const [isSaving, setIsSaving] = useState(false)

  const repositories: Repository[] = githubConnection.selectedRepositories
    ? JSON.parse(githubConnection.selectedRepositories)
    : []

  const filteredRepos = repositories.filter((repo) =>
    repo.full_name.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const handleSave = async () => {
    if (!selectedRepo) return
    setIsSaving(true)
    try {
      const res = await fetch("/api/workspace/default-repo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultRepository: selectedRepo }),
      })
      if (res.ok) {
        window.location.href = "/dashboard/agents"
      }
    } catch (err) {
      console.error("Failed to save default repo:", err)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Card className="max-w-2xl mx-auto">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GitBranch className="h-5 w-5" />
          Select Default Repository
        </CardTitle>
        <CardDescription>
          This will be used when creating new agents. You can change it later in Settings.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <label htmlFor="repo-search" className="eyebrow block">
            Search repositories
          </label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ink-muted)]" />
            <Input
              id="repo-search"
              type="search"
              placeholder="Search repositories..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 pr-3 text-sm"
              aria-label="Search repositories"
            />
          </div>
        </div>

        <div className="max-h-80 overflow-y-auto space-y-2 border rounded-[0.75rem] p-2">
          {filteredRepos.length === 0 ? (
            <p className="text-sm text-[var(--ink-muted)] text-center py-8">
              {searchQuery ? `No repositories matching "${searchQuery}"` : "No repositories found"}
            </p>
          ) : (
            filteredRepos.map((repo) => (
              <button
                key={repo.id}
                type="button"
                onClick={() => setSelectedRepo(repo.full_name)}
                className={`w-full text-left px-3 py-2 rounded-[0.5rem] text-sm font-mono-tech transition-colors flex items-center justify-between ${
                  selectedRepo === repo.full_name
                    ? "bg-signal/10 border border-signal/40 text-signal"
                    : "text-[var(--ink-muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--ink)] border border-transparent"
                }`}
              >
                <span>{repo.full_name}</span>
                {selectedRepo === repo.full_name && (
                  <Check className="h-4 w-4 text-signal" />
                )}
              </button>
            ))
          )}
        </div>

        <Button
          className="w-full rounded-[0.75rem] border-signal bg-signal text-[#09090b] hover:bg-signal/90"
          onClick={handleSave}
          disabled={!selectedRepo || isSaving}
        >
          {isSaving ? (
            <>
              <svg className="mr-2 h-4 w-4 animate-spin" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                  fill="none"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              Saving...
            </>
          ) : (
            <>
              <Save className="mr-2 h-4 w-4" />
              Save & Continue to Agents
            </>
          )}
        </Button>

        <p className="text-xs text-[var(--ink-muted)] text-center">
          You can change this later in <Link href="/dashboard/settings" className="underline hover:text-[var(--ink)]">Settings → GitHub</Link>
        </p>
      </CardContent>
    </Card>
  )
}