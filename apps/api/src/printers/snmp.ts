import * as snmp from "net-snmp";
import type {
  PrinterStatus,
  PrinterSupply,
  PrinterInput,
  PrinterAlert,
  Colorant,
} from "@church/shared";

// Printer-MIB OIDs (RFC 3805) we walk on each poll.
const OID_HR_DEVICE_STATUS = "1.3.6.1.2.1.25.3.2.1.5"; // overall device state
const OID_SUPPLY_DESC = "1.3.6.1.2.1.43.11.1.1.6"; // prtMarkerSuppliesDescription
const OID_SUPPLY_MAX = "1.3.6.1.2.1.43.11.1.1.8"; // prtMarkerSuppliesMaxCapacity
const OID_SUPPLY_LEVEL = "1.3.6.1.2.1.43.11.1.1.9"; // prtMarkerSuppliesLevel
const OID_INPUT_MAX = "1.3.6.1.2.1.43.8.2.1.9"; // prtInputMaxCapacity
const OID_INPUT_LEVEL = "1.3.6.1.2.1.43.8.2.1.10"; // prtInputCurrentLevel
const OID_INPUT_NAME = "1.3.6.1.2.1.43.8.2.1.13"; // prtInputName
const OID_ALERT_SEVERITY = "1.3.6.1.2.1.43.18.1.1.2"; // prtAlertSeverityLevel
const OID_ALERT_DESC = "1.3.6.1.2.1.43.18.1.1.8"; // prtAlertDescription

// hrDeviceStatus enum (1=unknown, 2=running, 3=warning, 4=testing, 5=down).
const DEVICE_OK = new Set([2, 4]);
const DEVICE_WARNING = new Set([3]);
const DEVICE_DOWN = new Set([5]);

// prtAlertSeverityLevel enum (1=other, 3=critical, 4=warning).
function severityFromAlertEnum(v: number): "critical" | "warning" | "info" {
  if (v === 3) return "critical";
  if (v === 4) return "warning";
  return "info";
}

export interface SnmpProbeOptions {
  host: string;
  port: number;
  version: "v1" | "v2c";
  community: string;
  timeoutMs: number;
}

export interface SnmpProbeResult {
  status: PrinterStatus;
  error?: string;
  supplies: PrinterSupply[];
  inputs: PrinterInput[];
  alerts: PrinterAlert[];
}

interface VarBind {
  oid: string;
  value: unknown;
}

type SnmpSession = {
  subtree(
    oid: string,
    feedCb: (varbinds: VarBind[]) => void,
    doneCb: (error?: Error | null) => void,
  ): void;
  close(): void;
};

/**
 * Poll a printer over SNMP and return a normalised snapshot. Network failures
 * (timeout, unreachable, wrong community) come back as `status: "red"` with
 * `error` set, never throw.
 */
export async function probePrinterSnmp(
  opts: SnmpProbeOptions,
): Promise<SnmpProbeResult> {
  const sess = createSession(opts);
  try {
    const [hrStatus, supplyDescs, supplyMaxes, supplyLevels, inputNames, inputMaxes, inputLevels, alertSevs, alertDescs] =
      await Promise.all([
        walkOne(sess, OID_HR_DEVICE_STATUS),
        walkMap(sess, OID_SUPPLY_DESC),
        walkMap(sess, OID_SUPPLY_MAX),
        walkMap(sess, OID_SUPPLY_LEVEL),
        walkMap(sess, OID_INPUT_NAME),
        walkMap(sess, OID_INPUT_MAX),
        walkMap(sess, OID_INPUT_LEVEL),
        walkMap(sess, OID_ALERT_SEVERITY),
        walkMap(sess, OID_ALERT_DESC),
      ]);

    // Build supplies: one entry per supply index. Drop entries with no
    // description or zero/negative max (those indices are reserved).
    const supplies: PrinterSupply[] = [];
    for (const [idx, descRaw] of supplyDescs) {
      const max = numberFrom(supplyMaxes.get(idx));
      const level = numberFrom(supplyLevels.get(idx));
      if (max <= 0) continue;
      const description = stringFrom(descRaw);
      supplies.push({
        name: description || `Supply ${idx}`,
        colorant: colorantFromDescription(description),
        level: clampLevel(level),
        max,
        percent: percentOf(level, max),
      });
    }

    // Build inputs (paper trays).
    const inputs: PrinterInput[] = [];
    for (const [idx, nameRaw] of inputNames) {
      const max = numberFrom(inputMaxes.get(idx));
      const level = numberFrom(inputLevels.get(idx));
      if (max <= 0) continue;
      inputs.push({
        name: stringFrom(nameRaw) || `Tray ${idx}`,
        level: clampLevel(level),
        max,
        percent: percentOf(level, max),
      });
    }

    // Build alerts: pair severity + description by alert index.
    const alerts: PrinterAlert[] = [];
    for (const [idx, sevRaw] of alertSevs) {
      const sev = severityFromAlertEnum(numberFrom(sevRaw));
      const desc = stringFrom(alertDescs.get(idx));
      alerts.push({ severity: sev, description: desc || `Alert ${idx}` });
    }

    // Status computation.
    const deviceStatus = numberFrom(Array.from(hrStatus.values())[0]);
    const status = computeStatus({ deviceStatus, supplies, inputs, alerts });

    return { status, supplies, inputs, alerts };
  } catch (err) {
    return {
      status: "red",
      error: (err as Error).message || String(err),
      supplies: [],
      inputs: [],
      alerts: [],
    };
  } finally {
    try {
      sess.close();
    } catch {
      // best-effort
    }
  }
}

