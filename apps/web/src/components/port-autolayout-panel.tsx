"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, ScanSearch, X } from "lucide-react";
import type { SwitchPortKind } from "@church/shared";
import { detectPorts, gridBoxes, labelBoxes, type Box, type NumberingScheme, type PixelImage } from "@/lib/faceplates/detect";
import { newUid, type EditorPort, type Frac } from "@/lib/faceplates/editor-ops";

export interface Ghost {
  box: Frac;
  name: string;
}

type Mode = "detect" | "grid" | "rename";

interface Group {
  key: string;
  include: boolean;
  kind: SwitchPortKind;
  pattern: string;
  start: number;
  scheme: NumberingScheme;
  /** Size in pixels and the boxes, in the pixels of the picture the detector saw. */
  w: number;
  h: number;
  boxes: Box[];
}

const DEFAULT_PATTERN: Record<SwitchPortKind, string> = {
  rj45: "Gi1/0/{n}",
  sfp: "Te1/1/{n}",
  qsfp: "Eth1/{n}",
  other: "{n}",
};

const field = "rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950";
const SCHEMES: Array<{ value: NumberingScheme; label: string }> = [
  { value: "columns", label: "Down each column, then across (1 above 2)" },
  { value: "rows", label: "Along each row, then down" },
];

/** Reads the picture's pixels, at most `MAX` across (the detector shrinks it further itself). */
const MAX_SIDE = 3000;
async function loadPixels(url: string): Promise<PixelImage> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * k));
  const height = Math.max(1, Math.round(img.naturalHeight * k));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This browser cannot read the picture.");
  ctx.drawImage(img, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/** A guess at the kind from the size: a group clearly bigger than the biggest-count group is probably cages. */
function guessKinds(groups: Array<{ w: number; boxes: Box[] }>): SwitchPortKind[] {
  const main = groups[0];
  return groups.map((g, i) => (i === 0 || !main ? "rj45" : g.w > main.w * 1.3 ? "sfp" : "rj45"));
}

/**
 * Auto placement: propose the ports (finding the sockets in the picture, or an even grid across an area), name them in
 * the order a switch numbers them, and show the proposal on the picture as ghosts. Nothing changes until "Add"; after
 * that the boxes are the admin's to drag. "Rename selected" numbers boxes that are already placed.
 */
export function PortAutoLayoutPanel({
  imageUrl,
  area,
  onClearArea,
  ports,
  selected,
  onGhosts,
  onApply,
  onClose,
}: {
  imageUrl: string;
  /** The area drawn on the picture (fractions), or null for the whole picture. */
  area: Frac | null;
  onClearArea: () => void;
  ports: EditorPort[];
  selected: EditorPort[];
  onGhosts: (g: Ghost[]) => void;
  onApply: (next: EditorPort[]) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>("detect");
  const [pixels, setPixels] = useState<{ width: number; height: number } | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [replace, setReplace] = useState(ports.length === 0);

  // even grid
  const [rows, setRows] = useState(2);
  const [cols, setCols] = useState(24);
  const [every, setEvery] = useState(0);
  const [gridKind, setGridKind] = useState<SwitchPortKind>("rj45");
  const [gridPattern, setGridPattern] = useState(DEFAULT_PATTERN.rj45);
  const [gridStart, setGridStart] = useState(1);
  const [gridScheme, setGridScheme] = useState<NumberingScheme>("columns");

  // rename selected
  const [renPattern, setRenPattern] = useState("Gi1/0/{n}");
  const [renStart, setRenStart] = useState(1);
  const [renScheme, setRenScheme] = useState<NumberingScheme>("columns");

  const runDetect = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    setGroups([]);
    try {
      const img = await loadPixels(imageUrl);
      setPixels({ width: img.width, height: img.height });
      // Let the "looking" state paint before the work starts: detection is a second or so of synchronous work.
      await new Promise((r) => setTimeout(r, 30));
      const box = area ? { x: area.x * img.width, y: area.y * img.height, w: area.w * img.width, h: area.h * img.height } : undefined;
      const found = detectPorts(img, box);
      if (found.length === 0) {
        setMessage("No sockets stood out in " + (area ? "that area" : "the picture") + ". Draw an area around just the ports and try again, or use an even grid.");
        return;
      }
      const kinds = guessKinds(found);
      // Much smaller than the main group: LEDs, screws or printed marks, not ports. Offered, but off.
      const mainW = found[0]!.w;
      setGroups(
        found.map((g, i) => ({ key: `g${i}`, include: g.w >= mainW * 0.5, kind: kinds[i]!, pattern: DEFAULT_PATTERN[kinds[i]!], start: 1, scheme: "columns", w: g.w, h: g.h, boxes: g.boxes })),
      );
    } catch (e) {
      setMessage((e as Error).message || "The picture could not be read.");
    } finally {
      setBusy(false);
    }
  }, [imageUrl, area]);

  // What the current settings would add or rename, as fractions of the picture.
  const ghosts = useMemo<Array<Ghost & { kind: SwitchPortKind; uid?: string }>>(() => {
    if (mode === "detect" && pixels) {
      return groups
        .filter((g) => g.include)
        .flatMap((g) =>
          labelBoxes(g.boxes, { scheme: g.scheme, pattern: g.pattern, start: g.start }).map(({ name, box }) => ({
            name,
            kind: g.kind,
            box: { x: box.x / pixels.width, y: box.y / pixels.height, w: box.w / pixels.width, h: box.h / pixels.height },
          })),
        );
    }
    if (mode === "grid") {
      const a = area ?? { x: 0.02, y: 0.1, w: 0.96, h: 0.8 };
      return labelBoxes(gridBoxes(a, rows, cols, every), { scheme: gridScheme, pattern: gridPattern, start: gridStart }).map(({ name, box }) => ({ name, kind: gridKind, box }));
    }
    if (mode === "rename" && selected.length > 0) {
      const boxes = selected.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h }));
      // labelBoxes hands back the same box objects it was given, so each name can be traced to its port.
      const owners = new Map(boxes.map((b, i) => [b, selected[i]!]));
      return labelBoxes(boxes, { scheme: renScheme, pattern: renPattern, start: renStart }).map(({ name, box }) => {
        const owner = owners.get(box);
        return { name, kind: owner?.kind ?? "rj45", uid: owner?.uid, box };
      });
    }
    return [];
  }, [mode, pixels, groups, area, rows, cols, every, gridKind, gridPattern, gridStart, gridScheme, selected, renPattern, renStart, renScheme]);

  useEffect(() => {
    onGhosts(ghosts.map(({ box, name }) => ({ box, name })));
  }, [ghosts, onGhosts]);
  useEffect(() => () => onGhosts([]), [onGhosts]);

  const clash = useMemo(() => {
    if (mode === "rename") {
      const renamed = new Set(selected.map((p) => p.uid));
      const used = new Set(ports.filter((p) => !renamed.has(p.uid)).flatMap((p) => [p.name, ...p.aliases]).map((n) => n.toLowerCase()));
      return ghosts.filter((g) => used.has(g.name.toLowerCase())).length;
    }
    const used = replace ? new Set<string>() : new Set(ports.flatMap((p) => [p.name, ...p.aliases]).map((n) => n.toLowerCase()));
    const seen = new Set<string>();
    let n = 0;
    for (const g of ghosts) {
      const k = g.name.toLowerCase();
      if (used.has(k) || seen.has(k)) n++;
      seen.add(k);
    }
    return n;
  }, [mode, ghosts, ports, replace, selected]);

  function apply() {
    if (mode === "rename") {
      const byUid = new Map(ghosts.filter((g) => g.uid).map((g) => [g.uid as string, g.name]));
      onApply(ports.map((p) => (byUid.has(p.uid) ? { ...p, name: byUid.get(p.uid)! } : p)));
      onClose();
      return;
    }
    const added: EditorPort[] = ghosts.map((g) => ({
      uid: newUid(),
      name: g.name,
      aliases: [],
      kind: g.kind,
      x: Math.max(0, Math.min(g.box.x, 1 - g.box.w)),
      y: Math.max(0, Math.min(g.box.y, 1 - g.box.h)),
      w: g.box.w,
      h: g.box.h,
    }));
    onApply(replace ? added : [...ports, ...added]);
    onClose();
  }

  const canApply = ghosts.length > 0 && clash === 0;
  const tab = (m: Mode, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === m}
      onClick={() => setMode(m)}
      className={`rounded-md px-2.5 py-1 text-xs font-medium ${mode === m ? "bg-brand-100 text-brand-800 dark:bg-brand-900/40 dark:text-brand-200" : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"}`}
    >
      {label}
    </button>
  );
  const patternHelp = "Use {n} where the number goes: Gi1/0/{n} gives Gi1/0/1, Gi1/0/2 ...";

  return (
    <section aria-label="Auto placement" className="space-y-3 rounded-md border border-brand-300 bg-brand-50/40 p-3 text-xs dark:border-brand-800 dark:bg-brand-950/20">
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="How to place ports" className="flex gap-1">
          {tab("detect", "Find sockets")}
          {tab("grid", "Even grid")}
          {tab("rename", `Rename selected${selected.length ? ` (${selected.length})` : ""}`)}
        </div>
        <button type="button" onClick={onClose} aria-label="Close auto placement" className="ml-auto rounded p-1 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800">
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {mode !== "rename" ? (
        <p className="text-slate-600 dark:text-slate-400">
          {area ? (
            <>
              Using the area you drew.{" "}
              <button type="button" onClick={onClearArea} className="text-brand-600 underline dark:text-brand-400">
                Use the whole picture
              </button>
            </>
          ) : (
            <>Using the whole picture. Press “Select area” and drag a box round just the ports for a better result.</>
          )}
        </p>
      ) : null}

      {mode === "detect" ? (
        <div className="space-y-2">
          <button type="button" onClick={() => void runDetect()} disabled={busy} className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 font-medium text-white hover:bg-brand-700 disabled:opacity-60">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <ScanSearch className="h-3.5 w-3.5" aria-hidden />}
            {busy ? "Looking…" : groups.length ? "Look again" : "Find sockets"}
          </button>
          {message ? <p role="status" className="text-amber-800 dark:text-amber-300">{message}</p> : null}
          {groups.map((g, i) => (
            <fieldset key={g.key} className="space-y-1.5 rounded-md border border-slate-300 p-2 dark:border-slate-700">
              <legend className="px-1">
                <label className="inline-flex items-center gap-1.5 font-medium">
                  <input type="checkbox" checked={g.include} onChange={(e) => setGroups((gs) => gs.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)))} />
                  {g.boxes.length} sockets about {Math.round(g.w)} × {Math.round(g.h)} px
                </label>
                {i > 0 && g.w < groups[0]!.w * 0.5 ? <span className="ml-2 text-slate-500 dark:text-slate-400">(small: probably LEDs or marks)</span> : null}
              </legend>
              <div className="flex flex-wrap items-end gap-2">
                <label className="block">
                  <span className="text-slate-500 dark:text-slate-400">Kind</span>
                  <select
                    value={g.kind}
                    onChange={(e) => {
                      const kind = e.target.value as SwitchPortKind;
                      setGroups((gs) => gs.map((x, j) => (j === i ? { ...x, kind, pattern: x.pattern === DEFAULT_PATTERN[x.kind] ? DEFAULT_PATTERN[kind] : x.pattern } : x)));
                    }}
                    className={`mt-1 block ${field}`}
                  >
                    <option value="rj45">RJ45</option>
                    <option value="sfp">SFP / SFP+</option>
                    <option value="qsfp">QSFP</option>
                    <option value="other">Other</option>
                  </select>
                </label>
                <label className="block">
                  <span className="text-slate-500 dark:text-slate-400">Name</span>
                  <input value={g.pattern} title={patternHelp} onChange={(e) => setGroups((gs) => gs.map((x, j) => (j === i ? { ...x, pattern: e.target.value } : x)))} className={`mt-1 block w-36 font-mono ${field}`} />
                </label>
                <label className="block">
                  <span className="text-slate-500 dark:text-slate-400">First number</span>
                  <input type="number" min={0} value={g.start} onChange={(e) => setGroups((gs) => gs.map((x, j) => (j === i ? { ...x, start: Math.max(0, Number(e.target.value) || 0) } : x)))} className={`mt-1 block w-20 ${field}`} />
                </label>
                <label className="block">
                  <span className="text-slate-500 dark:text-slate-400">Numbered</span>
                  <select value={g.scheme} onChange={(e) => setGroups((gs) => gs.map((x, j) => (j === i ? { ...x, scheme: e.target.value as NumberingScheme } : x)))} className={`mt-1 block ${field}`}>
                    {SCHEMES.map((s) => (
                      <option key={s.value} value={s.value}>{s.label}</option>
                    ))}
                  </select>
                </label>
              </div>
            </fieldset>
          ))}
        </div>
      ) : null}

      {mode === "grid" ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="text-slate-500 dark:text-slate-400">Rows</span>
            <input type="number" min={1} max={8} value={rows} onChange={(e) => setRows(Math.max(1, Math.min(8, Number(e.target.value) || 1)))} className={`mt-1 block w-16 ${field}`} />
          </label>
          <label className="block">
            <span className="text-slate-500 dark:text-slate-400">Columns</span>
            <input type="number" min={1} max={64} value={cols} onChange={(e) => setCols(Math.max(1, Math.min(64, Number(e.target.value) || 1)))} className={`mt-1 block w-16 ${field}`} />
          </label>
          <label className="block">
            <span className="text-slate-500 dark:text-slate-400">Gap after every</span>
            <input type="number" min={0} max={64} value={every} onChange={(e) => setEvery(Math.max(0, Math.min(64, Number(e.target.value) || 0)))} className={`mt-1 block w-16 ${field}`} title="Columns in a block of ports; 0 for no gaps" />
          </label>
          <label className="block">
            <span className="text-slate-500 dark:text-slate-400">Kind</span>
            <select
              value={gridKind}
              onChange={(e) => {
                const k = e.target.value as SwitchPortKind;
                setGridPattern((p) => (p === DEFAULT_PATTERN[gridKind] ? DEFAULT_PATTERN[k] : p));
                setGridKind(k);
              }}
              className={`mt-1 block ${field}`}
            >
              <option value="rj45">RJ45</option>
              <option value="sfp">SFP / SFP+</option>
              <option value="qsfp">QSFP</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label className="block">
            <span className="text-slate-500 dark:text-slate-400">Name</span>
            <input value={gridPattern} title={patternHelp} onChange={(e) => setGridPattern(e.target.value)} className={`mt-1 block w-36 font-mono ${field}`} />
          </label>
          <label className="block">
            <span className="text-slate-500 dark:text-slate-400">First number</span>
            <input type="number" min={0} value={gridStart} onChange={(e) => setGridStart(Math.max(0, Number(e.target.value) || 0))} className={`mt-1 block w-20 ${field}`} />
          </label>
          <label className="block">
            <span className="text-slate-500 dark:text-slate-400">Numbered</span>
            <select value={gridScheme} onChange={(e) => setGridScheme(e.target.value as NumberingScheme)} className={`mt-1 block ${field}`}>
              {SCHEMES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      {mode === "rename" ? (
        selected.length === 0 ? (
          <p className="text-slate-600 dark:text-slate-400">Select the boxes to rename (drag a box round them, or Shift-click), then number them here in the order a switch would.</p>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <label className="block">
              <span className="text-slate-500 dark:text-slate-400">Name</span>
              <input value={renPattern} title={patternHelp} onChange={(e) => setRenPattern(e.target.value)} className={`mt-1 block w-36 font-mono ${field}`} />
            </label>
            <label className="block">
              <span className="text-slate-500 dark:text-slate-400">First number</span>
              <input type="number" min={0} value={renStart} onChange={(e) => setRenStart(Math.max(0, Number(e.target.value) || 0))} className={`mt-1 block w-20 ${field}`} />
            </label>
            <label className="block">
              <span className="text-slate-500 dark:text-slate-400">Numbered</span>
              <select value={renScheme} onChange={(e) => setRenScheme(e.target.value as NumberingScheme)} className={`mt-1 block ${field}`}>
                {SCHEMES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </label>
          </div>
        )
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {mode !== "rename" && ports.length > 0 ? (
          <label className="inline-flex items-center gap-1.5">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
            Replace the {ports.length} ports already placed
          </label>
        ) : null}
        <button type="button" disabled={!canApply} onClick={apply} className="rounded-md bg-brand-600 px-3 py-1.5 font-medium text-white hover:bg-brand-700 disabled:opacity-50">
          {mode === "rename" ? `Rename ${ghosts.length}` : `Add ${ghosts.length} port${ghosts.length === 1 ? "" : "s"}`}
        </button>
        {clash > 0 ? <span role="status" className="text-rose-700 dark:text-rose-300">{clash} name{clash === 1 ? " is" : "s are"} already used. Change the name pattern or number, or replace the existing ports.</span> : null}
        {mode !== "rename" && ghosts.length > 0 && clash === 0 ? <span className="text-slate-500 dark:text-slate-400">Dashed boxes on the picture are the proposal. Add them, then drag any that are off.</span> : null}
      </div>
    </section>
  );
}
