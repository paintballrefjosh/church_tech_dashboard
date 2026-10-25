"use client";

import { useCallback, useRef, useState } from "react";
import type { CiscoPortRow, CiscoSwitch, SwitchModel } from "@church/shared";
import { FacePreview, faceSummary } from "@/components/switch-faceplate";
import { FollowCardHeader, FollowCardNote, useFollowCard } from "@/components/follow-card";
import { resolveSwitchView } from "@/lib/faceplates/custom";
import { ciscoFaceItems } from "@/lib/faceplates/cisco-items";

/** How long a switch's ports, read for a hover card, are reused before they are read again. */
const PORTS_FRESH_MS = 30_000;

type Ports = { at: number; ports: CiscoPortRow[] | null };

const keyOf = (sw: CiscoSwitch) => sw.id;

/**
 * A card with the switch's picture, its ports coloured by state, that follows the mouse while it is over the switch's row in
 * the list. A switch with no picture (no matching profile and no built-in drawing, or the picture turned off) gets no card.
 * Ports are read on the first hover and reused for `PORTS_FRESH_MS`.
 */
export function useSwitchHoverPreview(models: SwitchModel[] | null) {
  const cache = useRef(new Map<string, Ports>());
  const inflight = useRef(new Set<string>());
  const [, setVersion] = useState(0);

  const read = useCallback((sw: CiscoSwitch) => {
    const id = sw.id;
    const hit = cache.current.get(id);
    if ((hit && Date.now() - hit.at < PORTS_FRESH_MS) || inflight.current.has(id)) return;
    inflight.current.add(id);
    fetch(`/api/cisco/switches/${id}/ports`, { credentials: "same-origin", cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as CiscoPortRow[]) : null))
      .catch(() => null)
      .then((ports) => {
        cache.current.set(id, { at: Date.now(), ports });
        inflight.current.delete(id);
        setVersion((v) => v + 1);
      });
  }, []);

  const render = (sw: CiscoSwitch) => {
    if (!models) return null;
    const layout = resolveSwitchView(models, { model: sw.model, switchModelId: sw.switchModelId, switchViewOff: sw.switchViewOff }).layout;
    if (!layout) return null;
    // undefined = still being read, null = could not be read.
    const ports = cache.current.get(sw.id)?.ports;
    const items = ports ? ciscoFaceItems(ports, layout) : [];
    return (
      <>
        <FollowCardHeader name={sw.hostname} detail={layout.title} />
        <FacePreview layout={layout} items={items} />
        <FollowCardNote>
          {ports === undefined ? "Reading ports…" : ports === null ? "The ports could not be read." : faceSummary(items) || "No ports on the picture."}
        </FollowCardNote>
      </>
    );
  };

  const { bind, card } = useFollowCard({ keyOf, render, onEnter: read, testId: "switch-hover-preview" });
  return { rowProps: bind, card };
}
