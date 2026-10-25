"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Plus, Send, Square, Trash2 } from "lucide-react";

interface Msg {
  role: "user" | "assistant";
  content: string;
  sources?: Array<{ title: string; url: string }>;
  lookups?: string[];
  error?: string | null;
}
interface ConvRow {
  id: string;
  title: string;
}

const STARTERS = ["Is anything down right now?", "Which of my tickets are still open?", "How do I reset the sound desk?", "What is the IP of the main switch?"];

/** Model output: Markdown without images or raw HTML; links inside the site open normally, outside ones say where they go. */
function Answer({ text }: { text: string }) {
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: () => null,
          a: ({ href, children }) => {
            const h = String(href ?? "");
            if (h.startsWith("/") && !h.startsWith("//")) return <Link href={h}>{children}</Link>;
            if (/^https:\/\//i.test(h)) {
              let host = "";
              try {
                host = new URL(h).host;
              } catch {
                return <span>{children}</span>;
              }
              return (
                <a href={h} target="_blank" rel="noopener noreferrer nofollow">
                  {children} <span className="text-xs text-slate-500 dark:text-slate-400">({host})</span>
                </a>
              );
            }
            return <span>{children}</span>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function AssistantChat() {
  const [status, setStatus] = useState<{ enabled: boolean; canUse: boolean } | null>(null);
  const [convs, setConvs] = useState<ConvRow[]>([]);
  const [convId, setConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const loadConvs = useCallback(async () => {
    const r = await fetch("/api/v1/assistant/conversations", { credentials: "same-origin", cache: "no-store" });
    if (r.ok) setConvs((await r.json()) as ConvRow[]);
  }, []);

  useEffect(() => {
    void (async () => {
      const r = await fetch("/api/v1/assistant/status", { credentials: "same-origin", cache: "no-store" });
      const s = r.ok ? ((await r.json()) as { enabled: boolean; canUse: boolean }) : { enabled: false, canUse: false };
      setStatus(s);
      if (s.enabled && s.canUse) void loadConvs();
    })();
  }, [loadConvs]);

  useEffect(() => endRef.current?.scrollIntoView({ block: "end" }), [messages]);

  async function open(id: string) {
    const r = await fetch(`/api/v1/assistant/conversations/${id}`, { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) return;
    const c = (await r.json()) as { id: string; messages: Array<{ role: string; content: string; sources: Array<{ title: string; url: string }> }> };
    setConvId(c.id);
    setMessages(c.messages.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role as Msg["role"], content: m.content, sources: m.sources })));
  }

  async function remove(id: string) {
    if (!confirm("Delete this conversation?")) return;
    await fetch(`/api/v1/assistant/conversations/${id}`, { method: "DELETE", credentials: "same-origin" });
    if (id === convId) {
      setConvId(null);
      setMessages([]);
    }
    await loadConvs();
  }

  async function ask(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    setQuestion("");
    setBusy(true);
    setMessages((m) => [...m, { role: "user", content: q }, { role: "assistant", content: "", lookups: [] }]);
    const patch = (fn: (m: Msg) => Msg) => setMessages((list) => [...list.slice(0, -1), fn(list[list.length - 1]!)]);
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const res = await fetch("/api/v1/assistant/chat", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(convId ? { question: q, conversationId: convId } : { question: q }),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) {
        patch((m) => ({ ...m, error: res.status === 403 ? "You do not have access to the assistant." : `The question could not be asked (${res.status}).` }));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = block.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const e = JSON.parse(line.slice(6)) as
            | { type: "conversation"; id: string }
            | { type: "text"; delta: string }
            | { type: "lookup"; tool: string; ok: boolean }
            | { type: "done"; sources: Array<{ title: string; url: string }> }
            | { type: "error"; message: string };
          if (e.type === "conversation") setConvId(e.id);
          else if (e.type === "text") patch((m) => ({ ...m, content: m.content + e.delta }));
          else if (e.type === "lookup") patch((m) => ({ ...m, lookups: [...(m.lookups ?? []), e.tool] }));
          else if (e.type === "done") patch((m) => ({ ...m, sources: e.sources }));
          else if (e.type === "error") patch((m) => ({ ...m, error: e.message }));
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") patch((m) => ({ ...m, error: "The connection was lost." }));
    } finally {
      abortRef.current = null;
      setBusy(false);
      void loadConvs();
    }
  }

  if (!status) return <p className="mt-6 text-sm text-slate-500 dark:text-slate-400">Loading…</p>;
  if (!status.canUse) return <p className="mt-6 text-sm text-slate-600 dark:text-slate-400">Your groups do not include the assistant.</p>;
  if (!status.enabled) return <p className="mt-6 text-sm text-slate-600 dark:text-slate-400">The assistant is not turned on. A site admin sets it up under Site settings, Assistant.</p>;

  return (
    <div className="mt-6 grid gap-4 md:grid-cols-[14rem_1fr]">
      <nav aria-label="Conversations" className="space-y-1 text-sm">
        <button
          type="button"
          onClick={() => {
            setConvId(null);
            setMessages([]);
          }}
          className="mb-2 inline-flex w-full items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 dark:border-slate-700"
        >
          <Plus className="h-4 w-4" aria-hidden /> New chat
        </button>
        {convs.map((c) => (
          <div key={c.id} className={`flex items-center gap-1 rounded ${c.id === convId ? "bg-slate-100 dark:bg-slate-800" : ""}`}>
            <button type="button" onClick={() => void open(c.id)} className="min-w-0 flex-1 truncate px-2 py-1.5 text-left">
              {c.title || "Untitled"}
            </button>
            <button type="button" onClick={() => void remove(c.id)} className="rounded p-1.5 text-slate-500 hover:text-rose-700 dark:text-slate-400" aria-label={`Delete ${c.title || "conversation"}`}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        ))}
      </nav>

      <section aria-label="Chat" className="flex min-h-[60vh] flex-col rounded-md border border-slate-300 dark:border-slate-800">
        <div className="flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite">
          {messages.length === 0 ? (
            <div className="text-sm text-slate-600 dark:text-slate-400">
              <p>Ask about the wiki, your tickets or the systems the dashboard watches. It can only read, and it sees only what you can see.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {STARTERS.map((s) => (
                  <button key={s} type="button" onClick={() => void ask(s)} className="rounded-full border border-slate-300 px-3 py-1 dark:border-slate-700">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {messages.map((m, i) =>
            m.role === "user" ? (
              <p key={i} className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-brand-600 px-3 py-2 text-sm text-white">
                {m.content}
              </p>
            ) : (
              <div key={i} className="max-w-[95%] text-sm">
                {m.content ? <Answer text={m.content} /> : busy && i === messages.length - 1 ? <p className="text-slate-500 dark:text-slate-400">Thinking…</p> : null}
                {m.error ? <p className="mt-1 text-rose-700 dark:text-rose-300">{m.error}</p> : null}
                {m.lookups?.length ? <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Looked up: {[...new Set(m.lookups)].join(", ")}</p> : null}
                {m.sources?.length ? (
                  <p className="mt-1 text-xs">
                    Sources:{" "}
                    {m.sources.map((s, j) => (
                      <span key={s.url}>
                        {j ? ", " : ""}
                        {s.url.startsWith("/") ? <Link href={s.url} className="text-brand-600 hover:underline dark:text-brand-400">{s.title}</Link> : s.title}
                      </span>
                    ))}
                  </p>
                ) : null}
              </div>
            ),
          )}
          <div ref={endRef} />
        </div>
        <form
          className="flex items-end gap-2 border-t border-slate-300 p-3 dark:border-slate-800"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(question);
          }}
        >
          <label className="sr-only" htmlFor="assistant-question">
            Your question
          </label>
          <textarea
            id="assistant-question"
            rows={2}
            maxLength={4000}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void ask(question);
              }
            }}
            placeholder="Ask a question"
            className="min-w-0 flex-1 resize-none rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
          {busy ? (
            <button type="button" onClick={() => abortRef.current?.abort()} className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700">
              <Square className="h-4 w-4" aria-hidden /> Stop
            </button>
          ) : (
            <button type="submit" disabled={!question.trim()} className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">
              <Send className="h-4 w-4" aria-hidden /> Ask
            </button>
          )}
        </form>
      </section>
    </div>
  );
}
