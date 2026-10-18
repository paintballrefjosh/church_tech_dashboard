"use client";

import { useState } from "react";
import { formatVlanList, normaliseVlanList, parseVlanList, type CiscoSwitchVlan } from "@church/shared";
import { inputCls } from "./cisco-ui";

const label = (v: CiscoSwitchVlan) => `${v.vlanId} · ${v.name}`;

/** One VLAN chosen from the switch's own list. A value the switch does not have stays selectable, marked as such. */
export function VlanSelect({
  value,
  vlans,
  onChange,
}: {
  value: number;
  vlans: CiscoSwitchVlan[];
  onChange: (vlanId: number) => void;
}) {
  const known = vlans.some((v) => v.vlanId === value);
  return (
    <select value={value} onChange={(e) => onChange(Number(e.target.value))} className={`w-full ${inputCls}`}>
      {vlans.map((v) => (
        <option key={v.vlanId} value={v.vlanId}>
          {label(v)}
        </option>
      ))}
      {known ? null : <option value={value}>{value} · not defined on this switch</option>}
    </select>
  );
}

/**
 * A trunk's allowed VLANs: all of them, or the ones ticked from the switch's list plus any others typed by hand.
 * The value is the shortest list a switch accepts ("1-4094", "30,32-35,103").
 */
export function TrunkVlanField({
  value,
  vlans,
  onChange,
}: {
  value: string;
  vlans: CiscoSwitchVlan[];
  onChange: (list: string) => void;
}) {
  const set = parseVlanList(value);
  const all = normaliseVlanList(value) === "1-4094";
  const listed = new Set(vlans.map((v) => v.vlanId));
  const others = [...set].filter((v) => !listed.has(v));
  const [otherText, setOtherText] = useState(others.length && !all ? formatVlanList(others) : "");

  const compose = (checked: Iterable<number>, extra: string) => onChange(formatVlanList([...checked, ...parseVlanList(extra)]));
  const ticked = [...set].filter((v) => listed.has(v));

  return (
    <div className="space-y-2 text-sm">
      <div className="flex gap-4">
        <label className="inline-flex items-center gap-1.5">
          <input type="radio" name="trunk-allowed" checked={all} onChange={() => onChange("1-4094")} />
          All VLANs
        </label>
        <label className="inline-flex items-center gap-1.5">
          <input
            type="radio"
            name="trunk-allowed"
            checked={!all}
            onChange={() => {
              setOtherText("");
              onChange(formatVlanList(vlans.map((v) => v.vlanId)));
            }}
          />
          Selected VLANs
        </label>
      </div>
      {all ? null : (
        <>
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-slate-200 p-2 dark:border-slate-800">
            {vlans.map((v) => (
              <label key={v.vlanId} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={set.has(v.vlanId)}
                  onChange={(e) => compose(e.target.checked ? [...ticked, v.vlanId] : ticked.filter((x) => x !== v.vlanId), otherText)}
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 dark:text-brand-400 dark:border-slate-700"
                />
                {label(v)}
              </label>
            ))}
          </div>
          <label className="block text-xs">
            <span className="text-slate-500 dark:text-slate-400">Other VLANs (ids not in the list, like 500,600-610)</span>
            <input
              value={otherText}
              onChange={(e) => {
                setOtherText(e.target.value);
                compose(ticked, e.target.value);
              }}
              className={`mt-1 w-full font-mono text-xs ${inputCls}`}
            />
          </label>
          <p className="font-mono text-[11px] text-slate-500 dark:text-slate-400">Sends: {normaliseVlanList(value)}</p>
        </>
      )}
    </div>
  );
}
