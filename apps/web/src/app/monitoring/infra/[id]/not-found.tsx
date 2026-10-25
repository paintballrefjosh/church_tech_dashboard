import { TopBar } from "@/components/topbar";
import { GoneNotice } from "@/components/gone-notice";

// A link to a deleted host (old notifications point at them) lands here, not on the generic 404.
export default function InfraTargetNotFound() {
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <GoneNotice what="host" backHref="/monitoring/infra" backLabel="Infrastructure" />
      </main>
    </>
  );
}
