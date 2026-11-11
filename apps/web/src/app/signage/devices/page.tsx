"use client";

import { Suspense, useCallback, useId, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Cpu, Radar, ScanEye, Trash2 } from "lucide-react";
import { FORGET_FAILED_PREFIX, isLikelyPi, type SignageDevice, type SignageDiscoverySubnet, type SignageFoundPi, type SignageIdentifyResult, type SignageScreen, type SignageScreenGroup } from "@lampstand/shared";
import { PageTitle } from "@/components/page-title";
import { sendJson } from "@/components/assets-ui";
import { usePoll } from "@/lib/use-poll";
import { Modal } from "../../monitoring/network-cisco/cisco-ui";
import { ErrorLine, Forbidden, Label, ProblemBadges, ago, btnCls, dangerCls, inputCls, primaryCls, useSignageJson, useSignagePerms } from "../signage-ui";
import { SetupModal, ShowCodeModal } from "./devices-ui";
import { GroupsPanel } from "./groups-panel";

const TABS = [
  { id: "attention", label: "Needs attention" },
  { id: "all", label: "All" },
  { id: "found", label: "Found" },
  { id: "disabled", label: "Disabled" },
  { id: "groups", label: "Groups" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function needsAttention(d: SignageDevice): boolean {
  return d.enabled && (d.status === "failed" || d.problems.some((p) => p.severity !== "info"));
}

export default function SignageDevicesPage() {
  return (
    <Suspense fallback={null}>
      <DevicesInner />
    </Suspense>
  );
}

function DevicesInner() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [devices, setDevices] = useState<SignageDevice[] | null>(null);
  const [found, setFound] = useState<SignageFoundPi[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const screens = useSignageJson<SignageScreen[]>("screens");
  const groups = useSignageJson<SignageScreenGroup[]>("groups");
  const perms = useSignagePerms();
  const [setupFor, setSetupFor] = useState<SignageFoundPi | null>(null);
  const [codeFor, setCodeFor] = useState<SignageFoundPi | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [identify, setIdentify] = useState<SignageIdentifyResult | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  // The "Find Pis" panel (subnets and addresses to look in). null = follow the default: open until there is a device to look after, and on the Found tab.
  const [finderChoice, setFinderChoice] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    const [d, f] = await Promise.all([
      fetch("/api/signage/devices", { credentials: "same-origin", cache: "no-store" }).catch(() => null),
      fetch("/api/signage/discovery/found", { credentials: "same-origin", cache: "no-store" }).catch(() => null),
    ]);
    if (d?.status === 403) return setForbidden(true);
    if (d?.ok) setDevices((await d.json()) as SignageDevice[]);
    if (f?.ok) setFound((await f.json()) as SignageFoundPi[]);
  }, []);
  usePoll(load, 15_000);

  const all = devices ?? [];
  const attention = all.filter(needsAttention);
  // Only hosts that look like Pis count and are listed first; other SSH hosts (a router, a VM) wait in a collapsed section.
  const waiting = (found ?? []).filter((f) => !f.dismissed && !f.knownDeviceId && isLikelyPi(f.evidence));
  const defaultTab: TabId = attention.length ? "attention" : "all";
  const raw = params.get("tab");
  const tab: TabId = TABS.some((t) => t.id === raw) ? (raw as TabId) : defaultTab;
  const counts: Record<TabId, number> = { attention: attention.length, all: all.length, found: waiting.length, disabled: all.filter((d) => !d.enabled).length, groups: groups.data?.length ?? 0 };
  const rows = tab === "attention" ? attention : tab === "disabled" ? all.filter((d) => !d.enabled) : all;
  const finderOpen = finderChoice ?? (devices !== null && (all.length === 0 || tab === "found"));

  function pickTab(id: TabId) {
    const q = new URLSearchParams(params.toString());
    q.set("tab", id);
    router.replace(`${pathname}?${q.toString()}`);
  }

  async function runIdentify(allDevices: boolean) {
    setErr(null);
    try {
      const r = await sendJson<SignageIdentifyResult>("/api/signage/identify", "POST", allDevices ? { all: true } : { deviceIds: [...selected] });
      setIdentify(r);
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  async function hideCodes() {
    try {
      const r = await sendJson<{ hidden: number }>("/api/signage/identify/off", "POST");
      setIdentify(null);
      setMsg(`Codes hidden on ${r.hidden} screen${r.hidden === 1 ? "" : "s"}.`);
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  async function dismiss(f: SignageFoundPi, on: boolean) {
    try {
      await sendJson(`/api/signage/discovery/found/${f.id}/${on ? "dismiss" : "undismiss"}`, "POST");
      void load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (forbidden) return <Forbidden />;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <PageTitle icon={Cpu}>Devices</PageTitle>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">The Raspberry Pis behind the screens. The dashboard reaches each one over SSH with its own key; nothing on a Pi listens for the dashboard.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={finderOpen ? primaryCls : btnCls} aria-expanded={finderOpen} aria-controls="signage-find-pis" onClick={() => setFinderChoice(!finderOpen)}>
            <Radar className="h-4 w-4" aria-hidden /> Find Pis
          </button>
          <button type="button" className={btnCls} disabled={selected.size === 0} onClick={() => void runIdentify(false)}>
            <ScanEye className="h-4 w-4" aria-hidden /> Identify selected ({selected.size})
          </button>
          <button type="button" className={btnCls} disabled={all.length === 0} onClick={() => void runIdentify(true)}>
            Identify all
          </button>
        </div>
      </div>
      <ErrorLine text={err} />
      {msg ? <p className="text-sm text-emerald-700 dark:text-emerald-300">{msg}</p> : null}
      {identify ? <IdentifyPanel result={identify} onHide={() => void hideCodes()} onClose={() => setIdentify(null)} /> : null}
      {finderOpen ? (
        <div id="signage-find-pis">
          <Discovery onChanged={() => void load()} />
        </div>
      ) : null}

      <div role="tablist" aria-label="Which devices" className="flex flex-wrap gap-1 border-b border-slate-300 text-sm dark:border-slate-800">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => pickTab(t.id)}
            className={`mb-[-1px] min-h-[32px] border-b-2 px-3 py-1.5 ${tab === t.id ? "border-brand-600 text-brand-700 dark:text-brand-300" : "border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"}`}
          >
            {t.label} <span className="text-xs">({counts[t.id]})</span>
          </button>
        ))}
      </div>

      {tab === "groups" ? (
        <GroupsPanel
          groups={groups.data}
          screens={screens.data ?? []}
          canWrite={perms.write}
          canAssign={perms.admin}
          onChanged={() => {
            void groups.reload();
            void screens.reload();
          }}
        />
      ) : tab === "found" ? (
        <div className="space-y-6">
          <section aria-labelledby="found-h" className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="found-h" className="text-base font-semibold text-slate-900 dark:text-slate-100">
                Pis found
              </h2>
              <label className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                <input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} /> Show dismissed
              </label>
            </div>
            {found === null ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
            ) : (
              <FoundList rows={(found ?? []).filter((f) => !f.knownDeviceId && isLikelyPi(f.evidence) && (showDismissed || !f.dismissed))} onSetup={setSetupFor} onCode={setCodeFor} onDismiss={dismiss} />
            )}
          </section>
          {(() => {
            const others = (found ?? []).filter((f) => !f.knownDeviceId && !isLikelyPi(f.evidence) && (showDismissed || !f.dismissed));
            if (!others.length) return null;
            return (
              <details className="rounded-md border border-slate-300 p-3 dark:border-slate-800">
                <summary className="cursor-pointer text-sm font-medium text-slate-800 dark:text-slate-100">
                  Other SSH hosts ({others.length}) <span className="font-normal text-slate-500 dark:text-slate-400">answered on port 22 but nothing says they are Raspberry Pis</span>
                </summary>
                <p className="my-2 text-sm text-slate-600 dark:text-slate-300">
                  Servers, VMs and other equipment show up here. If a Pi is among them (for example one on a USB network adapter), set it up from here; the rest can be dismissed.
                </p>
                <FoundList rows={others} onSetup={setSetupFor} onCode={setCodeFor} onDismiss={dismiss} />
              </details>
            );
          })()}
        </div>
      ) : devices === null ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 p-6 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300">
          {tab === "attention" ? "Every device is fine." : tab === "disabled" ? "No device is switched off." : "No devices yet. Use Find Pis to scan a subnet or type in addresses, then adopt what turns up on the Found tab."}
        </p>
      ) : (
        <DeviceTable
          rows={rows}
          selected={selected}
          onToggle={(id) =>
            setSelected((s) => {
              const n = new Set(s);
              if (n.has(id)) n.delete(id);
              else n.add(id);
              return n;
            })
          }
        />
      )}

      {setupFor ? (
        <SetupModal
          found={setupFor}
          device={null}
          screens={screens.data ?? []}
          onClose={() => setSetupFor(null)}
          onDone={() => {
            setSetupFor(null);
            void load();
            void screens.reload();
          }}
        />
      ) : null}
      {codeFor ? <ShowCodeModal found={codeFor} onClose={() => setCodeFor(null)} /> : null}
    </div>
  );
}

