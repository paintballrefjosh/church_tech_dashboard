import { describe, expect, it } from "vitest";
import {
  commit,
  duplicateNames,
  freeName,
  fromEditorPorts,
  HISTORY_LIMIT,
  intersects,
  matchSize,
  MIN_PORT_SIZE,
  moveBoxes,
  newPort,
  rectFrom,
  redo,
  resizeBoxes,
  startHistory,
  undo,
  type EditorPort,
} from "./editor-ops";

const p = (uid: string, over: Partial<EditorPort> = {}): EditorPort => ({ uid, name: uid, aliases: [], kind: "rj45", x: 0.2, y: 0.3, w: 0.05, h: 0.2, ...over });
const sel = (...ids: string[]) => new Set(ids);

describe("moveBoxes", () => {
  it("moves the selected boxes and nothing else", () => {
    const out = moveBoxes([p("a"), p("b", { x: 0.5 })], sel("a"), 0.1, -0.05);
    expect(out[0]).toMatchObject({ x: 0.30000000000000004, y: 0.25 });
    expect(out[1]).toEqual(p("b", { x: 0.5 }));
  });

  it("stops the whole group at the edge instead of squashing it", () => {
    const ports = [p("a", { x: 0.1 }), p("b", { x: 0.9, w: 0.05 })];
    const out = moveBoxes(ports, sel("a", "b"), 0.5, 0);
    expect(out[1]!.x + out[1]!.w).toBeCloseTo(1, 10);
    // a moved by the same amount b was allowed, so the gap between them is kept
    expect(out[1]!.x - out[0]!.x).toBeCloseTo(0.8, 10);
    const left = moveBoxes(ports, sel("a", "b"), -5, 0);
    expect(left[0]!.x).toBeCloseTo(0, 10);
    expect(moveBoxes(ports, sel("a", "b"), 0, 5)[0]!.y + 0.2).toBeCloseTo(1, 10);
  });

  it("does nothing for an empty selection", () => {
    const ports = [p("a")];
    expect(moveBoxes(ports, sel(), 0.3, 0.3)).toEqual(ports);
  });
});

describe("resizeBoxes", () => {
  it("changes every selected box by the same amount", () => {
    const out = resizeBoxes([p("a"), p("b", { x: 0.5 })], sel("a", "b"), 0.01, 0.02);
    expect(out[0]!.w).toBeCloseTo(0.06, 10);
    expect(out[1]!.h).toBeCloseTo(0.22, 10);
  });

  it("never goes below the minimum or past the picture's edge", () => {
    const small = resizeBoxes([p("a")], sel("a"), -1, -1);
    expect(small[0]!.w).toBeCloseTo(MIN_PORT_SIZE, 10);
    expect(small[0]!.h).toBeCloseTo(MIN_PORT_SIZE, 10);
    const big = resizeBoxes([p("a", { x: 0.9 })], sel("a"), 1, 1);
    expect(big[0]!.x + big[0]!.w).toBeLessThanOrEqual(1.0000001);
    expect(big[0]!.y + big[0]!.h).toBeLessThanOrEqual(1.0000001);
  });
});

describe("matchSize", () => {
  it("gives the selected boxes the reference box's size, within the picture", () => {
    const out = matchSize([p("ref", { w: 0.04, h: 0.1 }), p("a", { w: 0.01, h: 0.5 }), p("edge", { x: 0.98 })], sel("a", "edge"), "ref");
    expect(out[1]).toMatchObject({ w: 0.04, h: 0.1 });
    expect(out[2]!.w).toBeCloseTo(0.02, 10);
  });
});

describe("geometry", () => {
  it("intersects and builds rectangles either way round", () => {
    expect(intersects({ x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0.4, y: 0.4, w: 0.5, h: 0.5 })).toBe(true);
    expect(intersects({ x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0.5, y: 0, w: 0.2, h: 0.2 })).toBe(false);
    const r = rectFrom(0.6, 0.7, 0.2, 0.1);
    expect([r.x, r.y]).toEqual([0.2, 0.1]);
    expect(r.w).toBeCloseTo(0.4, 10);
    expect(r.h).toBeCloseTo(0.6, 10);
  });
});

describe("names", () => {
  it("finds a name used twice, aliases included, ignoring case", () => {
    expect(duplicateNames([p("a", { name: "Gi1/0/1" }), p("b", { name: "gi1/0/1" })])).toEqual(new Set(["gi1/0/1"]));
    expect(duplicateNames([p("a", { name: "Gi1/1/1", aliases: ["Te1/1/1"] }), p("b", { name: "Te1/1/1" })])).toEqual(new Set(["te1/1/1"]));
    expect(duplicateNames([p("a", { name: "1" }), p("b", { name: "2" })]).size).toBe(0);
  });

  it("makes a free name", () => {
    expect(freeName([p("a", { name: "Port 1" })], "Port 2")).toBe("Port 2");
    expect(freeName([p("a", { name: "Port 1" }), p("b", { name: "port 1 (2)" })], "Port 1")).toBe("Port 1 (3)");
  });

  it("adds a port like its neighbours, inside the picture", () => {
    const n = newPort([p("a", { w: 0.04, h: 0.1 })], "rj45", { x: 1, y: 0 });
    expect(n.w).toBe(0.04);
    expect(n.x + n.w).toBeLessThanOrEqual(1);
    expect(n.y).toBe(0);
    expect(n.name).toBe("Port 2");
  });

  it("drops the session id and rounds when saving", () => {
    const [out] = fromEditorPorts([p("a", { x: 0.123456789 })]);
    expect(out).not.toHaveProperty("uid");
    expect(out!.x).toBe(0.12346);
  });
});

describe("history", () => {
  it("undoes and redoes, and a new change forgets the redo branch", () => {
    let h = startHistory<number>(1);
    h = commit(h, 2);
    h = commit(h, 3);
    h = undo(h);
    expect(h.present).toBe(2);
    h = undo(h);
    h = redo(h);
    expect(h.present).toBe(2);
    h = commit(h, 9);
    expect(h.future).toEqual([]);
    expect(redo(h).present).toBe(9);
    expect(undo(undo(undo(h))).present).toBe(1);
  });

  it("does not make a step of an unchanged value and is bounded", () => {
    const a = {};
    const h = startHistory(a);
    expect(commit(h, a)).toBe(h);
    let long = startHistory(0);
    for (let i = 1; i <= HISTORY_LIMIT + 20; i++) long = commit(long, i);
    expect(long.past.length).toBe(HISTORY_LIMIT);
  });
});
