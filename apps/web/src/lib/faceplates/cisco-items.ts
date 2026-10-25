import type { CiscoPortRow } from "@church/shared";
import type { FaceItem } from "@/components/switch-faceplate";
import { slotForPort, type FaceplateLayout } from "./layouts";
import { faceState } from "./face-state";
import { poeProviding, poeSummary } from "../poe";

/**
 * One FaceItem per port, each physical slot used once: an uplink cage can be in the desired config under two names
 * (Gi1/1/1 and Te1/1/1, from whichever module was fitted before), and the one the switch has reported on is the
 * one that is really there. The other joins the "other interfaces" strip, so nothing is hidden.
 */
export function ciscoFaceItems(ports: CiscoPortRow[], layout: FaceplateLayout): FaceItem[] {
  const sorted = [...ports].sort((a, b) => a.portId.localeCompare(b.portId, undefined, { numeric: true }));
  const claimed = new Map<string, CiscoPortRow>();
  for (const p of sorted) {
    const slot = slotForPort(p.portId, layout);
    if (slot === null) continue;
    const cur = claimed.get(slot);
    if (!cur || (cur.operStatus === null && p.operStatus !== null)) claimed.set(slot, p);
  }
  return sorted.map((p) => {
    const slot = slotForPort(p.portId, layout);
    const fs = faceState(p);
    return {
      id: p.id,
      slot: slot !== null && claimed.get(slot)?.id === p.id ? slot : null,
      label: p.portId,
      state: fs.state,
      stateText: fs.text,
      poe: p.poe && poeProviding(p.poe) ? poeSummary(p.poe) : undefined,
    };
  });
}
