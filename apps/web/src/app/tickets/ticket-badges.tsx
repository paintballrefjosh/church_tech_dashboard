import type { TicketPriority, TicketStatus } from "@church/shared";

const STATUS_LABEL: Record<TicketStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
  closed: "Closed",
};

const STATUS_CLASS: Record<TicketStatus, string> = {
  open: "bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-200",
  in_progress: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200",
  resolved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200",
  closed: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

const PRIORITY_LABEL: Record<TicketPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

const PRIORITY_CLASS: Record<TicketPriority, string> = {
  low: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  normal: "bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-200",
  high: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200",
  urgent: "bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-200",
};

export function StatusBadge({ status }: { status: TicketStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export function PriorityBadge({ priority }: { priority: TicketPriority }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${PRIORITY_CLASS[priority]}`}>
      {PRIORITY_LABEL[priority]}
    </span>
  );
}
