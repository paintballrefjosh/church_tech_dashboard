"use client";

import type { SwitchModel } from "@church/shared";
import { FacePreview, faceSummary } from "@/components/switch-faceplate";
import { FollowCardHeader, FollowCardNote, FollowCardPicture, useFollowCard } from "@/components/follow-card";
import { resolveSwitchView } from "@/lib/faceplates/custom";
import { modelPicture } from "@/lib/rack-pictures";
import { sortedPorts, unifiFaceItems, type UnifiPort } from "@/lib/unifi-ports";

export interface HoverDevice {
  name?: string;
  mac?: string;
  model?: string;
  port_table?: unknown[];
  switchModelId?: string | null;
  switchViewOff?: boolean;
}

const keyOf = (d: HoverDevice) => d.mac ?? d.name ?? "";

/**
 * The UniFi devices list's hover card. Only a device with a device profile (chosen for it, or matched on its model text)
 * gets one: the built-in drawings are Cisco layouts and never hold a UniFi port. A profile with port boxes shows the ports
 * coloured by state (the list already carries each device's port table, so nothing is read); one without shows its picture.
 */
export function useDeviceHoverPreview(models: SwitchModel[] | null) {
  const render = (d: HoverDevice) => {
    if (!models) return null;
    const view = resolveSwitchView(models, { model: d.model, switchModelId: d.switchModelId, switchViewOff: d.switchViewOff });
    if (!view.model) return null;
    const name = d.name ?? d.mac ?? "Device";
    const ports = sortedPorts(d.port_table as UnifiPort[] | undefined);
    if (view.layout?.source === "custom" && ports.length > 0) {
      const items = unifiFaceItems(ports, view.layout);
      return (
        <>
          <FollowCardHeader name={name} detail={view.model.name} />
          <FacePreview layout={view.layout} items={items} />
          <FollowCardNote>{faceSummary(items) || "No ports on the picture."}</FollowCardNote>
        </>
      );
    }
    const pic = modelPicture(view.model, "front") ?? modelPicture(view.model, "rear");
    if (!pic) return null;
    return (
      <>
        <FollowCardHeader name={name} detail={view.model.name} />
        <FollowCardPicture url={pic.url} width={pic.width} height={pic.height} />
      </>
    );
  };
  const { bind, card } = useFollowCard({ keyOf, render, testId: "device-hover-preview" });
  return { rowProps: bind, card };
}
