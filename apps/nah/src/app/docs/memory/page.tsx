import Link from "next/link";
import { Code, DocHeader, DocSection, DocsShell, Note } from "@/components/docs/DocsShell";

export default function MemoryPage() {
  return <DocsShell current="/docs/memory">
    <DocHeader eyebrow="MEMORY / CONVERSATION STATE" title="Keep the conversation state." description="The agent’s normal memory is its transcript: prior user messages, assistant responses, and tool interactions. Persist that state when you want a session to continue across turns or requests." />

    <DocSection id="transcript" title="Conversation history is the working state">
      <p><code>runAgent</code> accepts prior AI SDK messages in <code>messages</code> and returns the updated transcript in <code>result.messages</code>. Use it to continue a conversation with its recent context intact. The transcript is not a separate retrieval system and is not automatically stored by the core loop.</p>
      <Code language="ts">{"const previousMessages = await loadConversation(sessionId);\nconst run = runAgent({\n  model,\n  system,\n  prompt: userMessage,\n  tools,\n  messages: previousMessages,\n});\n\nconst result = await run.result;\nawait saveConversation(sessionId, result.messages);"}</Code>
      <p>Store transcripts by a stable conversation or session ID. In a multi-user app, authorize access to that ID on the server; do not accept another user’s session key as proof of access.</p>
    </DocSection>

    <DocSection id="jsonl" title="Persist a run with the Node session store">
      <p><code>createJsonlSessionStore</code> provides append-only JSONL persistence for AI SDK messages. Load the transcript before a run, then use <code>sessionUpdate</code> to decide whether the result can be appended or must replace the stored transcript after compaction.</p>
      <Code language="ts">{"import { createJsonlSessionStore, runAgent, sessionUpdate } from \"not-another-harness\";\n\nconst store = createJsonlSessionStore(`.nah/sessions/${sessionId}.jsonl`);\nconst before = await store.load();\nconst run = runAgent({ model, system, prompt: userMessage, tools, messages: before });\nconst result = await run.result;\n\nconst update = sessionUpdate(before, result);\nif (update.mode === \"replace\") {\n  await store.replace(update.messages);\n} else {\n  await store.append(update.messages);\n}"}</Code>
      <Note title="Compaction rewrites history">When the harness compacts context, <code>result.messages</code> is a summary and recent tail, not a suffix of the old transcript. <code>sessionUpdate</code> handles append versus replace so the persisted conversation keeps the compacted state.</Note>
    </DocSection>

    <DocSection id="web-runtime" title="Store conversation state in a web runtime">
      <p>The HTTP runtime separates the conversation store from the in-memory run loop. A <code>NahSessionStore</code> loads, appends, and replaces messages by session ID. The built-in memory store is useful for local development or a single long-lived process; use your database, KV store, or another durable adapter when sessions must survive restarts or move between instances.</p>
      <Code language="ts">{"import { createNahRuntime } from \"not-another-harness/js\";\n\nconst runtime = createNahRuntime({\n  session: {\n    load: (id) => database.loadMessages(id),\n    append: (id, messages) => database.appendMessages(id, messages),\n    replace: (id, messages) => database.replaceMessages(id, messages),\n  },\n  agent: async ({ messages }) => ({\n    model, system, tools,\n    // The runtime owns the transcript and current prompt.\n  }),\n});"}</Code>
      <p>The runtime loads the session, applies the new turn or resume decision, runs the agent, and persists the transcript before completing the response. It also supports in-memory stores via <code>createMemorySessionStore()</code> for development.</p>
    </DocSection>

    <DocSection id="not-cognitive" title="Transcript memory and cognitive memory">
      <p>Conversation history lets the model refer to what was said in this session. Cognitive memory is a separate, optional layer for durable facts and preferences that should remain useful across sessions. It can build prompt context, learn from completed turns, and persist its own state independently of the transcript.</p>
      <p>Choose conversation state for continuity within a chat. Add cognitive memory when you need cross-session retrieval or a configurable memory backend.</p>
      <Link href="/docs/cognitive-memory" className="text-violet-200 hover:text-white">Configure cognitive memory →</Link>
    </DocSection>
  </DocsShell>;
}
