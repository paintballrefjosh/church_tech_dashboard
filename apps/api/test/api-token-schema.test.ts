import { describe, expect, it } from "vitest";
import { apiTokenCreateSchema } from "@church/shared";

describe("apiTokenCreateSchema operational level", () => {
  it("is off unless asked for", () => {
    const r = apiTokenCreateSchema.parse({ name: "x", readOnly: false });
    expect(r.allowOperational).toBe(false);
  });

  it("accepts a read and write token with the operational level", () => {
    const r = apiTokenCreateSchema.parse({ name: "x", readOnly: false, allowOperational: true });
    expect(r.allowOperational).toBe(true);
  });

  it("refuses the operational level on a read-only token (read-only is the default)", () => {
    expect(apiTokenCreateSchema.safeParse({ name: "x", allowOperational: true }).success).toBe(false);
    expect(apiTokenCreateSchema.safeParse({ name: "x", readOnly: true, allowOperational: true }).success).toBe(false);
  });
});
