"use client";

import { useId, useState } from "react";
import type { SignagePlaylist, SignageScreen, SignageScreenGroup } from "@lampstand/shared";
import { sendJson } from "@/components/assets-ui";
import { Modal } from "../monitoring/network-cisco/cisco-ui";
import { ErrorLine, Label, PlaylistSelect, btnCls, inputCls, primaryCls } from "./signage-ui";

/** Add or edit a screen (Signage admins). */
export function ScreenFormModal({
  initial,
  groups,
  playlists,
  onClose,
  onSaved,
}: {
  initial: SignageScreen | null;
  groups: SignageScreenGroup[];
  playlists: SignagePlaylist[];
  onClose: () => void;
  onSaved: (s: SignageScreen) => void;
}) {
  const id = useId();
  const [name, setName] = useState(initial?.name ?? "");
  const [orientation, setOrientation] = useState(initial?.orientation ?? "landscape");
  const [tvControl, setTvControl] = useState(initial?.tvControl ?? "none");
  const [rokuIp, setRokuIp] = useState(initial?.rokuIp ?? "");
  const [hdmiInput, setHdmiInput] = useState<string>(initial?.hdmiInput ?? "");
  const [fallback, setFallback] = useState<string | null>(initial?.fallbackPlaylistId ?? null);
  const [groupIds, setGroupIds] = useState<string[]>(initial?.groupIds ?? []);
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const body = {
      name: name.trim(),
      orientation,
      tvControl,
      rokuIp: tvControl === "roku_ecp" && rokuIp.trim() ? rokuIp.trim() : null,
      hdmiInput: hdmiInput || null,
      fallbackPlaylistId: fallback,
      groupIds,
      notes,
      enabled,
    };
    try {
      const saved = initial ? await sendJson<SignageScreen>(`/api/signage/screens/${initial.id}`, "PATCH", body) : await sendJson<SignageScreen>("/api/signage/screens", "POST", body);
      onSaved(saved);
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={initial ? `Edit ${initial.name}` : "Add a screen"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <Label htmlFor={`${id}-name`}>Name</Label>
          <input id={`${id}-name`} className={inputCls} value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} placeholder="Lobby" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor={`${id}-or`}>Orientation</Label>
            <select id={`${id}-or`} className={inputCls} value={orientation} onChange={(e) => setOrientation(e.target.value as typeof orientation)}>
              <option value="landscape">Landscape</option>
              <option value="portrait">Portrait (TV on its side)</option>
            </select>
          </div>
          <div>
            <Label htmlFor={`${id}-tv`}>TV control</Label>
            <select id={`${id}-tv`} className={inputCls} value={tvControl} onChange={(e) => setTvControl(e.target.value as typeof tvControl)}>
              <option value="roku_ecp">Roku TV (over the network)</option>
              <option value="cec">HDMI-CEC (most other TVs)</option>
              <option value="none">None (the TV stays as it is)</option>
            </select>
          </div>
        </div>
        {tvControl === "roku_ecp" ? (
          <div>
            <Label htmlFor={`${id}-roku`} hint="Leave empty: the Pi finds the Roku on its own network. Give it to reach the TV when the Pi does not answer.">
              Roku address
            </Label>
            <input id={`${id}-roku`} className={inputCls} value={rokuIp} onChange={(e) => setRokuIp(e.target.value)} placeholder="10.20.30.40" inputMode="decimal" />
          </div>
        ) : null}
        {tvControl !== "none" ? (
          <div>
            <Label htmlFor={`${id}-in`} hint="Chosen each time the TV is switched on.">
              TV input the Pi is plugged into
            </Label>
            <select id={`${id}-in`} className={inputCls} value={hdmiInput} onChange={(e) => setHdmiInput(e.target.value)}>
              <option value="">Leave the input alone</option>
              {["InputHDMI1", "InputHDMI2", "InputHDMI3", "InputHDMI4"].map((i) => (
                <option key={i} value={i}>
                  {i.replace("Input", "")}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div>
          <Label htmlFor={`${id}-fb`} hint="Shown whenever nothing is scheduled.">
            Fallback playlist
          </Label>
          <PlaylistSelect id={`${id}-fb`} value={fallback} onChange={setFallback} playlists={playlists} allowNone="The logo slide" />
        </div>
        {groups.length ? (
          <fieldset>
            <legend className="text-sm font-medium text-slate-700 dark:text-slate-200">Screen groups</legend>
            <div className="mt-1 grid gap-1 sm:grid-cols-2">
              {groups.map((g) => (
                <label key={g.id} className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                  <input type="checkbox" checked={groupIds.includes(g.id)} onChange={(e) => setGroupIds(e.target.checked ? [...groupIds, g.id] : groupIds.filter((x) => x !== g.id))} />
                  {g.name}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        <div>
          <Label htmlFor={`${id}-notes`}>Notes</Label>
          <textarea id={`${id}-notes`} className={inputCls} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
        </div>
        <label className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Show content on this screen
        </label>
        <ErrorLine text={err} />
        <div className="flex justify-end gap-2">
          <button type="button" className={btnCls} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={primaryCls} disabled={busy || !name.trim()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
