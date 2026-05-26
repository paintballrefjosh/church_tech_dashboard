import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { TopBar } from "@/components/topbar";
import { NewTicketForm } from "./new-ticket-form";

export default async function NewTicketPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  if ((session.user as { mustChangePassword?: boolean }).mustChangePassword) {
    redirect("/change-password");
  }
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-2xl px-4 py-8">
        <h1 className="text-2xl font-semibold">New ticket</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Describe what you need help with. Support engineers will see it.
        </p>
        <NewTicketForm />
      </main>
    </>
  );
}
