import type { ReactNode } from "react";
import { NotesBackdrop } from "@/components/notes-backdrop";

/**
 * Section shell for Notes (/notes). Adds no chrome of its own — the page keeps
 * its TopBar + <main> — and only mounts the fixed sticky-notes backdrop once
 * behind an `.fx-surface` wrapper, whose card-translucency rules (globals.css)
 * let the notes drift faintly behind the note cards.
 */
export default function NotesLayout({ children }: { children: ReactNode }) {
  return (
    <div>
      <NotesBackdrop />
      <div className="fx-surface">{children}</div>
    </div>
  );
}
