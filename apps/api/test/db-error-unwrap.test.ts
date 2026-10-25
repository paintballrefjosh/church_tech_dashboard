import { describe, expect, it } from "vitest";
import { classifyDbError, dbErrorCode } from "@church/shared/db";

/** What drizzle-orm 0.45 throws: its own error with pg's in `cause`. */
function drizzleWrapped(code: string) {
  const pg = Object.assign(new Error("duplicate key value violates unique constraint"), { code });
  return Object.assign(new Error("Failed query: insert into ..."), { cause: pg });
}

describe("database errors through drizzle's wrapping", () => {
  it("dbErrorCode finds the SQLSTATE on the pg error", () => {
    expect(dbErrorCode(drizzleWrapped("23505"))).toBe("23505");
    expect(dbErrorCode(Object.assign(new Error("x"), { code: "40001" }))).toBe("40001");
    expect(dbErrorCode(new Error("no code"))).toBe("");
    expect(dbErrorCode(null)).toBe("");
  });
  it("classifyDbError still sees a serialization failure", () => {
    expect(classifyDbError(drizzleWrapped("40001"))).toBe("rolled-back");
    expect(classifyDbError(drizzleWrapped("23505"))).toBeNull();
  });
});
