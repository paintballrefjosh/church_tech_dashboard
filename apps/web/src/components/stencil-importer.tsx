"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ImageOff, Loader2, Upload } from "lucide-react";
import type { SwitchModel } from "@church/shared";
import { BigModal } from "@/app/monitoring/network-cisco/cisco-ui";
import { errorText } from "@/lib/use-switch-models";
import { readStencilFile } from "@/lib/stencils/read-file";
import { renderPicture } from "@/lib/stencils/rasterize";
import { guessMatch, guessName, guessSide } from "@/lib/stencils/hints";
import { NONE, assign, defaultPortSide, sideOf, uploadName, type Assignment, type Side } from "@/lib/stencils/selection";
import type { StencilPicture } from "@/lib/stencils/types";

const ACCEPT = ".vss,.vssx,.vsd,.vsdx,.ppt,.pptx,.zip,.emf,.png,.jpg,.jpeg,.webp,.gif,.bmp,.svg";
const field = "rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950";

/** Draws pictures one at a time, so a stencil with hundreds of them does not stall the page. */
let thumbQueue: Promise<unknown> = Promise.resolve();
function queueThumb(p: StencilPicture, cancelled: () => boolean): Promise<{ url: string } | { error: string }> {
  const job = thumbQueue.then(async () => {
    if (cancelled()) return { error: "Not drawn." };
    try {
      const r = await renderPicture(p, 700);
      return { url: URL.createObjectURL(r.blob) };
    } catch (e) {
      return { error: (e as Error).message || "This picture could not be drawn." };
    }
  });
  thumbQueue = job.catch(() => undefined);
  return job;
}

function Thumb({ picture, onState }: { picture: StencilPicture; onState: (ok: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ url: string } | { error: string } | null>(null);
  const started = useRef(false);
  const gone = useRef(false);
  const cb = useRef(onState);
  cb.current = onState;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    gone.current = false;
    const go = () => {
      if (started.current) return;
      started.current = true;
      void queueThumb(picture, () => gone.current).then((s) => {
        if (gone.current) {
          if ("url" in s) URL.revokeObjectURL(s.url);
          return;
        }
        setState(s);
        cb.current("url" in s);
      });
    };
    if (typeof IntersectionObserver === "undefined") {
      go();
      return () => {
        gone.current = true;
      };
    }
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && go(), { rootMargin: "300px" });
    io.observe(el);
    return () => {
      gone.current = true;
      io.disconnect();
    };
  }, [picture]);

  useEffect(() => {
    const url = state && "url" in state ? state.url : null;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [state]);

  return (
    <div ref={ref} className="flex h-36 items-center justify-center overflow-hidden rounded border border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-800">
      {state && "url" in state ? (
        // eslint-disable-next-line @next/next/no-img-element -- a local picture drawn from the file the admin chose
        <img src={state.url} alt={picture.name ?? picture.source} className="max-h-full max-w-full object-contain" />
      ) : state ? (
        <span className="flex items-center gap-1.5 px-3 text-center text-xs text-slate-600 dark:text-slate-400">
          <ImageOff className="h-4 w-4 shrink-0" aria-hidden /> {state.error}
        </span>
      ) : (
        <Loader2 className="h-5 w-5 animate-spin text-slate-500 dark:text-slate-400" aria-label="Drawing the picture" />
      )}
    </div>
  );
}

