import { describe, expect, it } from "vitest";
import {
  OFFSITE_KEYS,
  findKnownSetting,
  findTogglePrerequisite,
  isOffsiteArchiveKey,
  normaliseOffsitePrefix,
  offsiteKeyTime,
  offsiteKeysToDelete,
  offsiteMissing,
  offsiteObjectKey,
  offsiteObjectName,
  validateSettingValue,
} from "@church/shared";

const ID = "1a2b3c4d-0000-4000-8000-000000000001";
const at = (iso: string) => new Date(iso);

describe("offsite folder names", () => {
  it("normalises to no leading slash and one trailing slash", () => {
    expect(normaliseOffsitePrefix("church-dashboard/")).toEqual({ ok: true, prefix: "church-dashboard/" });
    expect(normaliseOffsitePrefix("/a//b/")).toEqual({ ok: true, prefix: "a/b/" });
    expect(normaliseOffsitePrefix("  nightly ")).toEqual({ ok: true, prefix: "nightly/" });
    expect(normaliseOffsitePrefix("")).toEqual({ ok: true, prefix: "" });
    expect(normaliseOffsitePrefix("/")).toEqual({ ok: true, prefix: "" });
  });

  it("refuses dot segments, backslashes and control characters", () => {
    for (const bad of ["../x", "a/../b", "./a", "a\\b", "a\u0000b", "a\nb"]) {
      expect(normaliseOffsitePrefix(bad).ok, bad).toBe(false);
    }
    expect(normaliseOffsitePrefix("x".repeat(201)).ok).toBe(false);
  });
});

describe("offsite object names", () => {
  it("names a copy by its time and a short id, and reads the time back", () => {
    const d = at("2026-10-16T03:15:09Z");
    expect(offsiteObjectName(d, ID)).toBe("church-dashboard-20261016T031509Z-1a2b3c4d.tar.gz");
    const key = offsiteObjectKey("church/", d, ID);
    expect(key).toBe("church/church-dashboard-20261016T031509Z-1a2b3c4d.tar.gz");
    expect(isOffsiteArchiveKey("church/", key)).toBe(true);
    expect(offsiteKeyTime("church/", key)?.toISOString()).toBe("2026-10-16T03:15:09.000Z");
  });

  it("recognises only its own names, in its own folder", () => {
    const ok = "p/church-dashboard-20261016T031509Z-1a2b3c4d.tar.gz";
    expect(isOffsiteArchiveKey("p/", ok)).toBe(true);
    expect(isOffsiteArchiveKey("q/", ok)).toBe(false);
    expect(isOffsiteArchiveKey("p/", "p/notes.txt")).toBe(false);
    expect(isOffsiteArchiveKey("p/", "p/sub/church-dashboard-20261016T031509Z-1a2b3c4d.tar.gz")).toBe(false);
    expect(isOffsiteArchiveKey("p/", "p/.church-dashboard-write-test-ab12cd34")).toBe(false);
    expect(offsiteKeyTime("p/", "p/other.tar.gz")).toBeNull();
  });

  it("sorts oldest to newest as plain strings", () => {
    const names = [at("2026-12-01T00:00:00Z"), at("2026-01-05T10:00:00Z"), at("2026-10-16T03:15:09Z")].map((d) => offsiteObjectName(d, ID));
    expect([...names].sort()).toEqual([names[1], names[2], names[0]]);
  });
});

describe("which copies to delete", () => {
  const key = (d: string, id = "aaaaaaaa") => `p/church-dashboard-${d}-${id}.tar.gz`;
  const keys = [key("20260101T000000Z"), key("20260102T000000Z"), key("20260103T000000Z"), key("20260104T000000Z"), "p/readme.txt", "p/.church-dashboard-write-test-xx"];

  it("keeps the newest N and never touches other files", () => {
    expect(offsiteKeysToDelete("p/", keys, 2)).toEqual([key("20260101T000000Z"), key("20260102T000000Z")]);
    expect(offsiteKeysToDelete("p/", keys, 4)).toEqual([]);
    expect(offsiteKeysToDelete("p/", keys, 100)).toEqual([]);
  });

  it("keeps everything when asked for 0 (or nonsense)", () => {
    expect(offsiteKeysToDelete("p/", keys, 0)).toEqual([]);
    expect(offsiteKeysToDelete("p/", keys, -3)).toEqual([]);
    expect(offsiteKeysToDelete("p/", keys, Number.NaN)).toEqual([]);
  });

  it("ignores keys in another folder", () => {
    expect(offsiteKeysToDelete("other/", keys, 1)).toEqual([]);
  });
});

describe("offsite settings", () => {
  it("says what is missing, in the order a person fills it in", () => {
    const full = { endpoint: "s3.example.org", bucket: "b", accessKey: "k", secretKey: "s" };
    expect(offsiteMissing(full)).toBeNull();
    expect(offsiteMissing({ ...full, endpoint: " " })).toBe("the endpoint");
    expect(offsiteMissing({ ...full, bucket: "" })).toBe("the bucket");
    expect(offsiteMissing({ ...full, accessKey: "" })).toBe("the access key");
    expect(offsiteMissing({ ...full, secretKey: "" })).toBe("the secret key");
  });

  it("the secret key is a secret setting and the switch needs the credentials first", () => {
    expect(findKnownSetting(OFFSITE_KEYS.secretKey)?.type).toBe("secret");
    expect(findKnownSetting(OFFSITE_KEYS.enabled)?.category).toBe("backup");
    const need = findTogglePrerequisite(OFFSITE_KEYS.enabled);
    expect(need?.requires).toEqual([OFFSITE_KEYS.endpoint, OFFSITE_KEYS.bucket, OFFSITE_KEYS.accessKey, OFFSITE_KEYS.secretKey]);
  });

  it("validates the folder, endpoint and number to keep", () => {
    expect(validateSettingValue(OFFSITE_KEYS.prefix, "church/")).toBeNull();
    expect(validateSettingValue(OFFSITE_KEYS.prefix, "")).toBeNull();
    expect(validateSettingValue(OFFSITE_KEYS.prefix, "../x")).not.toBeNull();
    expect(validateSettingValue(OFFSITE_KEYS.prefix, 5)).not.toBeNull();
    expect(validateSettingValue(OFFSITE_KEYS.endpoint, "s3.example.org")).toBeNull();
    expect(validateSettingValue(OFFSITE_KEYS.endpoint, "s3 example")).not.toBeNull();
    expect(validateSettingValue(OFFSITE_KEYS.keep, 14)).toBeNull();
    expect(validateSettingValue(OFFSITE_KEYS.keep, 0)).toBeNull();
    expect(validateSettingValue(OFFSITE_KEYS.keep, -1)).not.toBeNull();
    expect(validateSettingValue(OFFSITE_KEYS.keep, 2.5)).not.toBeNull();
    expect(validateSettingValue(OFFSITE_KEYS.keep, 5000)).not.toBeNull();
    expect(validateSettingValue(OFFSITE_KEYS.keep, "7")).not.toBeNull();
  });
});
