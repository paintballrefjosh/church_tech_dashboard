import type { ReactNode } from "react";
import { RequireModule } from "@/components/require-module";
import { AssistantBackdrop } from "@/components/assistant-backdrop";

/** The Assistant (the `assistant` module): any tier opens it; whether it answers is the Assistant admins' setup. */
export default function AssistantLayout({ children }: { children: ReactNode }) {
  return (
    <RequireModule module="assistant">
      <div>
        <AssistantBackdrop />
        <div className="fx-surface">{children}</div>
      </div>
    </RequireModule>
  );
}
