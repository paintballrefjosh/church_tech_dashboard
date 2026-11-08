"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { durationText, type AreaKey, type HomeSnapshot, type SystemMeters, type SystemsHealth } from "@lampstand/shared";
import { NeedActionButton } from "../../parts/need-action";
import { alertWhen } from "./format";
import s from "./front-of-house.module.css";

type Area = SystemsHealth["areas"][number];
type Problem = SystemsHealth["problems"][number];
type Channel = SystemMeters["channels"][number];

/** Segments in a meter: green up to 70%, amber up to 90%, red above. */
const SEGMENTS = 22;

const READING_LABELS: Record<AreaKey, [string, string]> = {
  servers: ["avg CPU", "memory"],
  internet: ["latency", "monitors"],
  wifi: ["clients", "devices online"],
  switches: ["ports up", "config drift"],
  dns: ["queries/min", "sync"],
  services: ["services up", "groups"],
  screens: ["screens playing", "notices now"],
};

/** How far a resting meter wanders either side of its real reading, as a share of full scale (the mockup's "meter at rest"). */
const WANDER = 0.05;
const WANDER_MS = 700;
/** A peak marker holds for this many ticks before it falls to the bar. */
const PEAK_HOLD_TICKS = 6;

/**
 * Lit segments and the peak-hold marker for one meter. The reading itself is exact (the numbers beside it and the
 * meter's aria value are the real ones); the bar only moves a little around it so the board looks alive, like a
 * meter at rest. A meter with no reading, one at zero, a hidden tab and a visitor who asked for less motion all stay still.
 */
function useMeterMotion(level: number | null): { lit: number; peak: number } {
  const real = level === null ? 0 : Math.round(level * SEGMENTS);
  const [state, setState] = useState({ lit: real, peak: real });
  const peakAge = useRef(0);
  useEffect(() => {
    setState({ lit: real, peak: real });
    peakAge.current = 0;
    if (level === null || level <= 0) return;
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Each meter starts at its own moment, so the board does not move in step.
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = setTimeout(
      () => {
        timer = setInterval(() => {
          if (document.visibilityState === "hidden") return;
          const wobbled = Math.min(1, Math.max(1 / SEGMENTS, level + (Math.random() - 0.5) * 2 * WANDER));
          const lit = Math.round(wobbled * SEGMENTS);
          setState((cur) => {
            let peak = cur.peak;
            if (lit >= peak || peakAge.current > PEAK_HOLD_TICKS) {
              peak = lit;
              peakAge.current = 0;
            } else {
              peakAge.current++;
            }
            return cur.lit === lit && cur.peak === peak ? cur : { lit, peak };
          });
        }, WANDER_MS);
      },
      Math.random() * WANDER_MS,
    );
    return () => {
      clearTimeout(start);
      if (timer) clearInterval(timer);
    };
  }, [level, real]);
  return state;
}

function LedMeter({ label, level, text }: { label: string; level: number | null; text: string }) {
  const { lit, peak } = useMeterMotion(level);
  const segs = Array.from({ length: SEGMENTS }, (_, i) => {
    const zone = i < SEGMENTS * 0.7 ? "g" : i < SEGMENTS * 0.9 ? "a" : "r";
    const isPeak = i === peak - 1 && i >= lit;
    return <i key={i} className={`${i < lit ? s.on : ""} ${isPeak ? s.peak : ""} ${s[zone]}`} />;
  });
  if (level === null) {
    return (
      <div className={`${s.meter} ${s.meterNone}`} role="img" aria-label={`${label}: reading unavailable`}>
        {segs}
      </div>
    );
  }
  return (
    <div
      className={s.meter}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(level * 100)}
      aria-valuetext={text}
    >
      {segs}
    </div>
  );
}

interface StateText {
  led: string | undefined;
  text: string;
  bad: boolean;
}

function stateFor(area: Area, problems: Problem[], now: Date): StateText {
  if (area.state === "unconfigured") return { led: s.ledOff, text: area.note ?? "Not set up", bad: false };
  if (area.state !== "ok") return { led: s.ledOff, text: area.note ?? "Unavailable", bad: false };
  const open = problems.filter((p) => !p.ack?.acked);
  if (open.length > 0) {
    const p = open[0]!;
    const since = p.since ? Date.parse(p.since) : NaN;
    const head = Number.isNaN(since) ? p.name : `${p.name}, ${durationText(now.getTime() - since)}`;
    return { led: s.ledR, bad: true, text: open.length > 1 ? `${head} and ${open.length - 1} more` : head };
  }
  if (problems.length > 0) {
    return { led: s.ledA, bad: false, text: `${problems[0]!.name}, acknowledged` };
  }
  if (area.down > 0) return { led: s.ledR, bad: true, text: `${area.down} down` };
  return { led: s.ledG, bad: false, text: "All up" };
}

