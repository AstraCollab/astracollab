"use client"

import { useEffect, useState } from "react"

import { Select } from "@/components/ui/select"
import { listGithubReposAction } from "@/app/dashboard/actions"

/**
 * Repository dropdown powered by the organisation's connected GitHub App.
 *
 * Fetches the list of repos the installation can access on mount, falling
 * back to a disabled dropdown + a link to the GitHub settings page when
 * nothing is connected.
 */
export function RepoSelect() {
  const [repos, setRepos] = useState<
    Array<{ id: number; name: string; full_name: string }> | null
  >(null)

  useEffect(() => {
    let mounted = true
    listGithubReposAction().then((result) => {
      if (!mounted) return
      setRepos(result.repos ?? [])
    })
    return () => {
      mounted = false
    }
  }, [])

  if (repos === null) {
    return (
      <Select disabled>
        <option value="">Loading repositories...</option>
      </Select>
    )
  }

  if (repos.length === 0) {
    return (
      <div className="space-y-2">
        <label htmlFor="repository" className="eyebrow block">
          Repository
        </label>
        <p className="text-xs text-[var(--ink-muted)]">
          Connect a GitHub App installation to pick repositories from a dropdown.
        </p>
        <a
          href="/dashboard/github"
          className="font-mono-tech inline-block text-sm text-signal hover:underline"
        >
          → Connect GitHub App
        </a>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <label htmlFor="repository" className="eyebrow block">
        Repository
      </label>
      <Select id="repository" name="repository" required>
        <option value="">Select a repository</option>
        {repos.map((repo) => (
          <option key={repo.id} value={repo.full_name}>
            {repo.full_name}
          </option>
        ))}
      </Select>
    </div>
  )
}
