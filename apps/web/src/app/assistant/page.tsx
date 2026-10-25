import { redirect } from "next/navigation";
import { Bot } from "lucide-react";
import { auth } from "@/lib/auth";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { AssistantChat } from "./assistant-chat";

export const dynamic = "force-dynamic";

export const metadata = { title: "Assistant" };

export default async function AssistantPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <PageTitle icon={Bot}>Assistant</PageTitle>
        <AssistantChat />
      </main>
    </>
  );
}
