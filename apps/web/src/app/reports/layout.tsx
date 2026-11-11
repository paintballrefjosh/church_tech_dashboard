import type { ReactNode } from "react";
import { ReportsBackdrop } from "@/components/reports-backdrop";

/** Section shell for reports (/reports/...). Each page keeps its TopBar + <main>; the bar-chart backdrop sits behind them. */
export default function ReportsLayout({ children }: { children: ReactNode }) {
  return (
    <div>
      <ReportsBackdrop />
      <div className="fx-surface">{children}</div>
    </div>
  );
}
