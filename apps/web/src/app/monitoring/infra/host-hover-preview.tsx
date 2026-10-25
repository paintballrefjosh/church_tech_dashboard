"use client";

import type { InfraTarget, SwitchModel } from "@church/shared";
import { FollowCardHeader, FollowCardPicture, useFollowCard } from "@/components/follow-card";
import { pickableProfiles } from "@/components/device-picture";
import { modelPicture } from "@/lib/rack-pictures";

const keyOf = (t: InfraTarget) => t.id;

/**
 * The infrastructure overview's hover card: the picture of the device profile chosen for the host (a host reports no model
 * text, so nothing is matched), front first. A host with no profile, or a profile with no picture, gets no card. A host
 * has no port states to colour.
 */
export function useHostHoverPreview(models: SwitchModel[] | null) {
  const render = (t: InfraTarget) => {
    const model = t.switchModelId ? pickableProfiles(models).find((m) => m.id === t.switchModelId) : undefined;
    if (!model) return null;
    const pic = modelPicture(model, "front") ?? modelPicture(model, "rear");
    if (!pic) return null;
    return (
      <>
        <FollowCardHeader name={t.name} detail={model.name} />
        <FollowCardPicture url={pic.url} width={pic.width} height={pic.height} />
      </>
    );
  };
  const { bind, card } = useFollowCard({ keyOf, render, testId: "host-hover-preview" });
  return { cardProps: bind, card };
}
