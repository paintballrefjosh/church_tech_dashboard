"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Plus, Send, Square, ThumbsDown, ThumbsUp, Trash2, X } from "lucide-react";
import {
  TICKET_PRIORITIES,
  assistantProposalPayloadSchema,
  proposalHeadline,
  proposalRequest,
  proposalResultUrl,
  type AssistantProposal,
  type AssistantProposalPayload,
} from "@church/shared";

interface Msg {
  id?: string | null;
  role: "user" | "assistant";
  content: string;
  sources?: Array<{ title: string; url: string }>;
  lookups?: string[];
  proposals?: AssistantProposal[];
  rating?: number | null;
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

const fieldCls = "w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950";
const smallBtn = "inline-flex items-center gap-1 rounded-md border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:hover:bg-slate-800";

/**
 * A proposed action. Nothing has happened yet: the card shows what Confirm sends (text fields can be edited first), and
 * Confirm makes the normal API call as the person, then records the decision on the answer.
 */
function ProposalCard({ proposal, messageId, onDecided }: { proposal: AssistantProposal; messageId: string | null | undefined; onDecided: (p: AssistantProposal) => void }) {
  const id = useId();
  const [payload, setPayload] = useState<AssistantProposalPayload>(proposal.payload);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const decided = proposal.status !== "proposed";

  async function record(status: "done" | "dismissed", resultUrl: string | null) {
    const r = await fetch(`/api/v1/assistant/messages/${messageId}/actions/${proposal.id}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status, resultUrl }),
    });
    if (r.ok) onDecided((await r.json()) as AssistantProposal);
    else onDecided({ ...proposal, status, resultUrl, decidedAt: new Date().toISOString() });
  }

  async function confirm() {
    const checked = assistantProposalPayloadSchema.safeParse(payload);
    if (!checked.success) return setErr(checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    setBusy(true);
    setErr(null);
    try {
      const req = proposalRequest(checked.data);
      const r = await fetch(`/api/v1${req.path}`, {
        method: req.method,
        credentials: "same-origin",
        headers: req.body ? { "content-type": "application/json" } : undefined,
        body: req.body ? JSON.stringify(req.body) : undefined,
      });
      const answer = (await r.json().catch(() => null)) as { message?: unknown } | null;
      if (!r.ok) return setErr(typeof answer?.message === "string" ? answer.message : `It was refused (${r.status}).`);
      await record("done", proposalResultUrl(checked.data, answer) ?? proposal.contextUrl);
    } catch {
      setErr("The connection was lost; nothing was confirmed.");
    } finally {
      setBusy(false);
    }
  }

  const set = (patch: Partial<Record<string, unknown>>) => setPayload((p) => ({ ...p, ...patch }) as AssistantProposalPayload);
  return (
    <div className="mt-2 space-y-2 rounded-md border border-brand-300 bg-white p-3 text-sm dark:border-brand-700 dark:bg-slate-900" data-testid="assistant-proposal">
      <p className="font-medium">Proposed: {proposalHeadline(payload)}</p>
      {proposal.context ? (
        <p className="text-xs text-slate-600 dark:text-slate-300">
          {proposal.contextUrl ? (
            <Link href={proposal.contextUrl} className="text-brand-600 hover:underline dark:text-brand-400">
              {proposal.context}
            </Link>
          ) : (
            proposal.context
          )}
        </p>
      ) : null}
      {payload.kind === "create_ticket" || payload.kind === "wiki_draft" ? (
        <div className="space-y-2">
          <div>
            <label htmlFor={`${id}-title`} className="text-xs font-medium text-slate-600 dark:text-slate-300">
              Title
            </label>
            <input id={`${id}-title`} value={payload.title} disabled={decided} onChange={(e) => set({ title: e.target.value })} className={fieldCls} />
          </div>
          <div>
            <label htmlFor={`${id}-body`} className="text-xs font-medium text-slate-600 dark:text-slate-300">
              {payload.kind === "create_ticket" ? "Description" : "Page (Markdown)"}
            </label>
            <textarea
              id={`${id}-body`}
              rows={payload.kind === "wiki_draft" ? 8 : 4}
              disabled={decided}
              value={payload.kind === "create_ticket" ? payload.description : payload.body}
              onChange={(e) => set(payload.kind === "create_ticket" ? { description: e.target.value } : { body: e.target.value })}
              className={`${fieldCls} font-mono text-xs`}
            />
          </div>
          {payload.kind === "create_ticket" ? (
            <div>
              <label htmlFor={`${id}-prio`} className="text-xs font-medium text-slate-600 dark:text-slate-300">
                Priority
              </label>
              <select id={`${id}-prio`} value={payload.priority} disabled={decided} onChange={(e) => set({ priority: e.target.value })} className={fieldCls}>
                {TICKET_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>
      ) : null}
      {err ? (
        <p role="alert" className="text-xs text-rose-700 dark:text-rose-300">
          {err}
        </p>
      ) : null}
      {decided ? (
        <p className="text-xs text-slate-600 dark:text-slate-300">
          {proposal.status === "done" ? "Done" : "Dismissed"}
          {proposal.status === "done" && proposal.resultUrl ? (
            <>
              {" "}
              ·{" "}
              <Link href={proposal.resultUrl} className="text-brand-600 hover:underline dark:text-brand-400">
                open it
              </Link>
            </>
          ) : null}
        </p>
      ) : (
        <div className="flex gap-2">
          <button type="button" disabled={busy || !messageId} onClick={() => void confirm()} className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-60">
            <Check className="h-3.5 w-3.5" aria-hidden /> {busy ? "Working…" : "Confirm"}
          </button>
          <button type="button" disabled={busy || !messageId} onClick={() => void record("dismissed", null)} className={smallBtn}>
            <X className="h-3.5 w-3.5" aria-hidden /> Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

/** Thumbs up or down on an answer; a thumbs down asks (optionally) what was wrong. */
function Feedback({ messageId, rating, onRated }: { messageId: string; rating: number | null | undefined; onRated: (r: number) => void }) {
  const id = useId();
  const [comment, setComment] = useState("");
  const [asking, setAsking] = useState(false);
  const [sent, setSent] = useState(false);
  async function send(r: 1 | -1, text = "") {
    const res = await fetch(`/api/v1/assistant/messages/${messageId}/feedback`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rating: r, comment: text }),
    });
    if (res.ok) onRated(r);
  }
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
      <button type="button" aria-label="Good answer" aria-pressed={rating === 1} onClick={() => void send(1)} className={`rounded p-1.5 ${rating === 1 ? "text-emerald-700 dark:text-emerald-400" : ""}`}>
        <ThumbsUp className="h-3.5 w-3.5" aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Bad answer"
        aria-pressed={rating === -1}
        onClick={() => {
          void send(-1);
          setAsking(true);
        }}
        className={`rounded p-1.5 ${rating === -1 ? "text-rose-700 dark:text-rose-300" : ""}`}
      >
        <ThumbsDown className="h-3.5 w-3.5" aria-hidden />
      </button>
      {asking && !sent ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            void send(-1, comment).then(() => setSent(true));
          }}
        >
          <label htmlFor={id} className="sr-only">
            What was wrong (optional)
          </label>
          <input id={id} value={comment} maxLength={1000} onChange={(e) => setComment(e.target.value)} placeholder="What was wrong? (optional)" className="rounded border border-slate-300 px-2 py-0.5 dark:border-slate-700 dark:bg-slate-950" />
          <button type="submit" className={smallBtn}>
            Send
          </button>
        </form>
      ) : sent ? (
        <span>Thank you.</span>
      ) : null}
    </div>
  );
}

/**
 * The chat. Full page: the conversation list beside it. `compact` (the slide-over panel): no list, a new conversation each
 * time it opens, and `initialQuestion` asked at once.
 */
export function AssistantChat({ compact = false, initialQuestion = "" }: { compact?: boolean; initialQuestion?: string } = {}) {
  const [status, setStatus] = useState<{ enabled: boolean; canUse: boolean; health?: string | null } | null>(null);
  const [convs, setConvs] = useState<ConvRow[]>([]);
  const [convId, setConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const askedInitial = useRef(false);
  const qId = useId();

  const loadConvs = useCallback(async () => {
    if (compact) return;
    const r = await fetch("/api/v1/assistant/conversations", { credentials: "same-origin", cache: "no-store" });
    if (r.ok) setConvs((await r.json()) as ConvRow[]);
  }, [compact]);

  useEffect(() => {
    void (async () => {
      const r = await fetch("/api/v1/assistant/status", { credentials: "same-origin", cache: "no-store" });
      const s = r.ok ? ((await r.json()) as { enabled: boolean; canUse: boolean; health?: string | null }) : { enabled: false, canUse: false };
      setStatus(s);
      if (s.enabled && s.canUse) void loadConvs();
    })();
  }, [loadConvs]);

  useEffect(() => endRef.current?.scrollIntoView({ block: "end" }), [messages]);

  async function open(id: string) {
    const r = await fetch(`/api/v1/assistant/conversations/${id}`, { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) return;
    const c = (await r.json()) as {
      id: string;
      messages: Array<{ id: string; role: string; content: string; sources: Array<{ title: string; url: string }>; actions?: AssistantProposal[]; rating?: number | null }>;
    };
    setConvId(c.id);
    setMessages(
      c.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ id: m.id, role: m.role as Msg["role"], content: m.content, sources: m.sources, proposals: m.actions ?? [], rating: m.rating ?? null })),
    );
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

  const patchAt = (index: number, fn: (m: Msg) => Msg) => setMessages((list) => list.map((m, i) => (i === index ? fn(m) : m)));

  const ask = useCallback(
    async (text: string) => {
      const q = text.trim();
      if (!q || busy) return;
      setQuestion("");
      setBusy(true);
      setMessages((m) => [...m, { role: "user", content: q }, { role: "assistant", content: "", lookups: [], proposals: [] }]);
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
              | { type: "proposal"; proposal: AssistantProposal }
              | { type: "done"; messageId: string | null; sources: Array<{ title: string; url: string }> }
              | { type: "error"; message: string };
            if (e.type === "conversation") setConvId(e.id);
            else if (e.type === "text") patch((m) => ({ ...m, content: m.content + e.delta }));
            else if (e.type === "lookup") patch((m) => ({ ...m, lookups: [...(m.lookups ?? []), e.tool] }));
            else if (e.type === "proposal") patch((m) => ({ ...m, proposals: [...(m.proposals ?? []), e.proposal] }));
            else if (e.type === "done") patch((m) => ({ ...m, id: e.messageId, sources: e.sources }));
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
    },
    [busy, convId, loadConvs],
  );

  useEffect(() => {
    if (status?.enabled && status.canUse && initialQuestion.trim() && !askedInitial.current) {
      askedInitial.current = true;
      void ask(initialQuestion);
    }
  }, [status, initialQuestion, ask]);

  if (!status) return <p className="mt-6 text-sm text-slate-500 dark:text-slate-400">Loading…</p>;
  if (!status.canUse) return <p className="mt-6 text-sm text-slate-600 dark:text-slate-300">Your groups do not include the assistant.</p>;
  if (!status.enabled) return <p className="mt-6 text-sm text-slate-600 dark:text-slate-300">The assistant is not turned on. A site admin sets it up under Site settings, Assistant.</p>;

  const chat = (
    <section aria-label="Chat" className={`flex flex-col rounded-md border border-slate-300 dark:border-slate-800 ${compact ? "min-h-0 flex-1" : "min-h-[60vh]"}`}>
      {status.health === "budget_used" ? (
        <p className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">This month&apos;s budget is used up: questions are refused until a site admin raises it.</p>
      ) : status.health === "failing" ? (
        <p className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">The assistant&apos;s model has not been answering: questions may fail.</p>
      ) : null}
      <div className="flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite">
        {messages.length === 0 ? (
          <div className="text-sm text-slate-600 dark:text-slate-300">
            <p>Ask about the wiki, your tickets or the systems the dashboard watches. It sees only what you can see, and changes nothing unless you confirm a proposal.</p>
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
              {m.proposals?.map((p) => (
                <ProposalCard key={p.id} proposal={p} messageId={m.id} onDecided={(next) => patchAt(i, (x) => ({ ...x, proposals: (x.proposals ?? []).map((y) => (y.id === next.id ? next : y)) }))} />
              ))}
              {m.lookups?.length ? <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Looked up: {[...new Set(m.lookups)].join(", ")}</p> : null}
              {m.sources?.length ? (
                <p className="mt-1 text-xs">
                  Sources:{" "}
                  {m.sources.map((s, j) => (
                    <span key={s.url}>
                      {j ? ", " : ""}
                      {s.url.startsWith("/") ? (
                        <Link href={s.url} className="text-brand-600 hover:underline dark:text-brand-400">
                          {s.title}
                        </Link>
                      ) : (
                        s.title
                      )}
                    </span>
                  ))}
                </p>
              ) : null}
              {m.id && m.content && !(busy && i === messages.length - 1) ? <Feedback messageId={m.id} rating={m.rating} onRated={(r) => patchAt(i, (x) => ({ ...x, rating: r }))} /> : null}
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
        <label className="sr-only" htmlFor={qId}>
          Your question
        </label>
        <textarea
          id={qId}
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
  );

  if (compact) return chat;
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
      {chat}
    </div>
  );
}
