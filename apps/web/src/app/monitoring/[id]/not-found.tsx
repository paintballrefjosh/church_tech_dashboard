import { TopBar } from "@/components/topbar";
import { GoneNotice } from "@/components/gone-notice";

// A link to a deleted monitor (old notifications point at them) lands here, not on the generic 404.
export default function MonitorNotFound() {
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <GoneNotice what="monitor" backHref="/monitoring" backLabel="Back to monitors" />
      </main>
    </>
  );
}
