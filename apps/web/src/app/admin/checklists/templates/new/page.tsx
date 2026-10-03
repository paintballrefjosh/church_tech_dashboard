import { redirect } from "next/navigation";
import Link from "next/link";
import { FileText, ArrowLeft } from "lucide-react";
import { auth } from "@/lib/auth";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { NewTemplateForm } from "./new-template-form";

export default async function NewChecklistTemplatePage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <nav className="mb-3 text-sm">
          <Link
            href="/admin/checklists"
            className="inline-flex items-center gap-1 text-brand-600 hover:underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to checklists admin
          </Link>
        </nav>
        <PageTitle icon={FileText}>New template</PageTitle>
        <NewTemplateForm />
      </main>
    </>
  );
}