function createSession(opts: SnmpProbeOptions): SnmpSession {
  const version = opts.version === "v1" ? snmp.Version1 : snmp.Version2c;
  return snmp.createSession(opts.host, opts.community, {
    port: opts.port,
    version,
    timeout: opts.timeoutMs,
    retries: 1,
  }) as SnmpSession;
}

/** Walk a subtree and return a Map keyed by the trailing OID index. */
function walkMap(sess: SnmpSession, baseOid: string): Promise<Map<string, unknown>> {
  return new Promise((resolve, reject) => {
    const out = new Map<string, unknown>();
    sess.subtree(
      baseOid,
      (varbinds) => {
        for (const vb of varbinds) {
          if (snmpIsError(vb)) continue;
          const suffix = vb.oid.startsWith(baseOid + ".")
            ? vb.oid.slice(baseOid.length + 1)
            : vb.oid;
          out.set(suffix, vb.value);
        }
      },
      (err) => (err ? reject(err) : resolve(out)),
    );
  });
}

/** Walk a single-value OID (or scalar). Same shape as walkMap. */
function walkOne(sess: SnmpSession, oid: string): Promise<Map<string, unknown>> {
  return walkMap(sess, oid);
}

function snmpIsError(vb: VarBind): boolean {
  // net-snmp surfaces noSuchObject/noSuchInstance as a VarBind with a special
  // `type`. Easiest check is on the value itself — null/undefined never appear
  // in normal data, so we treat them as non-data.
  return vb.value == null;
}

function numberFrom(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && /^-?\d+$/.test(v)) return parseInt(v, 10);
  if (Buffer.isBuffer(v)) return Number(v.toString("utf-8")) || 0;
  return 0;
}

function stringFrom(v: unknown): string {
  if (typeof v === "string") return v;
  if (Buffer.isBuffer(v)) return v.toString("utf-8");
  if (v == null) return "";
  return String(v);
}

function clampLevel(n: number): number {
  // Printer-MIB convention: -3 = unknown, -2 = some, -1 = atLeastOne, 0 = empty.
  // Anything negative we treat as "unknown" and surface as 0 for the percent
  // calc but keep the raw value so the UI can show "n/a" if it cares.
  return n < 0 ? 0 : n;
}

function percentOf(level: number, max: number): number {
  if (max <= 0 || level < 0) return 0;
  return Math.max(0, Math.min(100, Math.round((level / max) * 100)));
}

function colorantFromDescription(desc: string): Colorant {
  const d = desc.toLowerCase();
  if (d.includes("cyan")) return "cyan";
  if (d.includes("magenta")) return "magenta";
  if (d.includes("yellow")) return "yellow";
  if (d.includes("black") || d.includes("ł") /* matte */) return "black";
  return "other";
}

function computeStatus(args: {
  deviceStatus: number;
  supplies: PrinterSupply[];
  inputs: PrinterInput[];
  alerts: PrinterAlert[];
}): PrinterStatus {
  if (DEVICE_DOWN.has(args.deviceStatus)) return "red";
  if (args.alerts.some((a) => a.severity === "critical")) return "red";
  if (args.inputs.some((t) => t.percent === 0 && t.max > 0)) return "red";
  if (
    DEVICE_WARNING.has(args.deviceStatus) ||
    args.alerts.some((a) => a.severity === "warning") ||
    args.supplies.some((s) => s.percent < 10) ||
    args.inputs.some((t) => t.percent < 10)
  ) {
    return "yellow";
  }
  if (DEVICE_OK.has(args.deviceStatus)) return "green";
  // hrDeviceStatus = unknown(1) and we got data back → assume green.
  return args.supplies.length || args.inputs.length ? "green" : "unknown";
}
