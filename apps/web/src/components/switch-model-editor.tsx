"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, FileUp, ImagePlus, Loader2, Save, Trash2 } from "lucide-react";
import {
  SWITCH_MODEL_SIDES,
  SWITCH_MODEL_IMAGE_TYPES,
  switchModelModulesSchema,
  switchModelPortsSchema,
  type SwitchModel,
  type SwitchModelModule,
  type SwitchModelSide,
} from "@church/shared";
import { useCanWrite, StatusLine, Field, inputCls } from "@/app/monitoring/network-cisco/cisco-ui";
import { ModulePlacementEditor } from "@/components/module-placement-editor";
import { PortLayoutEditor } from "@/components/port-layout-editor";
import { StencilImporter } from "@/components/stencil-importer";
import { SwitchFaceplate, type FaceItem } from "@/components/switch-faceplate";
import { commit, fromEditorPorts, redo, startHistory, toEditorPorts, undo, type EditorPort, type History } from "@/lib/faceplates/editor-ops";
import { layoutFromSwitchModel, portLabelOfKey, switchModelImageUrl } from "@/lib/faceplates/custom";
import { nameClashes } from "@/lib/faceplates/module-ops";
import { errorText, normaliseModel } from "@/lib/use-switch-models";

const MAX_MB = 8;

