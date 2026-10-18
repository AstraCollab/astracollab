"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"

import { sendChatMessageAction } from "@/app/dashboard/actions"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

/** A turn as the server rendered it. Mirrors a `messages` row, not the table. */
interface Turn {
  readonly id: string
  readonly role: "user" | "agent"
  readonly content: string
  readonly runId: string | null
}

/**
 * The thread, and the box you type into.
 *
 * Modelled on nah-studio's `ChatView`, and it keeps that view's one non-obvious
 * property: the thread is not held in component state. Every message already
 * exists in the database when it is sent, so the only thing kept here is the
 * optimistic copy — and the moment the action resolves, the server-rendered
 * thread replaces it. A chat that lives in React state reads as unpersisted the
 * first time someone switches views or opens the page in a second tab, and at
 * that point they have already stopped believing anything else the UI says.
 *
 * So the local state is explicitly a *pending* list, cleared on every resolve,
 * and the source of truth is always what the server sends. That also means the
 * send path is a plain server action rather than a bespoke endpoint: the database
 * write and the render are the same round trip.
 */
export function ChatThread({
  conversationId,
  turns
}: {
  readonly conversationId: string
  readonly turns: readonly Turn[]
}) {
  const router = useRouter()
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bottom = useRef<HTMLDivElement | null>(null)

  // Only while a send is in flight, so the optimistic message disappears the
  // moment the real one arrives rather than sitting in the thread as a duplicate.
  const [pending, setPending] = useState<readonly Turn[]>([])

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" })
  }, [turns, pending, sending])

  const send = async () => {
    const content = draft.trim()
    if (!content || sending) return

    setDraft("")
    setError(null)
    setSending(true)
    setPending((current) => [
      ...current,
      { id: `pending-${current.length}`, role: "user", content, runId: null }
    ])

    try {
      const formData = new FormData()
      formData.set("conversationId", conversationId)
      formData.set("content", content)
      await sendChatMessageAction(formData)
      // Re-render from the database rather than patching local state. The reply
      // is not here yet — the runtime has not run — so this fetches the user's
      // message back and whatever else has landed since.
      router.refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setDraft(content)
    } finally {
      setPending([])
      setSending(false)
    }
  }

  const shown: readonly Turn[] = [...turns, ...pending]

  return (
    <div className="flex min-h-[24rem] flex-col gap-4">
      {error ? (
        <p className="rounded-[0.75rem] border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-300">
          {error}
        </p>
      ) : null}

      <div className="flex flex-1 flex-col justify-end gap-3 overflow-y-auto rounded-[0.75rem] border border-line bg-[var(--surface-inset)] p-4">
        {shown.length === 0 ? (
          <p className="py-8 text-center text-sm text-[var(--ink-muted)]">
            Ask this agent something. Every message starts a run, and the transcript
            of each one is kept.
          </p>
        ) : null}

        {shown.map((turn) => (
          <div
            key={turn.id}
            className={`flex flex-col ${turn.role === "user" ? "items-end" : "items-start"}`}
          >
            <div
              className={`max-w-[80%] rounded-xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                turn.role === "user"
                  ? "bg-signal/12 text-[var(--ink)]"
                  : "border border-line bg-[var(--surface-raised)] text-[var(--ink-muted)]"
              }`}
            >
              {turn.content}
            </div>
            {/* The run link is what makes a chat auditable rather than decorative:
                every message maps to the execution that produced it. */}
            {turn.runId ? (
              <a
                href={`/dashboard/runs/${turn.runId}`}
                className="eyebrow mt-1.5 text-signal-dim transition-colors hover:text-signal"
              >
                run {turn.runId.slice(0, 8)} →
              </a>
            ) : null}
          </div>
        ))}

        {sending ? (
          <p className="font-mono-tech text-xs text-[var(--ink-faint)]">queued…</p>
        ) : null}
        <div ref={bottom} />
      </div>

      <div>
        <div className="flex gap-2">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter breaks the line. The convention every
              // chat has, and the alternative — a send button you must reach for —
              // makes a conversation feel like a form.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
            rows={2}
            placeholder="Ask something. Enter to send, Shift+Enter for a newline."
          />
          <Button
            type="button"
            onClick={() => void send()}
            disabled={sending || !draft.trim()}
            className="shrink-0 self-end rounded-[0.75rem] border-signal bg-signal text-[#09090b] hover:bg-signal/90"
          >
            Send
          </Button>
        </div>
        <p className="mt-2 text-xs text-[var(--ink-faint)]">
          Messages are stored as they are sent, so this thread survives a refresh.
          Every message starts a run you can open.
        </p>
      </div>

      <span className="sr-only" aria-live="polite">
        {sending ? "Sending" : ""}
      </span>
    </div>
  )
}