function DeviceTable({ rows, selected, onToggle }: { rows: SignageDevice[]; selected: Set<string>; onToggle: (id: string) => void }) {
  return (
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Devices">
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-slate-500 dark:text-slate-400">
          <tr>
            <th className="px-2 py-2">
              <span className="sr-only">Select</span>
            </th>
            <th className="px-2 py-2">Device</th>
            <th className="px-2 py-2">Screen</th>
            <th className="px-2 py-2">Address</th>
            <th className="px-2 py-2">State</th>
            <th className="px-2 py-2">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id} className="border-t border-slate-200 align-top dark:border-slate-800">
              <td className="px-2 py-2">
                <input type="checkbox" className="h-4 w-4" checked={selected.has(d.id)} onChange={() => onToggle(d.id)} aria-label={`Select ${d.name}`} />
              </td>
              <td className="px-2 py-2">
                <Link href={`/signage/devices/${d.id}`} className="font-medium text-brand-600 hover:underline dark:text-brand-400">
                  {d.name}
                </Link>
                <p className="text-xs text-slate-500 dark:text-slate-400">{[d.model, d.agentVersion ? `agent ${d.agentVersion}` : null].filter(Boolean).join(" · ")}</p>
              </td>
              <td className="px-2 py-2">{d.screenId ? <Link href={`/signage/screens/${d.screenId}`} className="text-brand-600 hover:underline dark:text-brand-400">{d.screenName}</Link> : <span className="text-slate-500 dark:text-slate-400">none</span>}</td>
              <td className="px-2 py-2 font-mono text-xs">{d.ip}</td>
              <td className="px-2 py-2">
                <p className={d.online ? "text-emerald-700 dark:text-emerald-300" : "text-slate-600 dark:text-slate-300"}>
                  {!d.enabled ? "Switched off" : d.status === "setting_up" ? "Adopting" : d.status === "resetting" ? "Being reset" : d.status === "failed" ? (d.lastError?.startsWith(FORGET_FAILED_PREFIX) ? "Reset failed" : "Adoption failed") : d.online ? "Online" : "Offline"}
                </p>
                <ProblemBadges problems={d.problems} />
              </td>
              <td className="px-2 py-2 text-slate-600 dark:text-slate-300">{ago(d.lastSeenAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FoundList({ rows, onSetup, onCode, onDismiss }: { rows: SignageFoundPi[]; onSetup: (f: SignageFoundPi) => void; onCode: (f: SignageFoundPi) => void; onDismiss: (f: SignageFoundPi, on: boolean) => void }) {
  if (!rows.length) return <p className="rounded-md border border-dashed border-slate-300 p-6 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300">No Pis waiting. Use Find Pis to scan a subnet or add addresses.</p>;
  return (
    <ul className="space-y-2">
      {rows.map((f) => (
        <li key={f.id} className={`flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 ${f.isNew ? "border-amber-400 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40" : "border-slate-300 dark:border-slate-800"}`}>
          <div>
            <p className="font-medium text-slate-900 dark:text-slate-100">
              <span className="font-mono">{f.ip}</span>
              {f.name ? ` · ${f.name}` : ""}
              {f.isNew ? <span className="ml-2 rounded bg-amber-200 px-1.5 py-0.5 text-xs text-amber-900 dark:bg-amber-800 dark:text-amber-100">New</span> : null}
              {f.dismissed ? <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">(dismissed)</span> : null}
            </p>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {f.evidenceText}
              {f.mac ? ` · ${f.mac}` : ""} · first seen {ago(f.firstSeenAt)}, last {ago(f.lastSeenAt)}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {f.dismissed ? (
              <button type="button" className={btnCls} onClick={() => onDismiss(f, false)} aria-label={`Bring back ${f.ip}`}>
                Bring back
              </button>
            ) : (
              <>
                <button type="button" className={btnCls} onClick={() => onCode(f)} aria-label={`Show a code on ${f.ip}`}>
                  Show a code
                </button>
                <button type="button" className={btnCls} onClick={() => onDismiss(f, true)} aria-label={`Dismiss ${f.ip}`}>
                  Dismiss
                </button>
                <button type="button" className={primaryCls} onClick={() => onSetup(f)} aria-label={`Adopt ${f.ip}`}>
                  Adopt
                </button>
              </>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Subnets to look in (once, or continuously) and addresses typed by hand. */
function Discovery({ onChanged }: { onChanged: () => void }) {
  const id = useId();
  const subnets = useSignageJson<SignageDiscoverySubnet[]>("discovery/subnets");
  const [cidr, setCidr] = useState("");
  const [label, setLabel] = useState("");
  const [continuous, setContinuous] = useState(true);
  const [interval, setIntervalMin] = useState(60);
  const [ips, setIps] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function act<T>(key: string, fn: () => Promise<T>, done: (r: T) => string) {
    setBusy(key);
    setErr(null);
    setMsg(null);
    try {
      const r = await fn();
      setMsg(done(r));
      void subnets.reload();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const foundText = (r: { found: number; newFound: number; other?: number }) =>
    `Found ${r.found} Pi${r.found === 1 ? "" : "s"}, ${r.newFound} new.${r.other ? ` ${r.other} other SSH host${r.other === 1 ? "" : "s"} listed separately.` : ""}`;

  return (
    <section aria-labelledby={`${id}-h`} className="space-y-4 rounded-md border border-slate-300 p-4 dark:border-slate-800">
      <h2 id={`${id}-h`} className="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100">
        <Radar className="h-4 w-4" aria-hidden /> Finding Pis
      </h2>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        A scan knocks on port 22 across a subnet and looks for Raspberry Pi network cards, the setup banner or a Debian SSH server. It never signs in. A continuous subnet is scanned on its own and newly seen Pis are marked New.
      </p>
      {subnets.data?.length ? (
        <ul className="space-y-2">
          {subnets.data.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-slate-50 p-2 text-sm dark:bg-slate-900">
              <span>
                <span className="font-mono">{s.cidr}</span>
                {s.label ? ` · ${s.label}` : ""} · {s.continuous ? `every ${s.intervalMin} min` : "by hand"} · last {ago(s.lastRunAt)}
                {s.lastFound !== null ? `, ${s.lastFound} found` : ""}
                {s.running ? " · scanning…" : ""}
              </span>
              <span className="flex gap-2">
                <button
                  type="button"
                  className={btnCls}
                  onClick={() => void act(`c${s.id}`, () => sendJson(`/api/signage/discovery/subnets/${s.id}`, "PATCH", { continuous: !s.continuous }), () => (s.continuous ? "Continuous scanning off." : "Continuous scanning on."))}
                >
                  {s.continuous ? "Stop scanning by itself" : "Scan by itself"}
                </button>
                <button type="button" className={btnCls} disabled={busy !== null || s.running} onClick={() => void act(`s${s.id}`, () => sendJson<{ found: number; newFound: number; other?: number }>(`/api/signage/discovery/subnets/${s.id}/scan`, "POST"), foundText)}>
                  {busy === `s${s.id}` ? "Scanning…" : "Scan now"}
                </button>
                <button
                  type="button"
                  className={dangerCls}
                  aria-label={`Remove ${s.cidr}`}
                  onClick={() => {
                    if (window.confirm(`Stop looking in ${s.cidr}?`)) void act(`d${s.id}`, () => sendJson(`/api/signage/discovery/subnets/${s.id}`, "DELETE"), () => `${s.cidr} removed.`);
                  }}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          void act("add", () => sendJson("/api/signage/discovery/subnets", "POST", { cidr: cidr.trim(), label: label.trim(), continuous, intervalMin: interval }), () => {
            setCidr("");
            setLabel("");
            return "Subnet added.";
          });
        }}
      >
        <div>
          <Label htmlFor={`${id}-c`}>Subnet</Label>
          <input id={`${id}-c`} className={inputCls} value={cidr} onChange={(e) => setCidr(e.target.value)} placeholder="10.20.30.0/24" required />
        </div>
        <div>
          <Label htmlFor={`${id}-l`}>Label (optional)</Label>
          <input id={`${id}-l`} className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="TV VLAN" />
        </div>
        <div>
          <Label htmlFor={`${id}-i`}>Every (min)</Label>
          <input id={`${id}-i`} type="number" min={15} max={1440} className={inputCls} value={interval} onChange={(e) => setIntervalMin(Number(e.target.value) || 60)} disabled={!continuous} />
        </div>
        <div className="flex items-end gap-2">
          <label className="inline-flex min-h-[32px] items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
            <input type="checkbox" checked={continuous} onChange={(e) => setContinuous(e.target.checked)} /> By itself
          </label>
          <button type="submit" className={primaryCls} disabled={busy !== null}>
            Add
          </button>
          <button
            type="button"
            className={btnCls}
            disabled={busy !== null || !cidr.trim()}
            onClick={() => void act("once", () => sendJson<{ found: number; newFound: number; other?: number }>("/api/signage/discovery/scan", "POST", { cidr: cidr.trim() }), foundText)}
          >
            {busy === "once" ? "Scanning…" : "Scan once"}
          </button>
        </div>
      </form>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          const list = ips.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
          void act("ips", () => sendJson<{ found: number; newFound: number; other?: number; unreachable: string[] }>("/api/signage/discovery/ips", "POST", { ips: list }), (r) => {
            setIps("");
            return `${foundText(r)}${r.unreachable.length ? ` No answer from ${r.unreachable.join(", ")}.` : ""}`;
          });
        }}
      >
        <Label htmlFor={`${id}-ips`} hint="Separated by spaces, commas or new lines.">
          Or add addresses
        </Label>
        <div className="flex gap-2">
          <input id={`${id}-ips`} className={inputCls} value={ips} onChange={(e) => setIps(e.target.value)} placeholder="10.20.30.41 10.20.30.42" />
          <button type="submit" className={btnCls} disabled={busy !== null || !ips.trim()}>
            {busy === "ips" ? "Looking…" : "Look"}
          </button>
        </div>
      </form>
      <ErrorLine text={err} />
      {msg ? <p className="text-sm text-emerald-700 dark:text-emerald-300">{msg}</p> : null}
    </section>
  );
}

function IdentifyPanel({ result, onHide, onClose }: { result: SignageIdentifyResult; onHide: () => void; onClose: () => void }) {
  return (
    <Modal title="Codes on the screens" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600 dark:text-slate-300">Each TV shows its code until {new Date(result.until).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}.</p>
        <ul className="grid gap-2 sm:grid-cols-2">
          {result.devices.map((d) => (
            <li key={d.deviceId} className="rounded-md border border-slate-300 p-2 dark:border-slate-800">
              <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{d.name}</p>
              {d.code ? <p className="font-mono text-3xl font-bold tracking-widest text-slate-900 dark:text-slate-100">{d.code}</p> : <p className="text-sm text-rose-700 dark:text-rose-300">{d.error ?? "Not reached"}</p>}
              <p className="font-mono text-xs text-slate-500 dark:text-slate-400">{d.ip}</p>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <button type="button" className={btnCls} onClick={onHide}>
            Hide codes now
          </button>
          <button type="button" className={primaryCls} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
