import { describe, expect, it } from "vitest";
import { guessMatch, guessName, guessSide } from "./hints";
import { NONE, assign, defaultPortSide, sideOf, uploadName } from "./selection";
import { buildEmf, emfRecord, u32, utf16 } from "./test-builders";
import type { StencilPicture } from "./types";

const text = (s: string) => emfRecord(84, [...new Array(36).fill(0), ...u32(s.length), ...u32(76), ...u32(0), ...new Array(16).fill(0), ...u32(0), ...utf16(s)]);
const pic = (over: Partial<StencilPicture> = {}): StencilPicture => ({ id: "1", kind: "emf", bytes: buildEmf([]), name: null, description: null, source: "x", ...over });

describe("guessing the side of a picture", () => {
  it("reads front and rear from the words", () => {
    expect(guessSide(pic({ description: "Rear Standalone with Optional Stacking" }))).toBe("back");
    expect(guessSide(pic({ description: "Front ISR 4351 with 3 onboard GE" }))).toBe("front");
    expect(guessSide(pic({ description: "Front and rear views" }))).toBeNull();
  });

  it("calls a picture the back when its art prints power-supply and fan markings", () => {
    expect(guessSide(pic({ bytes: buildEmf([text("MGMT"), text("PS OK"), text("AC OK")]) }))).toBe("back");
    expect(guessSide(pic({ bytes: buildEmf([text("CONSOLE"), text("STAT")]) }))).toBeNull();
  });
});

describe("guessing a name and match for a model", () => {
  it("uses the picture's own name, else the model name printed on the art", () => {
    expect(guessName(pic({ name: "WS-C3850-24" }))).toBe("WS-C3850-24");
    expect(guessName(pic({ bytes: buildEmf([text("01"), text("Catalyst "), text("3850 24"), text(" PoE+")]) }))).toBe("Catalyst 3850 24 PoE+");
    expect(guessName(pic())).toBeNull();
  });

  it("suggests a match only for names that are product ids", () => {
    expect(guessMatch("WS-C3850-24")).toEqual(["WS-C3850-24"]);
    expect(guessMatch("N3K-C3064PQ-10GX")).toEqual(["N3K-C3064PQ-10GX"]);
    expect(guessMatch("Catalyst 3850 24 PoE+")).toEqual([]);
    expect(guessMatch("R Series rack, 19\"")).toEqual([]);
    expect(guessMatch(null)).toEqual([]);
  });
});

describe("choosing front and back", () => {
  it("gives each side to one picture and moves a picture off its other side", () => {
    let a = assign(NONE, "p1", "front");
    a = assign(a, "p2", "back");
    expect(a).toEqual({ front: "p1", back: "p2" });
    a = assign(a, "p3", "front"); // takes the front from p1
    expect(a).toEqual({ front: "p3", back: "p2" });
    a = assign(a, "p2", "front"); // p2 moves from back to front
    expect(a).toEqual({ front: "p2", back: null });
    expect(sideOf(a, "p2")).toBe("front");
    a = assign(a, "p2", null);
    expect(a).toEqual(NONE);
  });

  it("defaults the ports to the front when there is one, and names uploads sensibly", () => {
    expect(defaultPortSide({ front: "a", back: "b" })).toBe("front");
    expect(defaultPortSide({ front: null, back: "b" })).toBe("back");
    expect(uploadName("Cisco Nexus 3064PQ", "front", "image/png")).toBe("cisco-nexus-3064pq-front.png");
    expect(uploadName("!!!", "back", "image/jpeg")).toBe("switch-back.jpg");
  });
});
