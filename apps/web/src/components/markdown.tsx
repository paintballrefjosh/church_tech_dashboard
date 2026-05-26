"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders user-authored markdown. Raw HTML in the source is escaped by default
 * (we don't pass rehype-raw) — that's the security boundary. If we want to
 * allow a vetted subset of HTML later, add rehype-sanitize with a strict schema
 * before re-introducing rehype-raw.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose prose-slate max-w-none dark:prose-invert prose-headings:font-semibold prose-a:text-brand-600 prose-pre:bg-slate-900 prose-pre:text-slate-100 dark:prose-pre:bg-slate-950">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
