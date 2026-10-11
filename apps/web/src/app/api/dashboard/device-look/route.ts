import { NextResponse, type NextRequest } from "next/server";
import { LOOK_DEVICE_COOKIE, isLookId } from "@church/shared";

const FOUR_HUNDRED_DAYS = 400 * 24 * 60 * 60;

/**
 * Sets or clears the cookie that pins a look to this browser. No API call: the cookie is a device
 * preference, read by the home page. Not `Secure` on purpose: HTTPS is terminated upstream and this
 * app never sees it (see CLAUDE.md); it is still HttpOnly and SameSite=Lax.
 * Body: `{ look: LookId | null }` (null clears it).
 */
export async function POST(req: NextRequest) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Send a JSON body." }, { status: 400 });
  }
  const look = typeof json === "object" && json !== null ? (json as { look?: unknown }).look : undefined;
  if (look !== null && !isLookId(look)) {
    return NextResponse.json({ error: "Unknown look." }, { status: 400 });
  }
  const res = NextResponse.json({ ok: true, look });
  if (look === null) {
    res.cookies.set(LOOK_DEVICE_COOKIE, "", { path: "/", maxAge: 0, httpOnly: true, sameSite: "lax" });
  } else {
    res.cookies.set(LOOK_DEVICE_COOKIE, look, {
      path: "/",
      maxAge: FOUR_HUNDRED_DAYS,
      httpOnly: true,
      sameSite: "lax",
    });
  }
  return res;
}
