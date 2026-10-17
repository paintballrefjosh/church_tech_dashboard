"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CircleCheck, ClipboardCheck } from "lucide-react";
import { describeWikiAge } from "@church/shared";
import { LocalDateTime } from "@/components/local-date-time";

export interface ReviewInfo {
  intervalDays: number;
  usingDefault: boolean;
  confirmedAt: string;
  dueAt: string | null;
  needsReview: boolean;
  daysOverdue: number;
  lastReviewedAt: string | null;
  reviewedBy: { id: string; name: string | null; email: string } | null;
}

/**
 * Whether the page can be trusted, in one line under the title: due for another look (with the button that says it is
 * still right), or when somebody last said it was. Confirming is not an edit, so it makes no revision.
 */
export function WikiReviewBar({ pageId, canEdit, review }: { pageId: string; canEdit: boolean; review: ReviewInfo }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmPage() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/wiki/${pageId}/review`, { method: "POST", credentials: "same-origin" });
      if (!res.ok) {
        setError(`Could not save (${res.status})`);
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const who = review.reviewedBy ? (review.reviewedBy.name ?? review.reviewedBy.email) : null;
  const button = canEdit ? (
    <button
      type="button"
      onClick={() => void confirmPage()}
      disabled={busy}
      data-testid="review-confirm"
      className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
    >
      <CircleCheck className="h-3.5 w-3.5" aria-hidden /> {busy ? "Saving..." : "This page is still correct"}
    </button>
  ) : null;

  if (review.needsReview) {
    const age = describeWikiAge(Math.max(review.daysOverdue + review.intervalDays, 1));
    return (
      <div
        role="status"
        data-testid="review-banner"
        data-needs-review="true"
        className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
      >
        <ClipboardCheck className="h-4 w-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">
          Nobody has edited or confirmed this page for {age}, so it may be out of date.
          {who && review.lastReviewedAt ? (
            <>
              {" "}
              Last confirmed by {who} on <LocalDateTime value={review.lastReviewedAt} options={{ dateStyle: "medium" }} />.
            </>
          ) : null}
        </span>
        {button}
        {error ? <span className="w-full text-xs text-rose-700 dark:text-rose-300">{error}</span> : null}
      </div>
    );
  }

  if (!review.lastReviewedAt && !canEdit) return null;
  return (
    <p className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400" data-testid="review-line" data-needs-review="false">
      {review.lastReviewedAt ? (
        <span>
          Confirmed correct{who ? ` by ${who}` : ""} on <LocalDateTime value={review.lastReviewedAt} options={{ dateStyle: "medium" }} />
        </span>
      ) : (
        <span>Not confirmed by anyone yet</span>
      )}
      {review.dueAt ? (
        <span>
          next check due <LocalDateTime value={review.dueAt} options={{ dateStyle: "medium" }} />
        </span>
      ) : (
        <span>not checked on a schedule</span>
      )}
      {button}
      {error ? <span className="text-rose-700 dark:text-rose-300">{error}</span> : null}
    </p>
  );
}
