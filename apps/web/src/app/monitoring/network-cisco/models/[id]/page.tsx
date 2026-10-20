"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, FileUp, ImagePlus, Loader2, Save, Trash2 } from "lucide-react";
import { SWITCH_MODEL_SIDES, SWITCH_MODEL_IMAGE_TYPES, switchModelPortsSchema, type SwitchModel, type SwitchModelSide } from "@church/shared";
import { useCanWrite, StatusLine, Field, inputCls } from "../../cisco-ui";
import { PortLayoutEditor } from "@/components/port-layout-editor";
import { StencilImporter } from "@/components/stencil-importer";
import { SwitchFaceplate, type FaceItem } from "@/components/switch-faceplate";
import { commit, fromEditorPorts, redo, startHistory, toEditorPorts, undo, type EditorPort, type History } from "@/lib/faceplates/editor-ops";
import { layoutFromSwitchModel, switchModelImageUrl } from "@/lib/faceplates/custom";
import { errorText } from "@/lib/use-switch-models";

const BASE = "/monitoring/network-cisco/models";
const MAX_MB = 8;

function splitMatch(text: string): string[] {
  return text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

export default function SwitchModelEditorPage() {
  const { id } = useParams<{ id: string }>();
  const canWrite = useCanWrite();
  const [model, setModel] = useState<SwitchModel | null>(null);
  const [missing, setMissing] = useState(false);
  const [name, setName] = useState("");
  const [match, setMatch] = useState("");
  const [hist, setHist] = useState<History<EditorPort[]>>(() => startHistory<EditorPort[]>([]));
  const [saved, setSaved] = useState<EditorPort[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const loadedOnce = useRef(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/switch-models", { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) return;
    const all = (await r.json()) as SwitchModel[];
    const m = all.find((x) => x.id === id) ?? null;
    if (!m) {
      setMissing(true);
      return;
    }
    setModel(m);
    setName(m.name);
    setMatch(m.match.join(", "));
    // The boxes are only taken from the server the first time: a picture upload must not throw away unsaved boxes.
    if (!loadedOnce.current) {
      loadedOnce.current = true;
      const eds = toEditorPorts(m.ports);
      setHist(startHistory(eds));
      setSaved(eds);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const ports = hist.present;
  const dirty = ports !== saved;

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function patch(body: Record<string, unknown>, what: string): Promise<boolean> {
    setBusy(what);
    setStatus(null);
    try {
      const r = await fetch(`/api/switch-models/${id}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        setStatus({ ok: false, text: await errorText(r) });
        return false;
      }
      setModel((await r.json()) as SwitchModel);
      return true;
    } finally {
      setBusy(null);
    }
  }

  async function saveDetails(e: React.FormEvent) {
    e.preventDefault();
    if (await patch({ name, match: splitMatch(match) }, "details")) setStatus({ ok: true, text: "Saved." });
  }

  async function saveLayout() {
    const out = fromEditorPorts(ports);
    const check = switchModelPortsSchema.safeParse(out);
    if (!check.success) {
      setStatus({ ok: false, text: check.error.issues[0]?.message ?? "The layout is not valid." });
      return;
    }
    if (await patch({ ports: out }, "layout")) {
      setSaved(ports);
      setStatus({ ok: true, text: `Layout saved: ${out.length} ports.` });
    }
  }

  async function upload(side: SwitchModelSide, file: File) {
    if (!(SWITCH_MODEL_IMAGE_TYPES as readonly string[]).includes(file.type)) {
      setStatus({ ok: false, text: "The picture must be a PNG, JPEG or WebP file." });
      return;
    }
    if (file.size > MAX_MB * 1024 * 1024) {
      setStatus({ ok: false, text: `That picture is over ${MAX_MB} MB. Save it smaller: about 2000 pixels across is plenty.` });
      return;
    }
    setBusy(`image-${side}`);
    setStatus(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(`/api/switch-models/${id}/images/${side}`, { method: "POST", credentials: "same-origin", body: fd });
      if (!r.ok) {
        setStatus({ ok: false, text: await errorText(r) });
        return;
      }
      setModel((await r.json()) as SwitchModel);
      setStatus({ ok: true, text: `The ${side} picture is saved.` });
    } finally {
      setBusy(null);
    }
  }

  async function removeImage(side: SwitchModelSide) {
    setBusy(`image-${side}`);
    try {
      const r = await fetch(`/api/switch-models/${id}/images/${side}`, { method: "DELETE", credentials: "same-origin" });
      if (!r.ok) setStatus({ ok: false, text: await errorText(r) });
      else setModel((await r.json()) as SwitchModel);
    } finally {
      setBusy(null);
    }
  }

  // The preview is what a switch page would draw, from the SAVED model (so it also proves the saved version is drawable).
  const previewLayout = useMemo(() => (model ? layoutFromSwitchModel(model) : null), [model]);
  const previewItems = useMemo<FaceItem[]>(
    () => (model?.ports ?? []).map((p, i) => ({ id: p.name, slot: p.name, label: p.name, state: i % 3 === 2 ? "down" : i % 7 === 5 ? "shut" : "up", stateText: "example" })),
    [model],
  );

  if (missing) {
    return (
      <div className="space-y-3">
        <Link href={BASE} className="inline-flex items-center gap-1 text-sm text-brand-600 hover:underline dark:text-brand-400">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> All switch models
        </Link>
        <p className="text-sm">That switch model does not exist (it may have been deleted).</p>
      </div>
    );
  }
  if (!model) return <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>;

  const portSide = model.portSide;
  const portImageId = portSide === "front" ? model.frontImageId : model.backImageId;
  const portW = portSide === "front" ? model.frontWidth : model.backWidth;
  const portH = portSide === "front" ? model.frontHeight : model.backHeight;

  const pictureCard = (side: SwitchModelSide) => {
    const imageId = side === "front" ? model.frontImageId : model.backImageId;
    const w = side === "front" ? model.frontWidth : model.backWidth;
    const h = side === "front" ? model.frontHeight : model.backHeight;
    const working = busy === `image-${side}`;
    return (
      <div className="space-y-2 rounded-md border border-slate-300 p-3 dark:border-slate-800" key={side}>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium capitalize">{side} picture</h3>
          <label className="inline-flex items-center gap-1.5 text-xs">
            <input
              type="radio"
              name="port-side"
              checked={portSide === side}
              disabled={!canWrite || busy !== null}
              onChange={() => void patch({ portSide: side }, "side")}
            />
            The ports are on this side
          </label>
        </div>
        {imageId ? (
          // eslint-disable-next-line @next/next/no-img-element -- the admin's own picture
          <img src={switchModelImageUrl(model.id, side, imageId)} alt={`${model.name}, ${side}`} className="max-h-28 w-full rounded border border-slate-200 bg-slate-100 object-contain dark:border-slate-800 dark:bg-slate-900" />
        ) : (
          <p className="rounded border border-dashed border-slate-300 p-4 text-center text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">No {side} picture yet.</p>
        )}
        {w && h ? <p className="text-xs text-slate-500 dark:text-slate-400">{w} × {h} px</p> : null}
        {canWrite ? (
          <div className="flex flex-wrap items-center gap-2">
            <label className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800 ${working ? "opacity-60" : ""}`}>
              {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <ImagePlus className="h-3.5 w-3.5" aria-hidden />}
              {imageId ? "Replace" : "Upload"}
              <input
                type="file"
                accept={SWITCH_MODEL_IMAGE_TYPES.join(",")}
                disabled={busy !== null}
                aria-label={`${imageId ? "Replace" : "Upload"} the ${side} picture`}
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void upload(side, f);
                }}
              />
            </label>
            {imageId ? (
              <button type="button" disabled={busy !== null} onClick={() => void removeImage(side)} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2.5 py-1 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-60 dark:border-slate-700 dark:text-rose-300 dark:hover:bg-rose-900/30">
                <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="space-y-5">
      <Link href={BASE} className="inline-flex items-center gap-1 text-sm text-brand-600 hover:underline dark:text-brand-400">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> All switch models
      </Link>
      <h2 className="text-lg font-semibold">{model.name}</h2>
      <StatusLine status={status} />
      {!canWrite ? <p className="text-sm text-slate-600 dark:text-slate-400">You can look at this model. Changing it needs the monitoring admin tier.</p> : null}

      <form onSubmit={saveDetails} className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <Field label="Name">
          <input required maxLength={80} disabled={!canWrite} value={name} onChange={(e) => setName(e.target.value)} className={`w-full ${inputCls}`} />
        </Field>
        <Field label="Matches (model text, comma separated)">
          <input disabled={!canWrite} value={match} onChange={(e) => setMatch(e.target.value)} placeholder="C3850-48" className={`w-full font-mono text-xs ${inputCls}`} />
        </Field>
        {canWrite ? (
          <button type="submit" disabled={busy !== null} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:hover:bg-slate-800">
            Save details
          </button>
        ) : null}
      </form>

      <section aria-label="Pictures" className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">Pictures</h3>
          {canWrite ? (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => setImporting(true)}
              className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              <FileUp className="h-3.5 w-3.5" aria-hidden /> Import from a stencil or picture file
            </button>
          ) : null}
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Use a straight-on photo of the switch cut to its edges, PNG, JPEG or WebP, up to {MAX_MB} MB (about 2000 pixels across is plenty). The ports are marked on one of them; the other can be shown beside it on the switch page.
          Marked ports are positioned on the picture, so replacing it with one of different proportions means checking them again.
        </p>
        <div className="grid gap-3 md:grid-cols-2">{SWITCH_MODEL_SIDES.map((s) => pictureCard(s))}</div>
      </section>

      <section aria-label="Port layout" className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">Port layout ({portSide})</h3>
          {canWrite && portImageId ? (
            <div className="ml-auto flex items-center gap-2">
              {dirty ? <span className="text-xs text-amber-700 dark:text-amber-300">Unsaved changes</span> : null}
              <button
                type="button"
                disabled={!dirty || busy !== null}
                onClick={() => {
                  setHist(startHistory(saved));
                }}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                Revert
              </button>
              <button type="button" disabled={!dirty || busy !== null} onClick={() => void saveLayout()} className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50">
                {busy === "layout" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Save className="h-3.5 w-3.5" aria-hidden />} Save layout
              </button>
            </div>
          ) : null}
        </div>
        {portImageId && portW && portH ? (
          <PortLayoutEditor
            imageUrl={switchModelImageUrl(model.id, portSide, portImageId)}
            imageWidth={portW}
            imageHeight={portH}
            ports={ports}
            onChange={(next) => setHist((h) => commit(h, next))}
            onUndo={() => setHist((h) => undo(h))}
            onRedo={() => setHist((h) => redo(h))}
            canUndo={hist.past.length > 0}
            canRedo={hist.future.length > 0}
            readOnly={!canWrite}
          />
        ) : (
          <p className="rounded-md border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
            Upload the {portSide} picture to mark the ports on it, or say which side the ports are on above.
          </p>
        )}
      </section>

      {importing ? (
        <StencilImporter
          models={[]}
          fixedModel={model}
          onClose={() => setImporting(false)}
          onDone={(m) => {
            setModel(m);
            setImporting(false);
            setStatus({ ok: true, text: "The pictures are saved. Check the port boxes still sit on the ports." });
          }}
        />
      ) : null}

      <section aria-label="Preview" className="space-y-2">
        <h3 className="text-sm font-semibold">Preview</h3>
        <p className="text-xs text-slate-500 dark:text-slate-400">How a switch of this model looks on its page, from the saved layout (the colours here are only an example).</p>
        {previewLayout ? (
          <SwitchFaceplate layout={previewLayout} items={previewItems} renderDetails={(portId) => <p className="font-mono text-sm font-semibold">{portId}</p>} />
        ) : (
          <p className="text-sm text-slate-500 dark:text-slate-400">Nothing to preview until the port-side picture and at least one saved port exist.</p>
        )}
      </section>
    </div>
  );
}
