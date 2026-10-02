import Link from "next/link"

import { DOC_GROUPS, type DocPage } from "@/lib/docs"

import { Mark } from "./site-header"

/**
 * The footer. Short, because there is nothing here worth scrolling to — but the
 * link columns are generated from the same map the documentation sidebar reads,
 * so a page that exists is reachable from the marketing site and a page that is
 * renamed cannot leave a dead anchor behind in a footer nobody remembers.
 */
export function SiteFooter({ width = "max-w-5xl" }: { width?: string }) {
  return (
    <footer className="border-t border-white/[0.06]">
      <div
        className={`mx-auto flex w-full ${width} flex-col gap-8 px-6 py-12 sm:flex-row sm:items-start sm:justify-between`}
      >
        <div className="max-w-xs space-y-3">
          <Link href="/" className="flex items-center gap-2.5">
            <Mark />
            <span className="text-[13px] font-medium">Cognitive Memory</span>
          </Link>
          <p className="text-xs leading-5 text-zinc-600">
            A four-tier memory service for agents. Every line injected into a
            prompt carries its reason and its token cost.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-x-12 gap-y-6 text-[13px] sm:grid-cols-3">
          <Column
            title="Product"
            links={[
              ["How it works", "/#tiers"],
              ["Documentation", "/docs"],
              ["Dashboard", "/dashboard"],
              ["API health", "/api/v1/health"]
            ]}
          />
          <Column
            title="Concepts"
            links={DOC_GROUPS[1].pages.slice(0, 4).map(docLink)}
          />
          <Column
            title="Reference"
            links={[
              ...DOC_GROUPS[0].pages.slice(1).map(docLink),
              ...DOC_GROUPS[2].pages.slice(0, 2).map(docLink)
            ]}
          />
        </div>
      </div>
      <div className={`mx-auto w-full ${width} px-6 pb-10`}>
        <p className="text-[11px] text-zinc-700">
          Self-hosted. Deterministic recall. You can read every byte your agent
          has been told.
        </p>
      </div>
    </footer>
  )
}

const docLink = (page: DocPage): readonly [string, string] => [page.title, page.href]

function Column({
  title,
  links
}: {
  title: string
  links: ReadonlyArray<readonly [string, string]>
}) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">{title}</p>
      <ul className="mt-3 space-y-2">
        {links.map(([label, href]) => (
          <li key={href}>
            <Link href={href} className="text-zinc-400 transition hover:text-zinc-100">
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
