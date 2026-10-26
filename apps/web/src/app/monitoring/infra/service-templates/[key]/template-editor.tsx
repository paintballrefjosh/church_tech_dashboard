"use client";

import { useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { parse } from "yaml";
import { ArrowLeft, Copy, Download, FlaskConical, Loader2, Save, Trash2 } from "lucide-react";
import { templateCommands, type InfraTarget, type ServiceInputValue, type ServiceTemplate, type ServiceTestResult } from "@church/shared";
import { GoneNotice } from "@/components/gone-notice";
import { buildDiff, collapseUnchanged } from "@/lib/wiki-diff";
import { ToastStack, inputCls, useCanWrite, useToasts } from "../../../network-cisco/cisco-ui";
import { CommandList, ConfirmCommandsBox, TestResultView, btnCls, helpCls, labelCls, primaryBtnCls, svcGet, svcSend } from "../../services/services-ui";
import { SaveTemplateConfirm, TemplateYamlField, toYaml, useTemplateYaml } from "../template-yaml";

/**
 * One template. A built-in is shown read-only (fork it to change it); a custom one is edited as YAML, checked as it is
 * typed, tried against a host before saving, and saved with the commands confirmed and the change shown as a diff.
 */
export function TemplateEditor({ templateKey }: { templateKey: string }) {
  const router = useRouter();
  const canWrite = useCanWrite();
  const forkId = useId();
  const hostId = useId();
  const valuesId = useId();
  const [t, setT] = useState<ServiceTemplate | null>(null);
  const [gone, setGone] = useState(false);
  const [text, setText] = useState("");
  const [savedText, setSavedText] = useState("");
  const parsed = useTemplateYaml(text);
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [forkKey, setForkKey] = useState("");
  const [hosts, setHosts] = useState<InfraTarget[]>([]);
  const [hostIdValue, setHostIdValue] = useState("");
  const [testValues, setTestValues] = useState("");
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<ServiceTestResult | null>(null);
  const [testConfirmed, setTestConfirmed] = useState(false);
  const { toasts, show, dismiss } = useToasts();

  useEffect(() => {
    void (async () => {
      const r = await fetch(`/api/service-monitoring/templates/${encodeURIComponent(templateKey)}`, { credentials: "same-origin", cache: "no-store" });
      if (r.status === 404) return setGone(true);
      if (!r.ok) return;
      const tpl = (await r.json()) as ServiceTemplate;
      setT(tpl);
      const y = toYaml(tpl.body);
      setText(y);
      setSavedText(y);
    })();
    void fetch("/api/infra/targets", { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : []))
      .then((list: InfraTarget[]) => setHosts(list));
  }, [templateKey]);

  // A confirmation is for the commands that were read: editing them asks again.
  const commandsKey = parsed.commands.join("\n");
  useEffect(() => {
    setConfirmed(false);
    setTestConfirmed(false);
  }, [commandsKey]);

  const builtin = t?.source === "builtin";
  const editable = canWrite && !builtin;
  const changed = text !== savedText;
  const diff = useMemo(() => (changed ? collapseUnchanged(buildDiff(savedText, text).rows, 2) : []), [changed, savedText, text]);

  function download() {
    const blob = new Blob([text], { type: "text/yaml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${templateKey}.yaml`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function save() {
    if (!parsed.body) return;
    setSaving(true);
    try {
      const saved = await svcSend<ServiceTemplate>(`/templates/${templateKey}`, "PUT", {
        body: parsed.body,
        confirmCommands: parsed.commands.length ? parsed.commands : undefined,
      });
      setT(saved);
      setSavedText(text);
      setConfirmed(false);
      show(true, `Saved as version ${saved.version}. Services using it read it at their next check.`);
    } catch (e) {
      show(false, (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function fork() {
    try {
      const commands = t && t.runsCommands ? templateCommands(t.body) : undefined;
      await svcSend(`/templates/${templateKey}/fork`, "POST", { key: forkKey, confirmCommands: commands });
      router.push(`/monitoring/infra/service-templates/${forkKey}`);
    } catch (e) {
      show(false, (e as Error).message);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete the template ${t?.body.name}?`)) return;
    try {
      await svcSend(`/templates/${templateKey}`, "DELETE");
      router.push("/monitoring/infra/service-templates");
    } catch (e) {
      show(false, (e as Error).message);
    }
  }

  async function runTest() {
    if (!parsed.body) return;
    let values: Record<string, unknown> = {};
    try {
      values = testValues.trim() ? ((parse(testValues) as Record<string, unknown>) ?? {}) : {};
      if (typeof values !== "object" || Array.isArray(values)) throw new Error("not a map");
    } catch {
      return show(false, "The test values must be YAML lines of the form key: value.");
    }
    // Secret inputs go as secrets; everything else as inputs (a login is `{loginId: <id>}`).
    const secretKeys = new Set(parsed.body.inputs.filter((i) => i.type === "secret").map((i) => i.key));
    const inputs: Record<string, ServiceInputValue> = {};
    const secrets: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      if (secretKeys.has(k)) secrets[k] = String(v);
      else inputs[k] = v as ServiceInputValue;
    }
    setTesting(true);
    try {
      setTest(await svcSend<ServiceTestResult>("/test", "POST", {
          targetId: hostIdValue,
          body: parsed.body,
          inputs,
          secrets,
          confirmCommands: parsed.commands.length ? parsed.commands : undefined,
        }));
    } catch (e) {
      show(false, (e as Error).message);
    } finally {
      setTesting(false);
    }
  }

  if (gone) return <GoneNotice what="service template" backHref="/monitoring/infra/service-templates" backLabel="All service templates" />;
  if (!t) return <p className={helpCls}>Loading…</p>;

  return (
    <div className="space-y-5">
      <Link href="/monitoring/infra/service-templates" className="inline-flex items-center gap-1 text-sm text-brand-600 hover:underline dark:text-brand-400">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> All service templates
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t.body.name}</h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            <span className="font-mono">{t.key}</span> · {builtin ? "built-in, read-only" : `custom, version ${t.version}`}
            {t.forkedFrom ? ` · forked from ${t.forkedFrom}` : ""} · used by {t.instances} service{t.instances === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className={btnCls} onClick={download}>
            <Download className="h-4 w-4" aria-hidden /> Export YAML
          </button>
          {editable ? (
            <button className="inline-flex items-center gap-1.5 rounded-md border border-rose-300 px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950" onClick={() => void remove()}>
              <Trash2 className="h-4 w-4" aria-hidden /> Delete
            </button>
          ) : null}
        </div>
      </div>

      {canWrite ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <label htmlFor={forkId} className={labelCls}>
              Fork as (new key)
            </label>
            <input id={forkId} value={forkKey} onChange={(e) => setForkKey(e.target.value.trim())} placeholder={`${t.key}-local`} className={`${inputCls} font-mono`} />
          </div>
          <button className={btnCls} disabled={!/^[a-z][a-z0-9-]{1,47}$/.test(forkKey)} onClick={() => void fork()}>
            <Copy className="h-4 w-4" aria-hidden /> Fork
          </button>
          {t.runsCommands ? <p className={helpCls}>Forking copies its commands: forking counts as confirming them.</p> : null}
        </div>
      ) : null}

      {t.runsCommands ? (
        <div className="space-y-1">
          <p className={labelCls}>Commands this template runs on the host (as saved)</p>
          <CommandList commands={templateCommands(t.body)} />
        </div>
      ) : null}

      <TemplateYamlField text={text} onChange={editable ? setText : undefined} parsed={parsed} readOnly={!editable} />

      {editable && changed ? (
        <section className="space-y-2" aria-label="Changes since saved">
          <p className={labelCls}>Changes since it was saved</p>
          <pre className="max-h-64 overflow-auto rounded-md border border-slate-300 p-2 text-xs dark:border-slate-700" tabIndex={0} aria-label="Changes">
            {diff.map((d) =>
              d.type === "gap" ? (
                <div key={`g${d.id}`} className="text-slate-500 dark:text-slate-400">
                  ... {d.rows.length} unchanged lines
                </div>
              ) : (
                <div
                  key={`${d.row.kind}${d.row.oldNo ?? ""}-${d.row.newNo ?? ""}`}
                  className={
                    d.row.kind === "add"
                      ? "bg-emerald-50 text-emerald-950 dark:bg-emerald-950/40 dark:text-emerald-100"
                      : d.row.kind === "remove"
                        ? "bg-rose-50 text-rose-950 dark:bg-rose-950/40 dark:text-rose-100"
                        : ""
                  }
                >
                  {d.row.kind === "add" ? "+ " : d.row.kind === "remove" ? "- " : "  "}
                  {d.row.text}
                </div>
              ),
            )}
          </pre>
          {parsed.commands.length ? <SaveTemplateConfirm commands={parsed.commands} checked={confirmed} onChange={setConfirmed} /> : null}
          <button className={primaryBtnCls} disabled={saving || !parsed.body || (parsed.commands.length > 0 && !confirmed)} onClick={() => void save()}>
            <Save className="h-4 w-4" aria-hidden /> {saving ? "Saving…" : "Save"}
          </button>
        </section>
      ) : null}

      {canWrite ? (
        <section className="space-y-2 rounded-md border border-slate-300 p-4 dark:border-slate-800" aria-labelledby={`${hostId}-h`}>
          <h2 id={`${hostId}-h`} className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Try it against a host
          </h2>
          <p className={helpCls}>Runs the template as written above once, saving nothing. A login input takes {"{loginId: <id>}"}.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor={hostId} className={labelCls}>
                Host
              </label>
              <select id={hostId} value={hostIdValue} onChange={(e) => setHostIdValue(e.target.value)} className={`${inputCls} w-full`}>
                <option value="">Choose…</option>
                {hosts.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label htmlFor={valuesId} className={labelCls}>
                Values (YAML, key: value)
              </label>
              <textarea id={valuesId} rows={4} value={testValues} onChange={(e) => setTestValues(e.target.value)} className={`${inputCls} w-full font-mono text-xs`} spellCheck={false} />
            </div>
          </div>
          {parsed.commands.length ? (
            <ConfirmCommandsBox commands={parsed.commands} checked={testConfirmed} onChange={setTestConfirmed} />
          ) : null}
          <button className={btnCls} disabled={!hostIdValue || !parsed.body || testing || (parsed.commands.length > 0 && !testConfirmed)} onClick={() => void runTest()}>
            {testing ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden /> : <FlaskConical className="h-4 w-4" aria-hidden />} {testing ? "Testing…" : "Test"}
          </button>
          {test ? <TestResultView result={test} body={parsed.body} /> : null}
        </section>
      ) : null}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
