import { NextResponse, type NextRequest } from "next/server";
import { apiFetch } from "@/lib/api";

const SESSION_COOKIE_CANDIDATES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
];

/**
 * Accepts both JSON (from the client component) and form-urlencoded (native
 * fallback). On success returns a 303 redirect to /, so a native form POST
 * navigates the browser correctly. JSON callers can also use the redirect
 * (fetch+manual) or look at status.
 */
export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") ?? "";
  let newPassword = "";
  if (contentType.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as { newPassword?: string };
    newPassword = body.newPassword ?? "";
  } else {
    const form = await req.formData();
    newPassword = String(form.get("newPassword") ?? form.get("password1") ?? "");
  }
  if (!newPassword || newPassword.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
  }
  const res = await apiFetch("/api/v1/me/change-password", {
    method: "POST",
    body: JSON.stringify({ newPassword }),
  });
  if (!res.ok) {
    let message: string;
    try {
      message = (await res.json()).message ?? "Change failed";
    } catch {
      message = `Change failed (${res.status})`;
    }
    return NextResponse.json({ error: message }, { status: res.status });
  }
  // Invalidate the current JWT cookie — it still has mustChangePassword=true,
  // and the user must sign in with the new password to get a fresh one.
  // We use a *relative* Location header so the browser resolves it against the
  // original public URL it requested (e.g. http://localhost:8100), not the
  // container-internal host that req.url reports as.
  const response = contentType.includes("application/json")
    ? NextResponse.json({ ok: true, signOut: true })
    : new NextResponse(null, { status: 303, headers: { Location: "/signin?changed=1" } });
  for (const name of SESSION_COOKIE_CANDIDATES) {
    response.cookies.set(name, "", { path: "/", maxAge: 0 });
  }
  return response;
}
