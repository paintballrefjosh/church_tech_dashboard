import { z } from "zod";
import { daysUntil, isoDateSchema } from "./renewal";
import type { LocationRef } from "./location";

/**
 * The asset inventory (docs/assets.md): equipment with a tag, a room, a status and a check-out. Dates are date-only strings on
 * the site's calendar, as renewals. The rules below are pure and unit-tested in apps/api/test/assets.test.ts.
 */

export const ASSET_CATEGORIES = ["audio", "video", "lighting", "computer", "network", "cable", "instrument", "furniture", "other"] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

export const ASSET_CATEGORY_LABELS: Record<AssetCategory, string> = {
  audio: "Audio",
  video: "Video and cameras",
  lighting: "Lighting",
  computer: "Computers and tablets",
  network: "Network",
  cable: "Cables and adapters",
  instrument: "Instruments",
  furniture: "Furniture and staging",
  other: "Other",
};

export const ASSET_STATUSES = ["in_service", "in_repair", "retired", "lost"] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const ASSET_STATUS_LABELS: Record<AssetStatus, string> = {
  in_service: "In service",
  in_repair: "In repair",
  retired: "Retired",
  lost: "Lost",
};

/** Letters, digits and `. _ - /`, starting with a letter or digit: what fits on a label and in a URL search. */
export const ASSET_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/;

/** The tag given to an item added without one: `A-0042`. */
export function formatAssetTag(n: number): string {
  return `A-${String(n).padStart(4, "0")}`;
}

const tagSchema = z.string().trim().max(40).regex(ASSET_TAG_PATTERN, "Letters, digits and . _ - / only, starting with a letter or digit");
const money = z.number().nonnegative().max(1_000_000_000);

const assetFields = {
  name: z.string().trim().min(1).max(200),
  category: z.enum(ASSET_CATEGORIES).default("other"),
  make: z.string().trim().max(120).default(""),
  model: z.string().trim().max(120).default(""),
  serial: z.string().trim().max(120).default(""),
  locationId: z.string().uuid().nullable().default(null),
  status: z.enum(ASSET_STATUSES).default("in_service"),
  /** Installed kit (a projector, the desk) is not checked out. */
  lendable: z.boolean().default(true),
  purchasedOn: isoDateSchema.nullable().default(null),
  cost: money.nullable().default(null),
  warrantyUntil: isoDateSchema.nullable().default(null),
  notes: z.string().max(4000).default(""),
};

export const createAssetSchema = z
  .object({
    /** Blank or missing = the next `A-0000` number. */
    tag: z.union([tagSchema, z.literal("")]).optional(),
    ...assetFields,
  })
  .strict();
export type CreateAssetInput = z.infer<typeof createAssetSchema>;

export const updateAssetSchema = z
  .object({
    tag: tagSchema.optional(),
    name: assetFields.name.optional(),
    category: z.enum(ASSET_CATEGORIES).optional(),
    make: z.string().trim().max(120).optional(),
    model: z.string().trim().max(120).optional(),
    serial: z.string().trim().max(120).optional(),
    locationId: z.string().uuid().nullable().optional(),
    status: z.enum(ASSET_STATUSES).optional(),
    lendable: z.boolean().optional(),
    purchasedOn: isoDateSchema.nullable().optional(),
    cost: money.nullable().optional(),
    warrantyUntil: isoDateSchema.nullable().optional(),
    notes: z.string().max(4000).optional(),
  })
  .strict();
export type UpdateAssetInput = z.infer<typeof updateAssetSchema>;

/**
 * Checking an item out. With neither holder field it goes to the person asking; `holderUserId` or `holderName` (someone with
 * no account) needs `assets:write:any`.
 */
export const checkoutAssetSchema = z
  .object({
    holderUserId: z.string().uuid().optional(),
    holderName: z.string().trim().min(1).max(120).optional(),
    dueOn: isoDateSchema.nullable().default(null),
    note: z.string().max(1000).default(""),
  })
  .strict()
  .refine((v) => !(v.holderUserId && v.holderName), { message: "Choose a person or type a name, not both" });
