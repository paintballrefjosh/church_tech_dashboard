/**
 * The API's "read your own writes" cookie (api `cluster/read-your-writes.ts`): after a change it
 * answers with `church_rv=<time of the change>`, and a request carrying it makes whichever node
 * serves it catch up first. The web must hand that cookie on to the browser or the next request,
 * which may land on another node, never asks for the catch-up. Pure, so it can be unit-tested.
 */
export const CONSISTENCY_COOKIE = "church_rv";

/** The cookie in one `Set-Cookie` line from the API, or null when the line is some other cookie. */
export function parseConsistencySetCookie(line: string): { value: string; maxAge: number } | null {
  const parts = line.split(";").map((p) => p.trim());
  const first = parts[0] ?? "";
  const eq = first.indexOf("=");
  if (eq < 0 || first.slice(0, eq) !== CONSISTENCY_COOKIE) return null;
  const value = first.slice(eq + 1);
  if (!/^\d{1,16}$/.test(value)) return null;
  let maxAge = 10;
  for (const p of parts.slice(1)) {
    const m = /^max-age=(\d{1,5})$/i.exec(p);
    if (m) maxAge = Number(m[1]);
  }
  return { value, maxAge };
}
