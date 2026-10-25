"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, Printer } from "lucide-react";
import type { PortSheet, SwitchModel } from "@church/shared";
import { useSwitchModels } from "@/lib/use-switch-models";
import { installedModules, matchSwitchModel, resolveSwitchView } from "@/lib/faceplates/custom";
import { modelPicture } from "@/lib/rack-pictures";
import { PRINT_BASE_CSS } from "@/lib/print-css";

type Side = "front" | "back";

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "Gi1/0/12" is labelled "12" on the picture: the trailing number is what is stamped beside a real socket. */
function shortPortLabel(name: string): string {
  const m = /(\d+)$/.exec(name);
  return m ? m[1]! : name;
}

/** The model that draws this device: the picture choice made on the Cisco switch page, else the device's model text. */
function modelFor(sheet: PortSheet, models: readonly SwitchModel[]): SwitchModel | null {
  if (sheet.kind === "cisco") {
    return resolveSwitchView(models, { model: sheet.device.model, switchModelId: sheet.device.switchModelId, switchViewOff: sheet.device.switchViewOff }).model;
  }
  return matchSwitchModel(models, sheet.device.model);
}

/**
 * The printable port sheet of one switch: a picture of its front or back at the top (the person chooses which) and a
 * table of every port below, with its description and the VLAN and subnet it is in. The picture carries the port numbers
 * when the model has port boxes for that side, so a line of the table can be found on the device.
 */
