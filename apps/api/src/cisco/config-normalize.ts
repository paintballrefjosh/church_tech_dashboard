import { createHash } from "node:crypto";
import { stripAnsi } from "./ssh";

const VOLATILE = [
  /^Last configuration change at/i,
  /^NVRAM config last updated/i,
  /^Building configuration/i,
  /^Current configuration/i,
  /^!Time:/i,
  /^!Running configuration last done at:/i,
  /^ntp clock-period/i,
];

/**
 * Reduce a captured running-config to what is worth comparing. Comments,
 * prompt echoes, volatile header lines and blank lines are dropped, and
 * trailing whitespace is trimmed: some switches (Small Business style) pad
 * sections with blank lines that come and go between captures, which used to
 * read as a config change.
 */
export function normalizeConfig(raw: string): string {
  return stripAnsi(raw)
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => {
      const t = l.trim();
      if (t === "") return false;
      if (t.startsWith("!")) return false;
      if (/^[A-Za-z0-9][\w.-]*#\s*/.test(t)) return false; // prompt echoes
      return !VOLATILE.some((re) => re.test(t));
    })
    .join("\n")
    .trim();
}

export function configChecksum(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex");
}
