"use client"

import { useState } from "react"

import { authClient } from "@/lib/auth-client"
import { sendJson, useResource, type SettingsResponse } from "../data"
import {
  Badge,
  Button,
  Facts,
  Failure,
  Field,
  Grid,
  Loading,
  Metric,
  PageHeader,
  Panel,
  Segmented,
  inputClass
} from "../ui"

/**
 * Settings.
 *
 * Budgets are per organisation rather than per deployment because a hosted
 * instance has many tenants who cannot be expected to agree on one token ceiling.
 * Every field shows both the override and the deployment default, because "which
 * one is in force" is the first question a tuning knob raises and a single merged
 * number cannot answer it — a setting that silently reverts to the default is
 * worse than not having one.
 *
 * The danger zone is at the bottom, separated, and each action says what it does
 * not touch. "Forget everything" keeps your keys; "revoke every key" keeps your
 * memory. Bundling them into one button would produce the one outcome nobody
 * wanted.
 */

type Extraction = "auto" | "rules"

export function SettingsPanel() {
  const { data, error, reload } = useResource<SettingsResponse>("/api/dashboard/settings")
  const [notice, setNotice] = useState<string | null>(null)

  if (error !== null) return <Failure message={error} onRetry={reload} />
  if (data === null) return <Loading />

  const overrides = data.settings

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description={
          <>
            What this organisation spends per turn, whether a model is involved in
            learning, and how long the logs are kept. Everything here is per
            organisation; the deployment defaults are shown beside each override.
          </>
        }
      />

      {notice !== null && (
        <p className="rounded-lg border border-emerald-400/20 bg-emerald-400/[0.05] px-4 py-2.5 text-[12px] text-emerald-200/90">
          {notice}
        </p>
      )}

      {data.problems.length > 0 && (
        <div className="space-y-1.5 rounded-xl border border-amber-300/20 bg-amber-300/[0.05] px-4 py-3">
          <p className="text-[13px] text-amber-100/90">Unusable configuration</p>
          <ul className="space-y-1">
            {data.problems.map((problem) => (
              <li key={problem} className="font-mono text-[11px] leading-4 text-amber-200/70">
                {problem}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Grid cols={4}>
        <Metric
          label="token ceiling"
          value={data.effective.maxTotalTokens.toLocaleString()}
          hint={overrides?.maxTotalTokens === null || overrides?.maxTotalTokens === undefined ? "deployment default" : "organisation override"}
        />
        <Metric
          label="index lines"
          value={data.effective.maxIndexItems}
          hint={overrides?.maxIndexItems == null ? "deployment default" : "organisation override"}
        />
        <Metric
          label="recall limit"
          value={data.effective.defaultRecallLimit}
          hint={overrides?.defaultRecallLimit == null ? "deployment default" : "organisation override"}
        />
        <Metric
          label="extraction"
          value={data.effective.extraction}
          tone={data.effective.extraction === "rules-only" ? "warn" : "plain"}
          hint={
            data.deployment.modelConfigured
              ? `${data.deployment.modelProvider} · ${data.deployment.modelName}`
              : "no model key configured"
          }
        />
      </Grid>

      <Budgets
        effective={data.effective}
        defaults={data.deployment.defaults}
        overrides={overrides}
        onSaved={(message) => {
          setNotice(message)
          reload()
        }}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Extraction
          requested={data.requestedExtraction}
          modelConfigured={data.deployment.modelConfigured}
          mode={data.effective.extraction}
          onSaved={(message) => {
            setNotice(message)
            reload()
          }}
        />

        <Retention
          days={data.effective.retentionDays}
          memories={data.footprint.memories}
          onDone={(message) => {
            setNotice(message)
            reload()
          }}
        />
      </div>

      <Organisation />

      <Panel title="Deployment" hint="Read-only. An unusable value is reported here rather than thrown at startup.">
        <Facts
          rows={[
            ["database", <span key="db" className="truncate">{data.deployment.databasePath}</span>],
            [
              "model",
              data.deployment.modelConfigured
                ? `${data.deployment.modelProvider} · ${data.deployment.modelName}`
                : "not configured"
            ],
            ["sign-in secret", data.deployment.authConfigured ? "set" : "development fallback"],
            [
              "store",
              `${data.footprint.memories.toLocaleString()} memories · ${data.footprint.activeKeys} active key${
                data.footprint.activeKeys === 1 ? "" : "s"
              } of ${data.footprint.keys}`
            ]
          ]}
        />
      </Panel>

      <DangerZone onDone={(message) => { setNotice(message); reload() }} />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Budgets                                                                     */
/* -------------------------------------------------------------------------- */

function Budgets({
  effective,
  defaults,
  overrides,
  onSaved
}: {
  effective: SettingsResponse["effective"]
  defaults: SettingsResponse["deployment"]["defaults"]
  overrides: SettingsResponse["settings"]
  onSaved: (message: string) => void
}) {
  const [values, setValues] = useState({
    maxTotalTokens: overrides?.maxTotalTokens ?? defaults.maxTotalTokens,
    maxIndexItems: overrides?.maxIndexItems ?? defaults.maxIndexItems,
    defaultRecallLimit: overrides?.defaultRecallLimit ?? defaults.defaultRecallLimit
  })
  const [inherit, setInherit] = useState({
    maxTotalTokens: overrides?.maxTotalTokens == null,
    maxIndexItems: overrides?.maxIndexItems == null,
    defaultRecallLimit: overrides?.defaultRecallLimit == null
  })
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    try {
      await sendJson("/api/dashboard/settings", "PATCH", {
        // `null` is the wire meaning of "inherit": it clears the override so the
        // deployment default applies again, rather than freezing today's default
        // as this organisation's own value.
        maxTotalTokens: inherit.maxTotalTokens ? null : Number(values.maxTotalTokens),
        maxIndexItems: inherit.maxIndexItems ? null : Number(values.maxIndexItems),
        defaultRecallLimit: inherit.defaultRecallLimit ? null : Number(values.defaultRecallLimit)
      })
      onSaved(
        `Budgets saved. A context build now stops at ${
          inherit.maxTotalTokens ? defaults.maxTotalTokens : Number(values.maxTotalTokens)
        } tokens.`
      )
    } catch (cause) {
      onSaved(cause instanceof Error ? cause.message : "Could not save.")
    } finally {
      setBusy(false)
    }
  }

  const field = (
    key: keyof typeof values,
    label: string,
    hint: string
  ) => (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">{label}</span>
        <label className="flex items-center gap-1.5 text-[11px] text-zinc-600">
          <input
            type="checkbox"
            checked={inherit[key]}
            onChange={(event) => setInherit({ ...inherit, [key]: event.target.checked })}
            className="accent-violet-500"
          />
          inherit {defaults[key].toLocaleString()}
        </label>
      </div>
      <input
        type="number"
        min={1}
        value={values[key]}
        disabled={inherit[key]}
        onChange={(event) => setValues({ ...values, [key]: Number(event.target.value) })}
        className={`${inputClass} tabular-nums disabled:opacity-40`}
      />
      <p className="text-[11px] leading-4 text-zinc-600">{hint}</p>
    </div>
  )

  return (
    <Panel
      title="Budgets"
      hint="Per organisation. The ceiling is enforced on every build and reported when it truncates."
    >
      <div className="grid gap-4 sm:grid-cols-3">
        {field("maxTotalTokens", "token ceiling", "Everything injected into one prompt, index and bodies together.")}
        {field("maxIndexItems", "index lines", "One gist line per memory. Raising this is the cheap way to recall more.")}
        {field("defaultRecallLimit", "recall limit", "Results returned when a caller does not say.")}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[11px] text-zinc-600">
          In force now: {effective.maxTotalTokens} tokens, {effective.maxIndexItems} index lines,{" "}
          {effective.defaultRecallLimit} recall results.
        </p>
        <Button variant="primary" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save budgets"}
        </Button>
      </div>
    </Panel>
  )
}

/* -------------------------------------------------------------------------- */
/* Extraction                                                                  */
/* -------------------------------------------------------------------------- */

function Extraction({
  requested,
  modelConfigured,
  mode,
  onSaved
}: {
  requested: Extraction
  modelConfigured: boolean
  mode: SettingsResponse["effective"]["extraction"]
  onSaved: (message: string) => void
}) {
  const [value, setValue] = useState<Extraction>(requested)
  const [busy, setBusy] = useState(false)

  return (
    <Panel
      title="Extraction"
      hint="How much of a turn has to be understood before it can be stored."
    >
      <div className="space-y-3">
        <Segmented
          value={value}
          onChange={setValue}
          options={[
            { value: "auto", label: "rules + model", title: "Deterministic patterns first, then a model" },
            { value: "rules", label: "rules only", title: "Never call a model" }
          ]}
        />
        <p className="text-[11px] leading-5 text-zinc-600">
          Rules capture URLs, assignments and stated requirements with no model and no
          refusal. A model is then asked for the rest — a preference or a constraint that
          no pattern can see. <strong className="font-normal text-zinc-400">Rules only</strong>{" "}
          costs nothing per turn and never fails, and misses anything implied rather than
          stated.
        </p>
        {!modelConfigured && (
          <p className="text-[11px] leading-5 text-amber-200/70">
            No model key is configured on this deployment, so both options currently do the
            same thing: rules only.
          </p>
        )}
        <div className="flex items-center justify-between gap-3">
          <Badge tone={mode === "rules+model" ? "violet" : "neutral"}>running: {mode}</Badge>
          <Button
            variant="primary"
            disabled={busy || value === requested}
            onClick={async () => {
              setBusy(true)
              try {
                await sendJson("/api/dashboard/settings", "PATCH", { extraction: value })
                onSaved(`Extraction set to ${value}.`)
              } catch (cause) {
                onSaved(cause instanceof Error ? cause.message : "Could not save.")
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </Panel>
  )
}

/* -------------------------------------------------------------------------- */
/* Retention                                                                   */
/* -------------------------------------------------------------------------- */

function Retention({
  days,
  memories,
  onDone
}: {
  days: number
  memories: number
  onDone: (message: string) => void
}) {
  const [value, setValue] = useState(String(days))
  const [busy, setBusy] = useState(false)

  return (
    <Panel
      title="Retention"
      hint="How long the injection log, usage rows and outcome samples are kept. Memories themselves are never pruned."
    >
      <div className="space-y-3">
        <Field label="days" hint="0 keeps everything. The window is a promise you keep by pressing the button below, not a timer.">
          <input
            type="number"
            min={0}
            max={3650}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className={`${inputClass} tabular-nums`}
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await sendJson("/api/dashboard/settings", "PATCH", { retentionDays: Number(value) })
                onDone(`Retention set to ${value} days.`)
              } catch (cause) {
                onDone(cause instanceof Error ? cause.message : "Could not save.")
              } finally {
                setBusy(false)
              }
            }}
          >
            Save
          </Button>
          <Button
            disabled={busy}
            onClick={async () => {
              if (!window.confirm("Delete usage, injection and outcome rows older than the retention window?"))
                return
              setBusy(true)
              try {
                const body = await sendJson<{
                  deleted: { usage: number; injections: number; outcomes: number }
                }>("/api/dashboard/settings", "POST", { action: "prune" })
                onDone(
                  `Removed ${body.deleted.injections} injection log rows, ${body.deleted.usage} usage rows and ${body.deleted.outcomes} outcome samples. ${memories.toLocaleString()} memories untouched.`
                )
              } catch (cause) {
                onDone(cause instanceof Error ? cause.message : "Could not prune.")
              } finally {
                setBusy(false)
              }
            }}
          >
            Clean up now
          </Button>
        </div>
      </div>
    </Panel>
  )
}

/* -------------------------------------------------------------------------- */
/* Organisation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The organisation itself.
 *
 * Deleting it is irreversible and cascades: Better Auth owns the organisation row,
 * and the keys hang off it. The confirm prompt says so, because "delete" next to
 * a list of organisations is exactly the button somebody clicks on the wrong row.
 */
function Organisation() {
  const { data: session } = authClient.useSession()
  const { data: organizations, refetch } = authClient.useListOrganizations()
  const activeId = session?.session.activeOrganizationId ?? ""
  const active = organizations?.find((organization) => organization.id === activeId)

  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  return (
    <Panel
      title="Organisation"
      hint="Everything on this page is scoped to it. A key belongs to one, and only a signed-in session can change which one you are looking at."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <Field label="name" hint="What this memory store is for.">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={active?.name ?? "My organisation"}
              className={inputClass}
            />
          </Field>
          <Button
            variant="primary"
            disabled={busy || name.trim() === "" || activeId === ""}
            onClick={async () => {
              setBusy(true)
              try {
                await authClient.organization.update({ organizationId: activeId, data: { name: name.trim() } })
                setNotice("Organisation renamed.")
                setName("")
                await refetch()
              } catch (cause) {
                setNotice(cause instanceof Error ? cause.message : "Could not rename.")
              } finally {
                setBusy(false)
              }
            }}
          >
            Rename
          </Button>
        </div>

        <div className="space-y-2">
          <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-600">
            all your organisations
          </p>
          <ul className="space-y-1">
            {(organizations ?? []).map((organization) => (
              <li
                key={organization.id}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-white/[0.06] px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-300">
                  {organization.name}
                </span>
                {organization.id === activeId ? (
                  <Badge tone="violet">active</Badge>
                ) : (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={async () => {
                      await authClient.organization.setActive({ organizationId: organization.id })
                      window.location.reload()
                    }}
                  >
                    switch
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={async () => {
                    if (
                      !window.confirm(
                        `Delete ${organization.name}? Its keys, memories and logs go with it. This cannot be undone.`
                      )
                    )
                      return
                    setBusy(true)
                    try {
                      await authClient.organization.delete({ organizationId: organization.id })
                      window.location.reload()
                    } catch (cause) {
                      setNotice(cause instanceof Error ? cause.message : "Could not delete.")
                      setBusy(false)
                    }
                  }}
                >
                  delete
                </Button>
              </li>
            ))}
          </ul>
          <p className="text-[11px] leading-4 text-zinc-600">
            Members are managed by Better Auth. No email delivery is configured here, so
            invitations are not offered — add them through the auth API.
          </p>
        </div>
      </div>

      {notice !== null && <p className="mt-3 text-[12px] text-zinc-400">{notice}</p>}
    </Panel>
  )
}

function DangerZone({ onDone }: { onDone: (message: string) => void }) {
  const [busy, setBusy] = useState(false)

  const run = async (action: "forget-all" | "revoke-keys", question: string, message: (n: number) => string) => {
    const answer = window.prompt(question)
    if (answer !== "yes") return
    setBusy(true)
    try {
      const body = await sendJson<{ deleted?: number; revoked?: number }>(
        "/api/dashboard/settings",
        "POST",
        { action }
      )
      onDone(message(body.deleted ?? body.revoked ?? 0))
    } catch (cause) {
      onDone(cause instanceof Error ? cause.message : "That did not work.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel
      title="Danger zone"
      hint="Separate actions on purpose. Nothing here is reversible."
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.015] p-4">
          <p className="text-[13px] text-zinc-200">Forget every memory</p>
          <p className="mt-1 text-[11px] leading-4 text-zinc-600">
            Deletes every stored memory. Keys, contradictions and the self-model are kept
            — this is starting the memory over, not revoking access.
          </p>
          <Button
            variant="danger"
            disabled={busy}
            className="mt-3"
            onClick={() =>
              void run(
                "forget-all",
                "Type yes to forget every memory in this organisation.",
                (count) => `Forgot ${count} memories.`
              )
            }
          >
            Forget everything
          </Button>
        </div>

        <div className="rounded-lg border border-white/[0.06] bg-white/[0.015] p-4">
          <p className="text-[13px] text-zinc-200">Revoke every key</p>
          <p className="mt-1 text-[11px] leading-4 text-zinc-600">
            Stops every agent immediately. Memories are untouched, so a new key picks up
            exactly the same memory afterwards.
          </p>
          <Button
            variant="danger"
            disabled={busy}
            className="mt-3"
            onClick={() =>
              void run(
                "revoke-keys",
                "Type yes to revoke every key in this organisation.",
                (count) => `Revoked ${count} keys.`
              )
            }
          >
            Revoke all keys
          </Button>
        </div>
      </div>
    </Panel>
  )
}