export type CheckoutAssetInput = z.infer<typeof checkoutAssetSchema>;

export const returnAssetSchema = z.object({ note: z.string().max(1000).default("") }).strict();
export type ReturnAssetInput = z.infer<typeof returnAssetSchema>;

export const assetListQuerySchema = z.object({
  q: z.string().max(200).optional(),
  category: z.enum(ASSET_CATEGORIES).optional(),
  status: z.enum(ASSET_STATUSES).optional(),
  locationId: z.string().uuid().optional(),
  /** `out` = checked out now, `overdue` = past its due date, `mine` = with the person asking. */
  holding: z.enum(["out", "overdue", "mine"]).optional(),
});
export type AssetListQuery = z.infer<typeof assetListQuerySchema>;

export interface AssetHolder {
  checkoutId: string;
  userId: string | null;
  /** The account's name, or the name typed for someone without one. */
  name: string;
  outAt: string;
  dueOn: string | null;
  overdue: boolean;
}

export interface Asset {
  id: string;
  tag: string;
  name: string;
  category: AssetCategory;
  make: string;
  model: string;
  serial: string;
  location: LocationRef | null;
  status: AssetStatus;
  lendable: boolean;
  /** Staff only (`assets:write:any`); null for everyone else. */
  purchasedOn: string | null;
  cost: number | null;
  warrantyUntil: string | null;
  notes: string;
  holder: AssetHolder | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssetCheckout {
  id: string;
  holderUserId: string | null;
  holderName: string;
  outByName: string | null;
  outAt: string;
  dueOn: string | null;
  returnedAt: string | null;
  returnedByName: string | null;
  note: string;
  returnNote: string;
}

/** Why an item cannot be checked out now, or null when it can. */
export function checkoutProblem(a: Pick<Asset, "status" | "lendable" | "holder">): string | null {
  if (a.holder) return `It is already checked out to ${a.holder.name}.`;
  if (!a.lendable) return "This item is installed, not lent out.";
  if (a.status !== "in_service") return `It is ${ASSET_STATUS_LABELS[a.status].toLowerCase()}.`;
  return null;
}

/** Past its due date (the due day itself is not overdue). */
export function isOverdue(dueOn: string | null, today: string): boolean {
  return dueOn !== null && daysUntil(dueOn, today) < 0;
}

/** A check-out first seen this many days overdue is flagged without a notice (turning the reminders on must not announce history). */
export const ASSET_OVERDUE_NOTICE_WINDOW_DAYS = 30;

/**
 * Whether an open check-out's overdue reminder is due: `notify` when it should be sent, `silent` when it should only be marked
 * (long overdue already), null when nothing is to be done. The marker stored is the due date, so one notice per due date and a
 * new due date starts again.
 */
export function assetOverdueDue(co: { dueOn: string | null; remindedFor: string | null }, today: string): "notify" | "silent" | null {
  if (!co.dueOn || !isOverdue(co.dueOn, today) || co.remindedFor === co.dueOn) return null;
  return -daysUntil(co.dueOn, today) > ASSET_OVERDUE_NOTICE_WINDOW_DAYS ? "silent" : "notify";
}

// ---- Import from a spreadsheet ----

export const ASSET_IMPORT_MAX_ROWS = 2000;

export const importAssetRowSchema = z
  .object({
    tag: z.union([tagSchema, z.literal("")]).optional(),
    ...assetFields,
    locationId: z.undefined().optional(),
    /** A room by name; created when the import says so, else the row is refused. */
    room: z.string().trim().max(120).default(""),
  })
  .strict();
export type ImportAssetRow = z.infer<typeof importAssetRowSchema>;

export const importAssetsSchema = z
  .object({
    rows: z.array(importAssetRowSchema).min(1).max(ASSET_IMPORT_MAX_ROWS),
    createRooms: z.boolean().default(false),
  })
  .strict();
export type ImportAssetsInput = z.infer<typeof importAssetsSchema>;

export interface ImportAssetsResult {
  created: number;
  roomsCreated: string[];
}

/** Read a CSV (RFC 4180: quoted fields, doubled quotes, CR LF or LF, a byte-order mark) into rows of cells. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell === "") quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  // Blank lines are not rows.
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

type ImportField = "tag" | "name" | "category" | "make" | "model" | "serial" | "room" | "status" | "lendable" | "purchasedOn" | "cost" | "warrantyUntil" | "notes";

/** Column headings each field is recognised by (compared lower-case, spaces and punctuation ignored). */
const HEADINGS: Record<ImportField, string[]> = {
  tag: ["tag", "assettag", "assetid", "asset", "assetnumber", "id"],
  name: ["name", "item", "itemname", "assetname", "description", "equipment"],
  category: ["category", "type", "kind"],
  make: ["make", "brand", "manufacturer", "vendor"],
  model: ["model", "modelnumber"],
  serial: ["serial", "serialnumber", "sn", "serialno"],
  room: ["room", "location", "place", "where"],
  status: ["status", "state", "condition"],
  lendable: ["lendable", "canlend", "loanable", "canbecheckedout", "checkout"],
  purchasedOn: ["purchased", "purchasedate", "purchasedon", "dateofpurchase", "bought"],
  cost: ["cost", "price", "value", "purchaseprice"],
  warrantyUntil: ["warranty", "warrantyuntil", "warrantyexpires", "warrantyend", "warrantyexpiry"],
  notes: ["notes", "note", "comments", "comment", "remarks"],
};

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Which field each column is, by its heading (null = ignored); a field is taken by the first column that names it. */
export function matchImportHeadings(headings: readonly string[]): Array<ImportField | null> {
  const taken = new Set<ImportField>();
  return headings.map((h) => {
    const k = squash(h);
    const field = (Object.keys(HEADINGS) as ImportField[]).find((f) => !taken.has(f) && HEADINGS[f].includes(k)) ?? null;
    if (field) taken.add(field);
    return field;
  });
}

export type ImportDateOrder = "ymd" | "dmy" | "mdy";

/** A spreadsheet date as YYYY-MM-DD, read in the order the admin chose (2026-12-31 is always read as written); null if unreadable. */
export function readImportDate(raw: string, order: ImportDateOrder): string | null {
  const s = raw.trim();
  let y: number, m: number, d: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  const parts = /^(\d{1,4})[/.\-](\d{1,2})[/.\-](\d{1,4})$/.exec(s);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (parts) {
    const [a, b, c] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
    if (order === "ymd") [y, m, d] = [a, b, c];
    else if (order === "dmy") [d, m, y] = [a, b, c];
    else [m, d, y] = [a, b, c];
    if (y < 100) y += 2000;
  } else return null;
  const out = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return isoDateSchema.safeParse(out).success ? out : null;
}

function readCategory(raw: string): AssetCategory | null {
  const k = squash(raw);
  if (!k) return "other";
  for (const c of ASSET_CATEGORIES) if (squash(c) === k || squash(ASSET_CATEGORY_LABELS[c]) === k) return c;
  // A label's first word also counts ("Video" for "Video and cameras", "Computers").
  for (const c of ASSET_CATEGORIES) if (squash(ASSET_CATEGORY_LABELS[c].split(" ")[0]!) === k || `${squash(c)}s` === k) return c;
  return null;
}

function readStatus(raw: string): AssetStatus | null {
  const k = squash(raw);
  if (!k) return "in_service";
  if (["inservice", "active", "ok", "working", "good", "available", "inuse"].includes(k)) return "in_service";
  if (["inrepair", "repair", "broken", "faulty", "beingrepaired"].includes(k)) return "in_repair";
  if (["retired", "disposed", "sold", "scrapped"].includes(k)) return "retired";
  if (["lost", "missing", "stolen"].includes(k)) return "lost";
  return null;
}

function readYesNo(raw: string): boolean | null {
  const k = squash(raw);
  if (!k) return true;
  if (["yes", "y", "true", "1"].includes(k)) return true;
  if (["no", "n", "false", "0"].includes(k)) return false;
  return null;
}

export interface ParsedAssetImport {
  /** The field each column was matched to (null = ignored). */
  columns: Array<{ heading: string; field: ImportField | null }>;
  rows: ImportAssetRow[];
  /** Spreadsheet line numbers (the heading is line 1) with what is wrong; such rows are left out of `rows`. */
  problems: Array<{ line: number; message: string }>;
  /** Things read with a guess (an unknown category as Other), per line. */
  notes: Array<{ line: number; message: string }>;
}

/**
 * A CSV as asset rows to import. The first row is the headings; columns are matched by name in any order and unknown ones
 * ignored. Every row is checked as the API will check it, and a row with a problem is listed, not sent.
 */
export function parseAssetCsv(text: string, dateOrder: ImportDateOrder): ParsedAssetImport {
  const table = parseCsv(text);
  const out: ParsedAssetImport = { columns: [], rows: [], problems: [], notes: [] };
  if (table.length === 0) {
    out.problems.push({ line: 1, message: "The file is empty." });
    return out;
  }
  const headings = table[0]!;
  const fields = matchImportHeadings(headings);
  out.columns = headings.map((heading, i) => ({ heading, field: fields[i] ?? null }));
  if (!fields.includes("name")) {
    out.problems.push({ line: 1, message: 'No column is the item\'s name (a heading such as "Name" or "Item").' });
    return out;
  }
  if (table.length - 1 > ASSET_IMPORT_MAX_ROWS) {
    out.problems.push({ line: 1, message: `At most ${ASSET_IMPORT_MAX_ROWS} items at once; this file has ${table.length - 1}.` });
    return out;
  }
  const seenTags = new Map<string, number>();
  for (let r = 1; r < table.length; r++) {
    const line = r + 1;
    const cells: Partial<Record<ImportField, string>> = {};
    fields.forEach((f, i) => {
      if (f) cells[f] = (table[r]![i] ?? "").trim();
    });
    const wrong: string[] = [];
    const category = readCategory(cells.category ?? "");
    if (category === null) out.notes.push({ line, message: `Category "${cells.category}" is not one of the list, so it is Other.` });
    const status = readStatus(cells.status ?? "");
    if (status === null) wrong.push(`status "${cells.status}" is not In service, In repair, Retired or Lost`);
    const lendable = readYesNo(cells.lendable ?? "");
    if (lendable === null) wrong.push(`"${cells.lendable}" is not yes or no`);
    const date = (field: "purchasedOn" | "warrantyUntil", label: string) => {
      const raw = cells[field] ?? "";
      if (!raw) return null;
      const d = readImportDate(raw, dateOrder);
      if (!d) wrong.push(`${label} "${raw}" is not a date`);
      return d;
    };
    const purchasedOn = date("purchasedOn", "purchase date");
    const warrantyUntil = date("warrantyUntil", "warranty date");
    let cost: number | null = null;
    if (cells.cost) {
      const n = Number(cells.cost.replace(/[^0-9.\-]/g, ""));
      if (!Number.isFinite(n) || n < 0 || cells.cost.replace(/[^0-9]/g, "") === "") wrong.push(`cost "${cells.cost}" is not a number`);
      else cost = n;
    }
    const candidate = {
      tag: cells.tag ?? "",
      name: cells.name ?? "",
      category: category ?? "other",
      make: cells.make ?? "",
      model: cells.model ?? "",
      serial: cells.serial ?? "",
      status: status ?? "in_service",
      lendable: lendable ?? true,
      purchasedOn,
      cost,
      warrantyUntil,
      notes: cells.notes ?? "",
      room: cells.room ?? "",
    };
    const parsed = importAssetRowSchema.safeParse(candidate);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) wrong.push(`${issue.path.join(".") || "row"}: ${issue.message}`);
    }
    const tagKey = candidate.tag.toLowerCase();
    if (tagKey) {
      const first = seenTags.get(tagKey);
      if (first !== undefined) wrong.push(`tag ${candidate.tag} is also on line ${first}`);
      else seenTags.set(tagKey, line);
    }
    if (wrong.length > 0 || !parsed.success) out.problems.push({ line, message: wrong.join("; ") });
    else out.rows.push(parsed.data);
  }
  return out;
}