function splitMatch(text: string): string[] {
  return text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

export function SwitchModelEditor({ base: BASE }: { base: string }) {
  const { id } = useParams<{ id: string }>();
  const canWrite = useCanWrite();
  const [model, setModel] = useState<SwitchModel | null>(null);
  const [allModels, setAllModels] = useState<SwitchModel[]>([]);
  const [missing, setMissing] = useState(false);
  const [name, setName] = useState("");
  const [match, setMatch] = useState("");
  const [hist, setHist] = useState<History<EditorPort[]>>(() => startHistory<EditorPort[]>([]));
  const [saved, setSaved] = useState<EditorPort[]>([]);
  const [mods, setMods] = useState<SwitchModelModule[]>([]);
  const [savedMods, setSavedMods] = useState<SwitchModelModule[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const loadedOnce = useRef(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/switch-models", { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) return;
    const all = ((await r.json()) as SwitchModel[]).map(normaliseModel);
    const m = all.find((x) => x.id === id) ?? null;
    if (!m) {
      setMissing(true);
      return;
    }
    setModel(m);
    setAllModels(all);
    setName(m.name);
    setMatch(m.match.join(", "));
    // The boxes are only taken from the server the first time: a picture upload must not throw away unsaved boxes.
    if (!loadedOnce.current) {
      loadedOnce.current = true;
      const eds = toEditorPorts(m.ports);
      setHist(startHistory(eds));
      setSaved(eds);
      setMods(m.modules);
      setSavedMods(m.modules);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const ports = hist.present;
  const portsDirty = ports !== saved;
  const modsDirty = mods !== savedMods;
  const dirty = portsDirty || modsDirty;

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
      setModel(normaliseModel((await r.json()) as SwitchModel));
      return true;
    } finally {
      setBusy(null);
    }
  }

  async function saveDetails(e: React.FormEvent) {
    e.preventDefault();
    if (await patch(isModule ? { name } : { name, match: splitMatch(match) }, "details")) setStatus({ ok: true, text: "Saved." });
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

  async function saveModules() {
    const check = switchModelModulesSchema.safeParse(mods);
    if (!check.success) {
      setStatus({ ok: false, text: check.error.issues[0]?.message ?? "The modules are not valid." });
      return;
    }
    if (await patch({ modules: mods }, "modules")) {
      setSavedMods(mods);
      setStatus({ ok: true, text: mods.length === 0 ? "Modules saved: none on this model." : `Modules saved: ${mods.length} placed.` });
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
      setModel(normaliseModel((await r.json()) as SwitchModel));
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
      else setModel(normaliseModel((await r.json()) as SwitchModel));
    } finally {
      setBusy(null);
    }
  }

  // The preview is what a switch page would draw, from the SAVED model (so it also proves the saved version is drawable).
  const previewLayout = useMemo(() => (model ? layoutFromSwitchModel(model, allModels) : null), [model, allModels]);
  const previewItems = useMemo<FaceItem[]>(
    () => (previewLayout?.ports ?? []).map((p, i) => ({ id: p.key, slot: p.key, label: portLabelOfKey(p.key), state: i % 3 === 2 ? "down" : i % 7 === 5 ? "shut" : "up", stateText: "example" })),
    [previewLayout],
  );
  const isModule = model?.kind === "module";
  const modules = useMemo(() => allModels.filter((m) => m.kind === "module"), [allModels]);
  const clashes = useMemo(() => (model && !isModule ? nameClashes({ ...model, modules: mods }, allModels) : []), [model, isModule, mods, allModels]);

  if (missing) {
    return (
      <div className="space-y-3">
        <Link href={BASE} className="inline-flex items-center gap-1 text-sm text-brand-600 hover:underline dark:text-brand-400">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> All device profiles
        </Link>
        <p className="text-sm">That device profile does not exist (it may have been deleted).</p>
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
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> All device profiles
      </Link>
      <h2 className="text-lg font-semibold">
        {model.name}
        {isModule ? <span className="ml-2 rounded-full bg-slate-200 px-2 py-0.5 align-middle text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">Add-on module</span> : null}
      </h2>
      <StatusLine status={status} />
      {!canWrite ? <p className="text-sm text-slate-600 dark:text-slate-400">You can look at this profile. Changing it needs the monitoring admin tier.</p> : null}

      <form onSubmit={saveDetails} className={`grid items-end gap-3 ${isModule ? "sm:grid-cols-[1fr_auto]" : "sm:grid-cols-[1fr_1fr_auto]"}`}>
        <Field label="Name">
          <input required maxLength={80} disabled={!canWrite} value={name} onChange={(e) => setName(e.target.value)} className={`w-full ${inputCls}`} />
        </Field>
        {isModule ? null : (
          <Field label="Matches (model text, comma separated)">
            <input disabled={!canWrite} value={match} onChange={(e) => setMatch(e.target.value)} placeholder="C3850-48" className={`w-full font-mono text-xs ${inputCls}`} />
          </Field>
        )}
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
          Use a straight-on photo of the {isModule ? "module" : "switch"} cut to its edges, PNG, JPEG or WebP, up to {MAX_MB} MB (about 2000 pixels across is plenty). The ports are marked on one of them; the other can be shown beside it on the switch page.
          Marked ports are positioned on the picture, so replacing it with one of different proportions means checking them again.
        </p>
        <div className="grid gap-3 md:grid-cols-2">{SWITCH_MODEL_SIDES.map((s) => pictureCard(s))}</div>
      </section>

      <section aria-label="Port layout" className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">Port layout ({portSide})</h3>
          {canWrite && portImageId ? (
            <div className="ml-auto flex items-center gap-2">
              {portsDirty ? <span className="text-xs text-amber-700 dark:text-amber-300">Unsaved changes</span> : null}
              <button
                type="button"
                disabled={!portsDirty || busy !== null}
                onClick={() => {
                  setHist(startHistory(saved));
                }}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                Revert
              </button>
              <button type="button" disabled={!portsDirty || busy !== null} onClick={() => void saveLayout()} className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50">
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

      {isModule ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Name each port as the switch does, for the slot it plugs into (for a module in the first switch: <span className="font-mono">Te1/1/1</span>, <span className="font-mono">Te1/1/2</span> ...). If the same cage is called one thing with one setting and another with a different one (<span className="font-mono">Gi1/1/1</span> and <span className="font-mono">Te1/1/1</span>), give the second as an alias.
          Then open a device profile and add this module to it.
        </p>
      ) : (
        <section aria-label="Add-on modules" className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">Add-on modules</h3>
            {canWrite && portImageId ? (
              <div className="ml-auto flex items-center gap-2">
                {modsDirty ? <span className="text-xs text-amber-700 dark:text-amber-300">Unsaved changes</span> : null}
                <button
                  type="button"
                  disabled={!modsDirty || busy !== null}
                  onClick={() => setMods(savedMods)}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
                >
                  Revert
                </button>
                <button type="button" disabled={!modsDirty || busy !== null} onClick={() => void saveModules()} className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50">
                  {busy === "modules" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Save className="h-3.5 w-3.5" aria-hidden />} Save modules
                </button>
              </div>
            ) : null}
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Some switches take a plug-in network module with extra, faster ports (a Catalyst 3750-X&apos;s C3KX-NM-10G, for example). Add the module to the spot where it plugs in and its ports can be used like the switch&apos;s own. A switch shows the module only when it reports one of its ports, so one spot can hold several alternatives.
          </p>
          {clashes.length > 0 ? (
            <ul className="space-y-0.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200" aria-label="Port names used twice">
              {clashes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          ) : null}
          {portImageId && portW && portH ? (
            <ModulePlacementEditor
              host={model}
              hostImageUrl={switchModelImageUrl(model.id, portSide, portImageId)}
              hostSize={{ w: portW, h: portH }}
              placements={mods}
              catalogue={modules}
              onChange={setMods}
              readOnly={!canWrite}
              base={BASE}
            />
          ) : (
            <p className="rounded-md border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
              Upload the {portSide} picture first; modules are placed on it.
            </p>
          )}
        </section>
      )}

      {importing ? (
        <StencilImporter
          models={[]}
          fixedModel={model}
          onClose={() => setImporting(false)}
          onDone={(m) => {
            setModel(normaliseModel(m));
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