function Strip({
  area,
  channel,
  problems,
  canWrite,
  meId,
  now,
  onChanged,
}: {
  area: Area;
  channel: Channel | undefined;
  problems: Problem[];
  canWrite: boolean;
  meId: string;
  now: Date;
  onChanged: () => void;
}) {
  const st = stateFor(area, problems, now);
  const readings =
    channel?.readings ?? READING_LABELS[area.key].map((label) => ({ label, value: "unavailable" }));
  const level = channel?.level ?? null;
  const ok = area.state === "ok";
  const unacked = problems.filter((p) => p.ack && !p.ack.acked);
  const hasProblem = st.bad;
  const text = readings.map((r) => `${r.label} ${r.value}`).join(", ");
  return (
    <section
      className={`${s.strip} ${hasProblem ? s.problem : ""}`}
      style={{ ["--c" as string]: `var(--ch-${area.key})` }}
      aria-labelledby={`foh-${area.key}`}
      data-testid={`foh-strip-${area.key}`}
    >
      <div className={s.scribble}>
        <h3 id={`foh-${area.key}`}>{area.label}</h3>
      </div>
      <div className={`${s.readout} ${s.num}`}>
        {ok ? (
          <span>
            {area.up}
            <small>/{area.total}</small>
            <span className={s.srOnly}> up</span>
          </span>
        ) : (
          <span>
            <small>-</small>
            <span className={s.srOnly}>no count</span>
          </span>
        )}
      </div>
      <div className={`${s.meterbox} ${s.screen}`}>
        <LedMeter label={`${area.label} level`} level={level} text={text} />
        <dl className={s.metric}>
          {readings.map((r) => (
            <div key={r.label}>
              <dt>{r.label}</dt>
              <dd className={s.num}>{r.value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className={`${s.state} ${st.bad ? s.stateBad : ""}`}>
        <span className={`${s.led} ${st.led}`} aria-hidden />
        <span>{st.text}</span>
      </div>
      <div className={s.btns}>
        <Link href={area.href} className={`${s.key} ${canWrite && unacked.length > 0 ? "" : s.full}`}>
          Open<span className={s.srOnly}> {area.label}</span>
        </Link>
        {canWrite
          ? unacked.map((p) =>
              p.ack ? (
                <NeedActionButton
                  key={p.id}
                  action={{
                    kind: "unifi_ack",
                    label: unacked.length > 1 ? `Ack ${p.name}` : "Ack",
                    mac: p.ack.mac,
                  }}
                  meId={meId}
                  onChanged={onChanged}
                  className={s.ackWrap}
                  buttonClassName={s.key}
                />
              ) : null,
            )
          : null}
      </div>
    </section>
  );
}

async function readMessage(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { message?: unknown };
    if (typeof j.message === "string") return j.message;
  } catch {
    /* not JSON */
  }
  return res.status === 403 ? "you do not have permission" : `the server answered ${res.status}`;
}

function MainStrip({
  snapshot,
  systems,
  meters,
  now,
  onChanged,
}: {
  snapshot: HomeSnapshot;
  systems: SystemsHealth;
  meters: HomeSnapshot["meters"];
  now: Date;
  onChanged: () => void;
}) {
  const [muted, setMuted] = useState(systems.maintenanceMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setMuted(systems.maintenanceMode);
  }, [systems.maintenanceMode]);

  const { totals } = systems;
  const problemCount = systems.problems.filter((p) => !p.ack?.acked).length;
  const ackedCount = systems.problems.length - problemCount;
  const lead =
    problemCount > 0
      ? problemCount === 1
        ? "One problem."
        : `${problemCount} problems.`
      : ackedCount > 0
        ? ackedCount === 1
          ? "1 problem, acknowledged."
          : `${ackedCount} problems, acknowledged.`
        : totals.down > 0
          ? `${totals.down} down.`
          : "Nothing is down.";
  const ledTone =
    totals.total === 0 ? s.ledOff : problemCount > 0 || (ackedCount === 0 && totals.down > 0) ? s.ledR : ackedCount > 0 ? s.ledA : s.ledG;
  const alerts = meters && meters.state === "ok" ? meters.data.recentAlerts : null;

  async function toggle() {
    const next = !muted;
    setMuted(next);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/monitors/maintenance", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) {
        setMuted(!next);
        setError(`Could not ${next ? "mute" : "unmute"} alerts: ${await readMessage(res)}.`);
      } else {
        onChanged();
      }
    } catch {
      setMuted(!next);
      setError(`Could not ${next ? "mute" : "unmute"} alerts: the server could not be reached.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`${s.strip} ${s.master}`} aria-labelledby="foh-everything" data-testid="foh-main-strip">
      <div className={s.scribble}>
        <h3 id="foh-everything">Everything</h3>
      </div>
      <div className={`${s.bigRow} ${s.num}`}>
        <span className={`${s.led} ${ledTone}`} aria-hidden />
        <span>
          {totals.up}
          <small>/{totals.total}</small>
          <span className={s.srOnly}> up</span>
        </span>
      </div>
      <p className={s.muteNote} role="status">
        {muted ? (
          <>
            <b>Maintenance mode:</b> problems are still recorded but nobody is emailed
            {systems.canWrite ? " until you unmute." : " until it is switched off."}
          </>
        ) : (
          <>
            {lead} <b>Alerts are on</b>, so the monitoring contacts are emailed if anything else drops.
          </>
        )}
      </p>
      <ul className={`${s.alog} ${s.screen} ${s.num}`} aria-label="Recent alerts">
        {alerts === null ? (
          <li>
            <span className={s.alogEmpty}>Alert log unavailable</span>
          </li>
        ) : alerts.length === 0 ? (
          <li>
            <span className={s.alogEmpty}>No alerts recently</span>
          </li>
        ) : (
          alerts.map((a, i) => {
            const at = new Date(a.at);
            return (
              <li key={`${a.at}-${i}`}>
                <time dateTime={a.at}>{alertWhen(at, now, snapshot.timezone)}</time>
                {a.href ? <Link href={a.href}>{a.title}</Link> : <span>{a.title}</span>}
              </li>
            );
          })
        )}
      </ul>
      {error ? (
        <p className={s.errorLine} role="alert">
          {error}
        </p>
      ) : null}
      <div className={s.btns}>
        {systems.canWrite ? (
          <button
            type="button"
            className={`${s.key} ${s.full} ${muted ? s.litRed : ""}`}
            aria-pressed={muted}
            disabled={busy}
            onClick={() => void toggle()}
          >
            {muted ? "Alerts muted" : "Mute alerts"}
          </button>
        ) : (
          <p className={`${s.muteNote} ${s.full}`}>{muted ? "Alerts are muted (read only)." : "Alerts are on (read only)."}</p>
        )}
        <Link href="/monitoring" className={`${s.key} ${s.full}`}>
          Open monitoring
        </Link>
      </div>
    </section>
  );
}

/** The channel bank: one strip per area the person can see, then the "Everything" strip. */
export function Bank({
  snapshot,
  meId,
  onChanged,
  tools,
}: {
  snapshot: HomeSnapshot;
  meId: string;
  onChanged: () => void;
  tools?: ReactNode;
}) {
  const now = new Date(snapshot.generatedAt);
  // Without the systems section there is no bank, but the look picker must stay reachable.
  if (snapshot.systems.state !== "ok") return tools ? <div className={s.bankTools}>{tools}</div> : null;
  const systems = snapshot.systems.data;
  const visible = systems.areas.filter((a) => a.state !== "forbidden");
  const meters = snapshot.meters;
  const channels = meters && meters.state === "ok" ? meters.data.channels : [];
  return (
    <>
      <div className={s.bankH}>
        <h2>Systems</h2>
        <div className={s.bankTools}>
          <p>Live levels, refreshed every 15 seconds</p>
          {tools}
        </div>
      </div>
      <div className={s.bankScroll}>
        <div className={s.bank} style={{ ["--n" as string]: visible.length }}>
          {visible.map((a) => (
            <Strip
              key={a.key}
              area={a}
              channel={channels.find((c) => c.area === a.key)}
              problems={systems.problems.filter((p) => p.area === a.key)}
              canWrite={systems.canWrite}
              meId={meId}
              now={now}
              onChanged={onChanged}
            />
          ))}
          <div className={s.spacer} aria-hidden />
          <MainStrip snapshot={snapshot} systems={systems} meters={meters} now={now} onChanged={onChanged} />
        </div>
      </div>
    </>
  );
}
