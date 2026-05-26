"use client";

import { AttachmentList } from "@/components/attachment-list";

/** Thin wrapper kept so notes-board.tsx imports stay stable. */
export function NoteAttachments({ noteId }: { noteId: string }) {
  return (
    <div className="mt-2 border-t border-slate-200 pt-2 dark:border-slate-800">
      <AttachmentList baseUrl={`/api/notes/${noteId}/attachments`} canEdit layout="grid" />
    </div>
  );
}
