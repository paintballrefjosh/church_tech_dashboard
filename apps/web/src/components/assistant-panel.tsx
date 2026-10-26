"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { Bot, Maximize2, X } from "lucide-react";
import { DialogFrame } from "./modal";
import { ASSISTANT_OPEN_EVENT } from "./command-palette";
import { AssistantChat } from "@/app/assistant/assistant-chat";

/**
 * The assistant as a slide-over from any page (docs/assistant.md phase 2), for people whose groups have the module. It has no
 * button of its own (the top bar's right-hand side stays at two controls): it opens on `ASSISTANT_OPEN_EVENT`, sent by the
 * user menu's "Ask the assistant" and by the command palette (with what was typed as the question). Each opening is a new
 * conversation; "Open full page" goes to /assistant with the history.
 */
export function AssistantPanel({ access }: { access: Record<string, "user" | "moderator" | "admin"> }) {
  const titleId = useId();
  const [open, setOpen] = useState<{ question: string; n: number } | null>(null);
  const allowed = "assistant" in access;

  useEffect(() => {
    if (!allowed) return;
    const onOpen = (e: Event) => setOpen((cur) => ({ question: String((e as CustomEvent<{ question?: string }>).detail?.question ?? ""), n: (cur?.n ?? 0) + 1 }));
    window.addEventListener(ASSISTANT_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(ASSISTANT_OPEN_EVENT, onOpen);
  }, [allowed]);

  if (!allowed) return null;
  return (
    <>
      {open ? (
        <DialogFrame
          onClose={() => setOpen(null)}
          labelledBy={titleId}
          overlayClassName="fixed inset-0 z-50 flex justify-end bg-black/30"
          className="flex h-full w-full max-w-md flex-col gap-3 border-l border-slate-300 bg-white p-4 shadow-xl dark:border-slate-700 dark:bg-slate-900"
          testId="assistant-panel"
        >
          <div className="flex items-center gap-2">
            <h2 id={titleId} className="flex items-center gap-2 text-base font-semibold">
              <Bot className="h-5 w-5" aria-hidden /> Assistant
            </h2>
            <Link href="/assistant" onClick={() => setOpen(null)} className="ml-auto inline-flex items-center gap-1 text-xs text-brand-600 hover:underline dark:text-brand-400">
              <Maximize2 className="h-3.5 w-3.5" aria-hidden /> Open full page
            </Link>
            <button type="button" onClick={() => setOpen(null)} aria-label="Close the assistant" className="rounded p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800">
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
          <AssistantChat key={open.n} compact initialQuestion={open.question} />
        </DialogFrame>
      ) : null}
    </>
  );
}
