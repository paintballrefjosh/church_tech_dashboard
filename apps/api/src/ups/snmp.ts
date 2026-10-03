import * as snmp from "net-snmp";
import type { UpsStatus, UpsBatteryState, UpsOutputSource } from "@church/shared";

// UPS-MIB (RFC 1628) OIDs. Scalars are walked at their base OID (the agent
// returns the single `.0` leaf), tables are walked and reduced.
const OID_BATTERY_STATUS = "1.3.6.1.2.1.33.1.2.1"; // upsBatteryStatus (1..4)
const OID_MINUTES_REMAINING = "1.3.6.1.2.1.33.1.2.3"; // upsEstimatedMinutesRemaining
const OID_CHARGE_REMAINING = "1.3.6.1.2.1.33.1.2.4"; // upsEstimatedChargeRemaining (%)
const OID_OUTPUT_SOURCE = "1.3.6.1.2.1.33.1.4.1"; // upsOutputSource
const OID_INPUT_VOLTAGE = "1.3.6.1.2.1.33.1.3.3.1.3"; // upsInputVoltage (RMS V, per line)
const OID_OUTPUT_VOLTAGE = "1.3.6.1.2.1.33.1.4.4.1.2"; // upsOutputVoltage (RMS V, per line)
const OID_OUTPUT_LOAD = "1.3.6.1.2.1.33.1.4.4.1.5"; // upsOutputPercentLoad (per line)

// upsBatteryStatus enum: 1 unknown, 2 batteryNormal, 3 batteryLow, 4 batteryDepleted.
function batteryStateFromEnum(v: number): UpsBatteryState {
  if (v === 2) return "normal";
  if (v === 3) return "low";
  if (v === 4) return "depleted";
  return "unknown";
}

// upsOutputSource enum: 1 other, 2 none, 3 normal, 4 bypass, 5 battery, 6 booster, 7 reducer.
function outputSourceFromEnum(v: number): UpsOutputSource {
  if (v === 3) return "normal";
  if (v === 5) return "battery";
  if (v === 4) return "bypass";
  if (v === 6 || v === 7) return "other";
  return "unknown";
}

export interface SnmpUpsOptions {
  host: string;
  port: number;
  version: "v1" | "v2c";
  community: string;
  timeoutMs: number;
}

export interface SnmpUpsResult {
  status: UpsStatus;
  error?: string;
  batteryPct: number | null;
  runtimeMin: number | null;
  loadPct: number | null;
  inputVoltage: number | null;
  outputVoltage: number | null;
  batteryState: UpsBatteryState;
  outputSource: UpsOutputSource;
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
 * Poll a UPS over SNMP (UPS-MIB / RFC 1628) and return a normalised snapshot.
 * Mirrors the printers SNMP probe: network failures (timeout, unreachable,
 * wrong community) come back as `status: "unknown"` with `error` set, never
 * throw.
 */
export async function probeUpsSnmp(opts: SnmpUpsOptions): Promise<SnmpUpsResult> {
  const sess = createSession(opts);
  try {
    const [battStatus, minutes, charge, outSource, inVolts, outVolts, load] = await Promise.all([
      walkMap(sess, OID_BATTERY_STATUS),
      walkMap(sess, OID_MINUTES_REMAINING),
      walkMap(sess, OID_CHARGE_REMAINING),
      walkMap(sess, OID_OUTPUT_SOURCE),
      walkMap(sess, OID_INPUT_VOLTAGE),
      walkMap(sess, OID_OUTPUT_VOLTAGE),
      walkMap(sess, OID_OUTPUT_LOAD),
    ]);

    const batteryState = batteryStateFromEnum(firstNumber(battStatus) ?? 1);
    const outputSource = outputSourceFromEnum(firstNumber(outSource) ?? 1);
    const batteryPct = firstNumber(charge);
    const runtimeMin = firstNumber(minutes);
    const inputVoltage = firstNumber(inVolts);
    const outputVoltage = firstNumber(outVolts);
    const loadPct = maxNumber(load);

    const anyData =
      battStatus.size > 0 ||
      minutes.size > 0 ||
      charge.size > 0 ||
      outSource.size > 0 ||
      load.size > 0;
    if (!anyData) {
      return {
        status: "unknown",
        error: "no UPS-MIB data returned (wrong community or non-UPS device?)",
        batteryPct: null,
        runtimeMin: null,
        loadPct: null,
        inputVoltage: null,
        outputVoltage: null,
        batteryState: "unknown",
        outputSource: "unknown",
      };
    }

    const status = computeStatus({ batteryState, outputSource, batteryPct, runtimeMin });
    return {
      status,
      batteryPct,
      runtimeMin,
      loadPct,
      inputVoltage,
      outputVoltage,
      batteryState,
      outputSource,
    };
  } catch (err) {
    return {
      status: "unknown",
      error: (err as Error).message || String(err),
      batteryPct: null,
      runtimeMin: null,
      loadPct: null,
      inputVoltage: null,
      outputVoltage: null,
      batteryState: "unknown",
      outputSource: "unknown",
    };
  } finally {
    try {
      sess.close();
    } catch {
      // best-effort
    }
  }
}

function createSession(opts: SnmpUpsOptions): SnmpSession {
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
          if (vb.value == null) continue; // noSuchObject/Instance
          const suffix = vb.oid.startsWith(baseOid + ".") ? vb.oid.slice(baseOid.length + 1) : vb.oid;
          out.set(suffix, vb.value);
        }
      },
      (err) => (err ? reject(err) : resolve(out)),
    );
  });
}

function numberFrom(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && /^-?\d+$/.test(v)) return parseInt(v, 10);
  if (Buffer.isBuffer(v)) {
    const n = Number(v.toString("utf-8"));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function firstNumber(map: Map<string, unknown>): number | null {
  for (const v of map.values()) {
    const n = numberFrom(v);
    if (n !== null) return n;
  }
  return null;
}

function maxNumber(map: Map<string, unknown>): number | null {
  let max: number | null = null;
  for (const v of map.values()) {
    const n = numberFrom(v);
    if (n !== null && (max === null || n > max)) max = n;
  }
  return max;
}

function computeStatus(args: {
  batteryState: UpsBatteryState;
  outputSource: UpsOutputSource;
  batteryPct: number | null;
  runtimeMin: number | null;
}): UpsStatus {
  // Red: battery critically depleted, near-empty charge, or minutes of runtime left.
  if (args.batteryState === "depleted") return "red";
  if (args.batteryPct !== null && args.batteryPct <= 20) return "red";
  if (args.runtimeMin !== null && args.runtimeMin <= 5) return "red";
  // Yellow: running on battery / bypass, low battery, or a modest charge dip.
  if (args.outputSource === "battery" || args.outputSource === "bypass") return "yellow";
  if (args.batteryState === "low") return "yellow";
  if (args.batteryPct !== null && args.batteryPct < 50) return "yellow";
  return "green";
}