export function PortSheetPrint({ kind, deviceKey, backHref }: { kind: "cisco" | "unifi"; deviceKey: string; backHref: string }) {
  const { models } = useSwitchModels();
  const [sheet, setSheet] = useState<PortSheet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [side, setSide] = useState<Side>("front");
  const [sideChosen, setSideChosen] = useState(false);
  const [labels, setLabels] = useState(true);
  const [printed, setPrinted] = useState("");

  useEffect(() => {
    setPrinted(today());
    fetch(`/api/port-sheets/${kind}/${encodeURIComponent(deviceKey)}`, { credentials: "same-origin", cache: "no-store" })
      .then(async (r) => {
        if (r.ok) return setSheet((await r.json()) as PortSheet);
        const body = (await r.json().catch(() => ({}))) as { message?: unknown };
        setError(typeof body.message === "string" ? body.message : `The port sheet could not be made (${r.status}).`);
      })
      .catch(() => setError("The port sheet could not be made."));
  }, [kind, deviceKey]);

  const model = sheet && models ? modelFor(sheet, models) : null;
  // Start on the side that has the ports, until the person picks one.
  useEffect(() => {
    if (!sideChosen && model) setSide(model.portSide);
  }, [model, sideChosen]);

  const picture = modelPicture(model, side === "front" ? "front" : "rear", model && models ? installedModules(model, models, sheet?.ports.map((p) => p.port) ?? []) : []);
  const boxes = model && side === model.portSide ? model.ports : [];

  return (
    <main className="min-h-screen bg-slate-100 px-3 py-6 print:bg-white print:p-0 dark:bg-slate-900 print:dark:bg-white">
      <style>{PRINT_BASE_CSS}</style>
      <div className="mx-auto mb-4 flex max-w-[210mm] flex-wrap items-center gap-3 print:hidden">
        <Link href={backHref} className="inline-flex items-center gap-1 text-sm text-brand-600 hover:underline dark:text-brand-400">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back
        </Link>
        <div role="group" aria-label="Picture to print" className="ml-auto inline-flex overflow-hidden rounded-md border border-slate-300 dark:border-slate-700">
          {(["front", "back"] as Side[]).map((s, i) => (
            <button
              key={s}
              type="button"
              aria-pressed={side === s}
              onClick={() => {
                setSide(s);
                setSideChosen(true);
              }}
              className={`px-2.5 py-1 text-xs ${i > 0 ? "border-l border-slate-300 dark:border-slate-700" : ""} ${
                side === s ? "bg-brand-600 text-white" : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              }`}
            >
              {s === "front" ? "Front" : "Back"}
            </button>
          ))}
        </div>
        <label className="inline-flex items-center gap-1.5 text-xs">
          <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} /> Number the ports on the picture
        </label>
        <button
          type="button"
          onClick={() => window.print()}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
        >
          <Printer className="h-4 w-4" aria-hidden /> Print
        </button>
      </div>

      {error ? <p role="alert" className="mx-auto max-w-[210mm] text-sm text-rose-700 dark:text-rose-300">{error}</p> : null}

      {sheet ? (
        <article
          className="print-sheet mx-auto max-w-[210mm] bg-white p-[10mm] text-slate-900 shadow print:max-w-none print:p-0 print:shadow-none"
          aria-label={`Port sheet for ${sheet.device.name}`}
        >
          <header className="mb-3 flex flex-wrap items-baseline gap-x-4 border-b border-slate-900 pb-1">
            <h1 className="text-base font-bold">{sheet.device.name}</h1>
            {sheet.device.ip ? <span className="font-mono text-xs">{sheet.device.ip}</span> : null}
            {sheet.device.model ? <span className="text-xs">{sheet.device.model}</span> : null}
            {sheet.device.location ? <span className="text-xs">{sheet.device.location}</span> : null}
            <span className="ml-auto text-[10px] text-slate-600">Printed {printed}</span>
          </header>

          {picture ? (
            <div className="mb-4 break-inside-avoid">
              <div className="relative mx-auto w-full" style={{ aspectRatio: `${picture.width} / ${picture.height}` }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={picture.url} alt={`${side === "front" ? "Front" : "Back"} of ${sheet.device.name}`} className="h-full w-full object-contain" />
                {picture.modules.map((m) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={m.id}
                    src={m.url}
                    alt=""
                    className="absolute"
                    style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%`, width: `${m.w * 100}%`, height: `${m.h * 100}%` }}
                  />
                ))}
                {labels
                  ? [...boxes, ...picture.modules.flatMap((m) => m.ports)].map((p) => (
                      <span
                        key={p.name}
                        aria-hidden
                        className="absolute border border-slate-900/70"
                        style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, width: `${p.w * 100}%`, height: `${p.h * 100}%` }}
                      >
                        <span
                          className="absolute left-1/2 -translate-x-1/2 -translate-y-full whitespace-nowrap text-[7px] font-bold leading-none text-slate-900"
                          style={{ top: 0, textShadow: "0 0 2px #fff, 0 0 2px #fff, 0 0 3px #fff" }}
                        >
                          {shortPortLabel(p.name)}
                        </span>
                      </span>
                    ))
                  : null}
              </div>
              <p className="mt-1 text-center text-[9px] text-slate-600">
                {side === "front" ? "Front" : "Back"} of {model?.name}
                {labels && boxes.length > 0 ? ". Numbers are the last part of each port name." : ""}
              </p>
            </div>
          ) : (
            <p className="mb-4 rounded border border-dashed border-slate-400 p-3 text-xs text-slate-600 print:hidden">
              {models === null
                ? "Loading pictures…"
                : model
                  ? `${model.name} has no ${side === "front" ? "front" : "back"} picture. Add one on the Switch models page, or pick the other side.`
                  : `No switch model matches ${sheet.device.model ? `"${sheet.device.model}"` : "this device"}, so there is no picture to print. The ports are listed below.`}
            </p>
          )}

          <table className="w-full border-collapse text-left text-[11px] leading-snug">
            <thead>
              <tr className="border-b border-slate-900 text-[9.5px] uppercase tracking-wide">
                <th scope="col" className="w-[15%] py-1 pr-2 font-semibold">Port</th>
                <th scope="col" className="w-[30%] py-1 pr-2 font-semibold">Description</th>
                <th scope="col" className="w-[30%] py-1 pr-2 font-semibold">VLAN</th>
                <th scope="col" className="py-1 font-semibold">Subnet</th>
              </tr>
            </thead>
            <tbody>
              {sheet.ports.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-3 text-slate-600">No ports have been reported for this device yet.</td>
                </tr>
              ) : (
                sheet.ports.map((p) => (
                  <tr key={p.port} className="border-b border-slate-300 align-top">
                    <td className="py-0.5 pr-2 font-mono font-semibold">{p.port}</td>
                    <td className="py-0.5 pr-2">{p.description || "-"}</td>
                    <td className="py-0.5 pr-2">{p.vlan}</td>
                    <td className="py-0.5 font-mono">{p.subnet}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          {sheet.notes.length > 0 ? (
            <ul className="mt-3 space-y-0.5 text-[9px] text-slate-600">
              {sheet.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
        </article>
      ) : null}
    </main>
  );
}
