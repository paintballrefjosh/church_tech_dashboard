import type { FaceState } from "@/components/switch-faceplate";

/**
 * How a port looks on the picture: shut down (by the desired config) wins over what the switch last reported.
 *
 * The poller stores the status column of `show interfaces status` as `up`, `err-disabled`, `down` (the switch calls the port
 * disabled) or `notconnect` (also used for inactive, suspended and monitoring). Every stored value that is not up or an error is a
 * port with no link; "not read yet" is only a port the poller has not reported at all (null).
 */
export function faceState(p: { adminEnabled: boolean; operStatus: string | null }): { state: FaceState; text: string } {
  if (!p.adminEnabled) return { state: "shut", text: "shut down" };
  if (p.operStatus === null || p.operStatus === "") return { state: "unknown", text: "not read yet" };
  if (p.operStatus === "err-disabled") return { state: "error", text: "error-disabled" };
  if (p.operStatus === "up") return { state: "up", text: "up" };
  return { state: "down", text: "enabled, no link" };
}
