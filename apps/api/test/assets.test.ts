import { describe, expect, it } from "vitest";
import {
  assetOverdueDue,
  checkoutProblem,
  formatAssetTag,
  groupLocations,
  isOverdue,
  locationLabel,
  matchImportHeadings,
  parseAssetCsv,
  parseCsv,
  readImportDate,
} from "@church/shared";

describe("parseCsv", () => {
  it("reads quoted cells, doubled quotes, commas and line breaks inside quotes", () => {
    expect(parseCsv('a,b,c\n"x, y","say ""hi""","two\nlines"\n')).toEqual([
      ["a", "b", "c"],
      ["x, y", 'say "hi"', "two\nlines"],
    ]);
  });
  it("takes CRLF, a byte-order mark and a last line without a break; blank lines are not rows", () => {
    expect(parseCsv("﻿Name,Room\r\n\r\nMic,Hall\r\n,\r\nCable,Booth")).toEqual([
      ["Name", "Room"],
      ["Mic", "Hall"],
      ["Cable", "Booth"],
    ]);
  });
  it("keeps empty cells", () => {
    expect(parseCsv("a,,c\n")).toEqual([["a", "", "c"]]);
  });
});

describe("matchImportHeadings", () => {
  it("matches headings in any case and punctuation, ignores unknown ones, and gives a field to the first column only", () => {
    expect(matchImportHeadings(["Asset Tag", "Item", "Serial No.", "Colour", "Location", "Description"])).toEqual([
      "tag",
      "name",
      "serial",
      null,
      "room",
      null,
    ]);
  });
});

describe("readImportDate", () => {
  it("reads ISO dates as written whatever the order chosen", () => {
    expect(readImportDate("2026-03-04", "dmy")).toBe("2026-03-04");
    expect(readImportDate("2026-3-4", "mdy")).toBe("2026-03-04");
  });
  it("reads day/month and month/day as chosen, with two-digit years", () => {
    expect(readImportDate("04/03/2026", "dmy")).toBe("2026-03-04");
    expect(readImportDate("04/03/2026", "mdy")).toBe("2026-04-03");
    expect(readImportDate("4.3.26", "dmy")).toBe("2026-03-04");
  });
  it("refuses impossible dates and text", () => {
    expect(readImportDate("31/02/2026", "dmy")).toBeNull();
    expect(readImportDate("13/13/2026", "dmy")).toBeNull();
    expect(readImportDate("last spring", "dmy")).toBeNull();
  });
});

describe("parseAssetCsv", () => {
  it("turns rows into items, defaulting what is blank", () => {
    const out = parseAssetCsv("Name,Type,Brand,Room,Status,Lendable,Purchased,Cost\nSM58,Audio,Shure,Booth,,,01/02/2024,\"£1,099.50\"\n", "dmy");
    expect(out.problems).toEqual([]);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({
      name: "SM58",
      category: "audio",
      make: "Shure",
      room: "Booth",
      status: "in_service",
      lendable: true,
      purchasedOn: "2024-02-01",
      cost: 1099.5,
    });
  });
  it("lists a row with a problem by its line instead of sending it", () => {
    const out = parseAssetCsv("Name,Status,Lendable,Purchased\nGood,,,\nBad,broken-ish,maybe,yesterday\n", "ymd");
    expect(out.rows.map((r) => r.name)).toEqual(["Good"]);
    expect(out.problems).toHaveLength(1);
    expect(out.problems[0]!.line).toBe(3);
    expect(out.problems[0]!.message).toMatch(/status/);
    expect(out.problems[0]!.message).toMatch(/yes or no/);
    expect(out.problems[0]!.message).toMatch(/not a date/);
  });
  it("reads an unknown category as Other with a note", () => {
    const out = parseAssetCsv("Name,Category\nChair,Seating\n", "ymd");
    expect(out.rows[0]!.category).toBe("other");
    expect(out.notes).toHaveLength(1);
  });
  it("refuses a file without a name column", () => {
    const out = parseAssetCsv("Tag,Serial\nA-1,123\n", "ymd");
    expect(out.rows).toEqual([]);
    expect(out.problems[0]!.message).toMatch(/name/);
  });
  it("refuses the same tag twice in one file", () => {
    const out = parseAssetCsv("Tag,Name\nA-1,One\na-1,Two\n", "ymd");
    expect(out.rows.map((r) => r.name)).toEqual(["One"]);
    expect(out.problems[0]!.message).toMatch(/also on line 2/);
  });
  it("says so for an empty file", () => {
    expect(parseAssetCsv("", "ymd").problems[0]!.message).toMatch(/empty/);
  });
});

describe("check-out rules", () => {
  const holder = { checkoutId: "c", userId: "u", name: "Sam", outAt: "", dueOn: null, overdue: false };
  it("says why an item cannot be checked out", () => {
    expect(checkoutProblem({ status: "in_service", lendable: true, holder: null })).toBeNull();
    expect(checkoutProblem({ status: "in_service", lendable: true, holder })).toMatch(/Sam/);
    expect(checkoutProblem({ status: "in_service", lendable: false, holder: null })).toMatch(/installed/);
    expect(checkoutProblem({ status: "in_repair", lendable: true, holder: null })).toMatch(/in repair/);
  });
  it("counts an item overdue only after its due day", () => {
    expect(isOverdue("2026-10-25", "2026-10-25")).toBe(false);
    expect(isOverdue("2026-10-24", "2026-10-25")).toBe(true);
    expect(isOverdue(null, "2026-10-25")).toBe(false);
  });
  it("sends one reminder per due date, and marks a long-overdue one silently", () => {
    expect(assetOverdueDue({ dueOn: "2026-10-20", remindedFor: null }, "2026-10-25")).toBe("notify");
    expect(assetOverdueDue({ dueOn: "2026-10-20", remindedFor: "2026-10-20" }, "2026-10-25")).toBeNull();
    // A new due date starts again.
    expect(assetOverdueDue({ dueOn: "2026-10-22", remindedFor: "2026-10-20" }, "2026-10-25")).toBe("notify");
    expect(assetOverdueDue({ dueOn: "2026-08-01", remindedFor: null }, "2026-10-25")).toBe("silent");
    expect(assetOverdueDue({ dueOn: "2026-10-30", remindedFor: null }, "2026-10-25")).toBeNull();
  });
  it("numbers tags", () => {
    expect(formatAssetTag(42)).toBe("A-0042");
    expect(formatAssetTag(12345)).toBe("A-12345");
  });
});

describe("rooms", () => {
  it("labels a room with its building", () => {
    expect(locationLabel({ name: "Booth", building: "Main" })).toBe("Booth (Main)");
    expect(locationLabel({ name: "Booth", building: "" })).toBe("Booth");
  });
  it("groups rooms by building, rooms without one first, each sorted", () => {
    const g = groupLocations([
      { name: "Office", building: "Annex" },
      { name: "Booth", building: "" },
      { name: "Hall", building: "Annex" },
      { name: "Nave", building: "Church" },
    ]);
    expect(g.map((x) => x.building)).toEqual(["", "Annex", "Church"]);
    expect(g[1]!.rooms.map((r) => r.name)).toEqual(["Hall", "Office"]);
  });
});
