"use client"

import { useState } from "react"

import { sendJson, useResource, type SelfModelResponse } from "../data"
import {
  Badge,
  Bar,
  Button,
  Code,
  Empty,
  Failure,
  Field,
  Grid,
  Loading,
  Metric,
  PageHeader,
  Panel,
  Table,
  Td,
  Th,
  Toggle,
  inputClass
} from "../ui"

/**
 * What the agent knows about itself.
 *
 * Reliability per domain, from outcomes somebody recorded. Below 75%, the domain
 * is written into every prompt as a guardrail listing its known failure patterns,
 * so a weak area gets attention instead of a confident guess.
 *
 * The sample history is here because the score cannot be taken on trust. It is a
 * weighted moving average with a two-sample prior, which means one bad afternoon
 * cannot sink a domain and one good result cannot rescue it — a deliberate
 * choice, and the only way to see it working is to look at the samples.
 */

const WEAK_BELOW = 0.75

export function SelfModelPanel() {
  const { data, error, reload } = useResource<SelfModelResponse>("/api/dashboard/self-model")
  const [recording, setRecording] = useState(false)

  if (error !== null) return <Failure message={error} onRetry={reload} />
  if (data === null) return <Loading />

  const domains = Object.entries(data.selfModel.domains).sort(
    ([, a], [, b]) => a.reliabilityScore - b.reliabilityScore
  )
  const samples = data.outcomes
  const succeeded = samples.filter((outcome) => outcome.success).length
  const weakest = domains[0]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Self-model"
        description={
          <>
            Reliability per domain, from outcomes you record. A domain below 75% becomes
            a guardrail in the next context build, so the agent is told what it keeps
            getting wrong instead of being asked again.
          </>
        }
        actions={
          <Button variant="primary" onClick={() => setRecording((value) => !value)}>
            {recording ? "Cancel" : "Record an outcome"}
          </Button>
        }
      />

      {recording && (
        <RecordOutcome
          domains={domains.map(([name]) => name)}
          onDone={() => {
            setRecording(false)
            reload()
          }}
        />
      )}

      <Grid cols={4}>
        <Metric
          label="domains tracked"
          value={domains.length}
          hint={data.selfModel.activeDomains.length + " active"}
        />
        <Metric
          label="below 75%"
          value={data.selfModel.weakDomains.length}
          hint="guardrails in every prompt"
          tone={data.selfModel.weakDomains.length > 0 ? "warn" : "plain"}
        />
        <Metric
          label="weakest"
          value={weakest === undefined ? "—" : weakest[0]}
          hint={weakest === undefined ? "no data" : `${Math.round(weakest[1].reliabilityScore * 100)}%`}
          tone={weakest !== undefined && weakest[1].reliabilityScore < WEAK_BELOW ? "warn" : "plain"}
        />
        <Metric
          label="success rate"
          value={samples.length === 0 ? "—" : `${Math.round((succeeded / samples.length) * 100)}%`}
          hint={`${succeeded} of ${samples.length} samples`}
        />
      </Grid>

      {domains.length === 0 ? (
        <Empty title="Still at its priors">
          <p>
            Nothing is known about how reliable this agent is, so no guardrail can fire.
            Record an outcome — the agent does it automatically after each turn, but you
            can do it by hand too:
          </p>
          <Code className="mt-3 text-left">
            {`curl -X POST localhost:3000/api/v1/self-model/outcome \\
  -H "Authorization: Bearer $COGNITIVE_MEMORY_KEY" \\
  -H "content-type: application/json" \\
  -d '{"domain":"database","success":false,"failurePattern":"migrated without a backup"}'`}
          </Code>
        </Empty>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            {domains.map(([domain, capability]) => (
              <Panel
                key={domain}
                title={domain}
                hint={`${capability.sampleCount} ${capability.sampleCount === 1 ? "sample" : "samples"}`}
                actions={
                  capability.reliabilityScore < WEAK_BELOW ? (
                    <Badge tone="amber">guardrail active</Badge>
                  ) : (
                    <Badge tone="emerald">reliable</Badge>
                  )
                }
              >
                <div className="flex items-baseline justify-between">
                  <span className="text-xl tabular-nums text-zinc-200">
                    {Math.round(capability.reliabilityScore * 100)}%
                  </span>
                  <button
                    type="button"
                    disabled={samples.length === 0}
                    onClick={() => {
                      if (!window.confirm(`Forget everything known about ${domain}? Its guardrail goes too.`))
                        return
                      void sendJson("/api/dashboard/self-model/outcome", "DELETE", { domain }).then(reload)
                    }}
                    className="text-[11px] text-zinc-700 transition hover:text-red-300 disabled:opacity-40"
                  >
                    forget this domain
                  </button>
                </div>
                <div className="mt-2">
                  <Bar
                    value={capability.reliabilityScore}
                    tone={capability.reliabilityScore < WEAK_BELOW ? "amber" : "violet"}
                  />
                </div>

                {capability.knownFailurePatterns.length > 0 && (
                  <div className="mt-3">
                    <p className="font-mono text-[9px] uppercase tracking-widest text-zinc-600">
                      known pitfalls
                    </p>
                    <ul className="mt-1 space-y-0.5">
                      {capability.knownFailurePatterns.map((pattern) => (
                        <li key={pattern} className="text-[11px] leading-4 text-zinc-400">
                          · {pattern}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {capability.recommendedStrategies.length > 0 && (
                  <div className="mt-2">
                    <p className="font-mono text-[9px] uppercase tracking-widest text-zinc-600">
                      what worked
                    </p>
                    <ul className="mt-1 space-y-0.5">
                      {capability.recommendedStrategies.map((strategy) => (
                        <li key={strategy} className="text-[11px] leading-4 text-zinc-400">
                          · {strategy}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </Panel>
            ))}
          </div>

          {samples.length > 0 && (
            <Panel
              title="Every outcome recorded"
              hint="Newest first. The score above is a weighted average of exactly these."
            >
              <div className="max-h-[420px] overflow-y-auto">
                <Table
                  head={
                    <>
                      <Th>when</Th>
                      <Th>domain</Th>
                      <Th>result</Th>
                      <Th>detail</Th>
                    </>
                  }
                >
                  {samples.map((outcome) => (
                    <tr key={outcome.id}>
                      <Td className="whitespace-nowrap font-mono text-[10px] text-zinc-700">
                        {new Date(outcome.createdAt).toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit"
                        })}
                      </Td>
                      <Td className="font-mono text-[11px] text-zinc-400">{outcome.domain}</Td>
                      <Td>
                        <Badge tone={outcome.success ? "emerald" : "red"}>
                          {outcome.success ? "ok" : "failed"}
                        </Badge>
                      </Td>
                      <Td className="max-w-sm truncate text-[11px] text-zinc-500">
                        {outcome.failurePattern ?? outcome.strategy ?? "—"}
                      </Td>
                    </tr>
                  ))}
                </Table>
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  )
}

function RecordOutcome({ domains, onDone }: { domains: Array<string>; onDone: () => void }) {
  const [domain, setDomain] = useState(domains[0] ?? "")
  const [custom, setCustom] = useState(domains[0] === undefined ? "" : "")
  const [success, setSuccess] = useState(true)
  const [failurePattern, setFailurePattern] = useState("")
  const [strategy, setStrategy] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault()
        setBusy(true)
        setError(null)
        try {
          await sendJson("/api/dashboard/self-model/outcome", "POST", {
            domain: custom.trim() === "" ? domain : custom.trim(),
            success,
            ...(failurePattern.trim() === "" ? {} : { failurePattern: failurePattern.trim() }),
            ...(strategy.trim() === "" ? {} : { strategy: strategy.trim() })
          })
          onDone()
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Could not record that.")
          setBusy(false)
        }
      }}
      className="grid gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 lg:grid-cols-3"
    >
      {domains.length > 0 && (
        <Field label="domain">
          <select
            value={custom.trim() === "" ? domain : "__new"}
            onChange={(event) => {
              if (event.target.value === "__new") setCustom("")
              else {
                setDomain(event.target.value)
                setCustom("")
              }
            }}
            className={inputClass}
          >
            {domains.map((value) => (
              <option key={value} value={value} className="bg-[#0e0e13]">
                {value}
              </option>
            ))}
            <option value="__new" className="bg-[#0e0e13]">
              + a new domain
            </option>
          </select>
        </Field>
      )}

      <Field label={domains.length === 0 ? "domain" : "or a new one"}>
        <input
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
          placeholder={domains.length === 0 ? "database" : "migrations"}
          className={inputClass}
          required={domains.length === 0}
        />
      </Field>

      <Field label="result">
        <div className="pt-1.5">
          <Toggle checked={success} onChange={setSuccess} label={success ? "It worked" : "It failed"} />
        </div>
      </Field>

      {!success && (
        <Field label="failure pattern" hint="This becomes the guardrail line. Be specific.">
          <input
            value={failurePattern}
            onChange={(event) => setFailurePattern(event.target.value)}
            placeholder="migrated without a backup"
            className={inputClass}
          />
        </Field>
      )}

      {success && (
        <Field label="what worked" hint="Recorded as a recommended strategy. Optional.">
          <input
            value={strategy}
            onChange={(event) => setStrategy(event.target.value)}
            placeholder="dry run, then migrate in one transaction"
            className={inputClass}
          />
        </Field>
      )}

      <div className="flex items-center gap-3 lg:col-span-3">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Recording…" : "Record"}
        </Button>
        {error !== null && <span className="text-[12px] text-red-300">{error}</span>}
      </div>
    </form>
  )
}