function splitMatch(text: string): string[] {
  return text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

type Phase = { kind: "pick" } | { kind: "reading"; text: string } | { kind: "choose" } | { kind: "importing"; text: string };

/**
 * Brings pictures into a device profile from a file the admin has: a Visio stencil (.vss, .vssx, .vsd, .vsdx), a PowerPoint
 * file, a zip of those (a vendor's stencil download as it comes), or a plain picture. The file is read in this browser;
 * only the pictures chosen are uploaded. Used from the models list (it makes the model) and from a model's own page
 * (`fixedModel`: the pictures go to that model).
 */
export function StencilImporter({
  models,
  fixedModel,
  onClose,
  onDone,
}: {
  models: SwitchModel[];
  fixedModel?: SwitchModel | null;
  onClose: () => void;
  /** Called with the model after its pictures are saved. */
  onDone: (model: SwitchModel) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [pictures, setPictures] = useState<StencilPicture[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [drawable, setDrawable] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState("");
  const [choice, setChoice] = useState<Assignment>(NONE);
  const [target, setTarget] = useState<"new" | "existing">(fixedModel ? "existing" : "new");
  const [existingId, setExistingId] = useState(fixedModel?.id ?? models[0]?.id ?? "");
  const [name, setName] = useState("");
  const [match, setMatch] = useState("");
  const [portSide, setPortSide] = useState<Side>("front");
  const [asModule, setAsModule] = useState(false);
  const [dragging, setDragging] = useState(false);
  const nameTouched = useRef(false);

  const byId = useMemo(() => new Map(pictures.map((p) => [p.id, p])), [pictures]);
  const hints = useMemo(() => new Map(pictures.map((p) => [p.id, guessSide(p)])), [pictures]);

  async function readFile(file: File) {
    setError(null);
    setFileName(file.name);
    setPhase({ kind: "reading", text: `Reading ${file.name}` });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await readStencilFile(file.name, bytes, { onProgress: (text) => setPhase({ kind: "reading", text }) });
      if (result.pictures.length === 0) {
        setError(result.notes.join(" ") || "No pictures were found in that file.");
        setPhase({ kind: "pick" });
        return;
      }
      setPictures(result.pictures);
      setNotes(result.notes);
      setDrawable({});
      nameTouched.current = false;
      // one picture on its own (a plain image) is taken as the front unless its words say otherwise
      if (result.pictures.length === 1) {
        const only = result.pictures[0]!;
        const side = guessSide(only) ?? "front";
        setChoice(assign(NONE, only.id, side));
        setPortSide(side);
        const n = guessName(only) ?? file.name.replace(/\.[^.]+$/, "");
        setName(n);
        setMatch(guessMatch(guessName(only)).join(", "));
      } else {
        setChoice(NONE);
        setName("");
        setMatch("");
      }
      setPhase({ kind: "choose" });
    } catch (e) {
      setError((e as Error).message || "That file could not be read.");
      setPhase({ kind: "pick" });
    }
  }

  function choose(id: string, side: Side | null) {
    const next = assign(choice, id, side);
    setChoice(next);
    setPortSide(defaultPortSide(next));
    // the first picture chosen suggests a name and match for a new model, until the admin types their own
    if (side && !nameTouched.current) {
      const p = byId.get(id);
      if (p) {
        const n = guessName(p) ?? "";
        setName(n);
        setMatch(guessMatch(n).join(", "));
      }
    }
  }

  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return pictures;
    return pictures.filter((p) => `${p.name ?? ""} ${p.description ?? ""} ${p.source}`.toLowerCase().includes(f));
  }, [pictures, filter]);

  const setDrawableFor = useCallback((id: string, ok: boolean) => setDrawable((d) => (d[id] === ok ? d : { ...d, [id]: ok })), []);

  async function importNow() {
    setError(null);
    const sides: Side[] = (["front", "back"] as const).filter((s) => choice[s]);
    if (sides.length === 0) {
      setError("Choose a front or a back picture first.");
      return;
    }
    const target_ = fixedModel ?? (target === "existing" ? models.find((m) => m.id === existingId) : null);
    if (!target_ && !name.trim()) {
      setError("Give the new model a name.");
      return;
    }
    try {
      setPhase({ kind: "importing", text: "Drawing the pictures" });
      const rendered = new Map<Side, Awaited<ReturnType<typeof renderPicture>>>();
      for (const s of sides) rendered.set(s, await renderPicture(byId.get(choice[s]!)!, 3200));

      let model: SwitchModel | null = target_ ?? null;
      let modelId = target_?.id ?? "";
      if (!model) {
        setPhase({ kind: "importing", text: "Creating the model" });
        const r = await fetch("/api/switch-models", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: name.trim(), kind: asModule ? "module" : "switch", match: asModule ? [] : splitMatch(match), portSide }),
        });
        if (!r.ok) throw new Error(await errorText(r));
        model = (await r.json()) as SwitchModel;
        modelId = model.id;
      }
      const label = model.name;
      for (const s of sides) {
        setPhase({ kind: "importing", text: `Saving the ${s} picture` });
        const out = rendered.get(s)!;
        const fd = new FormData();
        fd.append("file", out.blob, uploadName(label, s, out.blob.type));
        const r = await fetch(`/api/switch-models/${modelId}/images/${s}`, { method: "POST", credentials: "same-origin", body: fd });
        if (!r.ok) throw new Error(`The ${s} picture was not saved: ${await errorText(r)}${target_ ? "" : ` The model "${label}" was created without it.`}`);
        model = (await r.json()) as SwitchModel;
      }
      onDone(model);
    } catch (e) {
      setError((e as Error).message || "The import failed.");
      setPhase({ kind: "choose" });
    }
  }

  const busy = phase.kind === "reading" || phase.kind === "importing";

  return (
    <BigModal
      title="Import pictures from a file"
      subtitle={fixedModel ? `Into ${fixedModel.name}` : "Into a new or an existing device profile"}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="space-y-4 p-4 text-sm">
        {phase.kind === "pick" || phase.kind === "reading" ? (
          <div className="space-y-3">
            <p className="max-w-3xl text-slate-600 dark:text-slate-400">
              Choose a file with pictures of your switches: a Visio stencil (<span className="font-mono text-xs">.vss .vssx .vsd .vsdx</span>), a PowerPoint file (<span className="font-mono text-xs">.ppt .pptx</span>), a
              vendor&apos;s stencil download as it comes (a <span className="font-mono text-xs">.zip</span>), or a plain picture (PNG, JPEG, WebP, GIF, BMP, SVG, EMF). The file is read in your browser; only the
              pictures you choose are uploaded here.
            </p>
            <label
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const f = e.dataTransfer.files?.[0];
                if (f && !busy) void readFile(f);
              }}
              className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-10 text-center focus-within:ring-2 focus-within:ring-brand-500 ${dragging ? "border-brand-500 bg-brand-50 dark:bg-brand-900/20" : "border-slate-300 dark:border-slate-700"} ${busy ? "opacity-60" : ""}`}
            >
              {phase.kind === "reading" ? <Loader2 className="h-8 w-8 animate-spin text-slate-500 dark:text-slate-400" aria-hidden /> : <Upload className="h-8 w-8 text-slate-500 dark:text-slate-400" aria-hidden />}
              <span className="font-medium">{phase.kind === "reading" ? phase.text : "Drop a file here, or click to choose one"}</span>
              <input
                type="file"
                accept={ACCEPT}
                disabled={busy}
                aria-label="Choose a stencil or picture file"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void readFile(f);
                }}
              />
            </label>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="flex items-start gap-2 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {error}
          </p>
        ) : null}

        {phase.kind === "choose" || phase.kind === "importing" ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-slate-600 dark:text-slate-400">
                <span className="font-medium text-slate-900 dark:text-slate-100">{pictures.length}</span> picture{pictures.length === 1 ? "" : "s"} in {fileName}. Mark one as the <strong>front</strong> and one as the <strong>back</strong>.
              </p>
              {pictures.length > 6 ? (
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter by name or description…"
                  aria-label="Filter the pictures"
                  className={`ml-auto w-72 ${field}`}
                />
              ) : null}
              <button type="button" disabled={busy} onClick={() => { setPhase({ kind: "pick" }); setPictures([]); setError(null); }} className="rounded-md border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:hover:bg-slate-800">
                Choose another file
              </button>
            </div>
            {notes.length ? (
              <details className="text-xs text-slate-600 dark:text-slate-400">
                <summary className="cursor-pointer">Notes about this file ({notes.length})</summary>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              </details>
            ) : null}

            <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label="Pictures in the file">
              {visible.map((p) => {
                const side = sideOf(choice, p.id);
                const ok = drawable[p.id] !== false;
                const hint = hints.get(p.id);
                return (
                  <li key={p.id} className={`space-y-2 rounded-md border p-2 [content-visibility:auto] ${side ? "border-brand-500 ring-1 ring-brand-500" : "border-slate-300 dark:border-slate-800"}`}>
                    <Thumb picture={p} onState={(good) => setDrawableFor(p.id, good)} />
                    <div className="min-w-0">
                      <p className="truncate font-medium" title={p.name ?? undefined}>{p.name ?? "(no name)"}</p>
                      {p.description ? <p className="line-clamp-2 text-xs text-slate-600 dark:text-slate-400" title={p.description}>{p.description}</p> : null}
                      <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">
                        {p.kind.toUpperCase()}, {p.source.replace(/^.*?, /, "")}
                        {hint ? ` · looks like the ${hint}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5" role="group" aria-label={`Use ${p.name ?? "this picture"} as`}>
                      {(["front", "back"] as const).map((s) => (
                        <button
                          key={s}
                          type="button"
                          aria-pressed={side === s}
                          disabled={busy || !ok}
                          onClick={() => choose(p.id, side === s ? null : s)}
                          className={`rounded-md border px-2.5 py-1 text-xs capitalize disabled:opacity-50 ${side === s ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"}`}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
            {visible.length === 0 ? <p className="text-slate-500 dark:text-slate-400">No pictures match that filter.</p> : null}

            <div className="sticky bottom-0 -mx-4 -mb-4 space-y-3 border-t border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
              {fixedModel ? (
                <p>
                  The chosen picture{choice.front && choice.back ? "s replace" : " replaces"} the {[choice.front ? "front" : null, choice.back ? "back" : null].filter(Boolean).join(" and ")} picture of <strong>{fixedModel.name}</strong>. Its port boxes stay where they are.
                </p>
              ) : (
                <div className="grid gap-3 md:grid-cols-[auto_1fr]">
                  <fieldset className="flex items-center gap-4">
                    <legend className="sr-only">Where the pictures go</legend>
                    <label className="inline-flex items-center gap-1.5">
                      <input type="radio" name="target" checked={target === "new"} disabled={busy} onChange={() => setTarget("new")} /> A new model
                    </label>
                    <label className={`inline-flex items-center gap-1.5 ${models.length === 0 ? "opacity-50" : ""}`}>
                      <input type="radio" name="target" checked={target === "existing"} disabled={busy || models.length === 0} onChange={() => setTarget("existing")} /> An existing model
                    </label>
                  </fieldset>
                  {target === "new" ? (
                    <div className="grid gap-2 sm:grid-cols-3">
                      <label className="block">
                        <span className="text-xs text-slate-600 dark:text-slate-400">Name</span>
                        <input value={name} maxLength={80} disabled={busy} onChange={(e) => { nameTouched.current = true; setName(e.target.value); }} className={`w-full ${field}`} />
                      </label>
                      {asModule ? (
                        <p className="self-end text-xs text-slate-600 dark:text-slate-400">A module is placed on a device profile afterwards; it is never matched to a switch itself.</p>
                      ) : (
                        <label className="block">
                          <span className="text-xs text-slate-600 dark:text-slate-400">Matches (model text, comma separated)</span>
                          <input value={match} disabled={busy} onChange={(e) => { nameTouched.current = true; setMatch(e.target.value); }} placeholder="WS-C3850-48" className={`w-full font-mono text-xs ${field}`} />
                        </label>
                      )}
                      <label className="block">
                        <span className="text-xs text-slate-600 dark:text-slate-400">The ports are on the</span>
                        <select value={portSide} disabled={busy} onChange={(e) => setPortSide(e.target.value as Side)} className={`w-full ${field}`}>
                          <option value="front">front</option>
                          <option value="back">back</option>
                        </select>
                      </label>
                      <label className="inline-flex items-center gap-1.5 sm:col-span-3">
                        <input type="checkbox" checked={asModule} disabled={busy} onChange={(e) => setAsModule(e.target.checked)} />
                        <span>This is an add-on module (such as a C3KX-NM-10G), not a switch</span>
                      </label>
                    </div>
                  ) : (
                    <label className="block">
                      <span className="text-xs text-slate-600 dark:text-slate-400">Model (its chosen sides are replaced)</span>
                      <select value={existingId} disabled={busy} onChange={(e) => setExistingId(e.target.value)} className={`w-full ${field}`}>
                        {models.map((m) => (
                          <option key={m.id} value={m.id}>{m.kind === "module" ? `${m.name} (module)` : m.name}</option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
              )}
              <div className="flex items-center justify-end gap-2">
                {phase.kind === "importing" ? (
                  <span className="mr-auto inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-400">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {phase.text}…
                  </span>
                ) : null}
                <button type="button" disabled={busy} onClick={onClose} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700">Cancel</button>
                <button
                  type="button"
                  disabled={busy || (!choice.front && !choice.back)}
                  onClick={() => void importNow()}
                  className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
                >
                  {fixedModel || target === "existing" ? "Import the pictures" : "Create the model and import"}
                </button>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </BigModal>
  );
}
