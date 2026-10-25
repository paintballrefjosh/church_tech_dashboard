import { z } from "zod";

/**
 * Guest Wi-Fi vouchers on the UniFi controller's hotspot (the guest portal must use "Voucher" authentication). A voucher
 * is a code a guest types once on the portal; it lasts `minutes` from first use and may be used by `uses` devices
 * (0 = any number). Speed and data limits are optional.
 */
export const createUnifiVouchersSchema = z
  .object({
    count: z.number().int().min(1).max(100),
    /** How long a voucher lasts once used: 30 minutes to a year. */
    minutes: z.number().int().min(30).max(525_600),
    /** Devices per voucher; 0 = unlimited. */
    uses: z.number().int().min(0).max(100).default(1),
    note: z.string().trim().max(100).default(""),
    downKbps: z.number().int().min(64).max(1_000_000).optional(),
    upKbps: z.number().int().min(64).max(1_000_000).optional(),
    megabytes: z.number().int().min(1).max(1_000_000).optional(),
  })
  .strict();
export type CreateUnifiVouchersInput = z.infer<typeof createUnifiVouchersSchema>;

export interface UnifiVoucher {
  id: string;
  /** As printed on the card, e.g. 12345-67890. */
  code: string;
  note: string;
  createdAt: string;
  minutes: number;
  uses: number;
  used: number;
  /** The controller's word: VALID_ONE, VALID_MULTI, USED_MULTIPLE, EXPIRED ... */
  status: string;
  expiresAt: string | null;
  downKbps: number | null;
  upKbps: number | null;
  megabytes: number | null;
}

/** "4 hours", "2 days", "1 week" for a voucher's length. */
export function describeVoucherMinutes(minutes: number): string {
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (minutes % 10_080 === 0) return plural(minutes / 10_080, "week");
  if (minutes % 1_440 === 0) return plural(minutes / 1_440, "day");
  if (minutes % 60 === 0) return plural(minutes / 60, "hour");
  return plural(minutes, "minute");
}
