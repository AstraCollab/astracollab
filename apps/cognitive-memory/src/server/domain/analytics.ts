/**
 * What the analytics page is allowed to say.
 *
 * Aggregates, declared next to the domain rather than assembled in a route: the
 * numbers have to mean the same thing wherever they are computed, and a report
 * assembled from five ad-hoc SQL results in a handler is where two dashboards
 * start disagreeing.
 *
 * Buckets are UTC days. Local days would read better on a chart, but they depend
 * on the reader's timezone, so the same query would produce two different series
 * for two people looking at the same tenant.
 */

export interface DailyBucket {
  /** `YYYY-MM-DD`, UTC. */
  readonly day: string
  readonly builds: number
  readonly tokens: number
  readonly truncated: number
  /** Memories stored that day. */
  readonly added: number
}

export interface Counted {
  readonly label: string
  readonly count: number
}

export interface SpendRow {
  readonly route: string
  readonly calls: number
  readonly tokens: number
}

export interface KeySpend {
  readonly id: string
  readonly name: string
  readonly prefix: string
  readonly calls: number
  readonly tokens: number
  readonly lastUsedAt: string | null
  readonly revoked: boolean
}

export interface AnalyticsReport {
  readonly from: number
  readonly to: number
  readonly days: number
  readonly totals: {
    /** Context builds in the range. */
    readonly builds: number
    readonly tokens: number
    readonly medianTokens: number
    readonly p95Tokens: number
    readonly truncated: number
    /** Builds that hit the ceiling, as a share of builds. 0 when there were none. */
    readonly truncatedShare: number
    /** Builds whose median cost is already close to the budget. */
    readonly utilisation: number
    readonly memories: number
    readonly memoriesAdded: number
    readonly activeTensions: number
    readonly resolvedTensions: number
    readonly weakDomains: number
    /** Builds that carried at least one guardrail line. */
    readonly guardrailBuilds: number
    readonly activeKeys: number
  }
  readonly daily: ReadonlyArray<DailyBucket>
  readonly routes: ReadonlyArray<SpendRow>
  readonly keys: ReadonlyArray<KeySpend>
  /** Why each line was included: index | trigger | tension | guardrail. */
  readonly reasons: ReadonlyArray<Counted>
  readonly tiers: ReadonlyArray<Counted>
  readonly domains: ReadonlyArray<Counted>
  readonly sources: ReadonlyArray<Counted>
  /** The builds that cost the most, for chasing an expensive prompt down. */
  readonly largest: ReadonlyArray<{
    readonly id: string
    readonly tokens: number
    readonly bodies: number
    readonly truncated: boolean
    readonly createdAt: string
    readonly preview: string
  }>
}