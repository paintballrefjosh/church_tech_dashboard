import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { TopBar } from "@/components/topbar";
import { TemplateEditor } from "./template-editor";

export const dynamic = "force-dynamic";

/** One service template: read a built-in (and fork it), or write a custom one as YAML. */
export default async function ServiceTemplatePage({ params }: { params: Promise<{ key: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const { key } = await params;
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <TemplateEditor templateKey={key} />
      </main>
    </>
  );
}
