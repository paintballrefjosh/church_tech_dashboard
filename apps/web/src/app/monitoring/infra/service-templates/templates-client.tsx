"use client";

import { useCallback, useEffect, useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { KeyRound, Pencil, Plus, Terminal, Trash2, Upload } from "lucide-react";
import { SAVED_SECRET, type ServiceLogin, type ServiceTemplate } from "@church/shared";
import { DialogFrame } from "@/components/modal";
import { ToastStack, inputCls, useCanWrite, useToasts } from "../../network-cisco/cisco-ui";
import { btnCls, helpCls, labelCls, primaryBtnCls, svcGet, svcSend } from "../services/services-ui";
import { TemplateYamlField, starterYaml, useTemplateYaml, SaveTemplateConfirm } from "./template-yaml";

/** Service templates (built-in and custom) and, for those who may change monitoring, the saved logins. */
export function ServiceTemplatesClient() {
  const canWrite = useCanWrite();
  const [tab, setTab] = useState<"templates" | "logins">("templates");
  const { toasts, show, dismiss } = useToasts();
  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <div>
          <h2 className="text-lg font-semibold">Service templates</h2>
          <p className="max-w-2xl text-sm text-slate-500 dark:text-slate-400">
            A template says how to read one kind of service on an infra host (its status page, a query, a command), which numbers to keep and when to
            alert. Built-in templates cannot be changed: fork one to make your own. Add a service from a host&apos;s page.
          </p>
        </div>
      </header>
      <div className="flex gap-1 border-b border-slate-200 dark:border-slate-800" role="tablist" aria-label="Service templates sections">
        {(["templates", "logins"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${tab === t ? "border-brand-600 font-medium text-brand-700 dark:text-brand-300" : "border-transparent text-slate-600 dark:text-slate-300"}`}
          >
            {t === "templates" ? "Templates" : "Logins"}
          </button>
        ))}
      </div>
      {tab === "templates" ? <TemplatesTab canWrite={canWrite} show={show} /> : <LoginsTab canWrite={canWrite} show={show} />}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

type Show = (ok: boolean, text: string) => void;

function TemplatesTab({ canWrite, show }: { canWrite: boolean; show: Show }) {
  const [list, setList] = useState<ServiceTemplate[] | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    void svcGet<ServiceTemplate[]>("/templates").then((t) => setList(t ?? []));
  }, []);

  return (
    <section className="space-y-3" aria-label="Templates">
      {canWrite ? (
        <div className="flex justify-end">
          <button className={primaryBtnCls} onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" aria-hidden /> New template
          </button>
        </div>
      ) : null}
      {list === null ? (
        <p className={helpCls}>Loading…</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-slate-300 dark:border-slate-800" tabIndex={0} role="region" aria-label="Service templates">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs text-slate-600 dark:bg-slate-900 dark:text-slate-300">
              <tr>
                <th className="px-3 py-2 font-medium">Template</th>
                <th className="px-3 py-2 font-medium">Kind</th>
                <th className="px-3 py-2 font-medium">Reads with</th>
                <th className="px-3 py-2 text-right font-medium">Services</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {list.map((t) => (
                <tr key={t.key}>
                  <td className="px-3 py-2">
                    <Link href={`/monitoring/infra/service-templates/${t.key}`} className="font-medium text-brand-600 hover:underline dark:text-brand-400">
                      {t.body.name}
                    </Link>
                    {t.body.description ? <span className="block text-xs text-slate-500 dark:text-slate-400">{t.body.description}</span> : null}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {t.source === "builtin" ? "Built-in" : `Custom${t.forkedFrom ? ` (from ${t.forkedFrom})` : ""}, v${t.version}`}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {[...new Set(Object.values(t.body.collect).map((c) => c.transport))].join(", ")}
                    {t.runsCommands ? (
                      <span className="ml-1 inline-flex items-center gap-0.5 text-amber-800 dark:text-amber-300">
                        <Terminal className="h-3 w-3" aria-hidden /> commands
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{t.instances}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating ? <NewTemplateModal onClose={() => setCreating(false)} show={show} /> : null}
    </section>
  );
}

function NewTemplateModal({ onClose, show }: { onClose: () => void; show: Show }) {
  const router = useRouter();
  const titleId = useId();
  const keyId = useId();
  const fileId = useId();
  const [key, setKey] = useState("");
  const [text, setText] = useState(starterYaml);
  const parsed = useTemplateYaml(text);
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const keyOk = /^[a-z][a-z0-9-]{1,47}$/.test(key);

  async function save() {
    if (!parsed.body) return;
    setSaving(true);
    setErr(null);
    try {
      await svcSend(`/templates/${key}`, "PUT", { body: parsed.body, confirmCommands: parsed.commands.length ? parsed.commands : undefined });
      show(true, "Template saved.");
      router.push(`/monitoring/infra/service-templates/${key}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <DialogFrame
      onClose={onClose}
      labelledBy={titleId}
      closeOnBackdrop={false}
      className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-slate-300 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900"
    >
      <h2 id={titleId} className="mb-3 text-base font-semibold">
        New service template
      </h2>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label htmlFor={keyId} className={labelCls}>
              Key (lower-case letters, digits and -)
            </label>
            <input id={keyId} value={key} onChange={(e) => setKey(e.target.value.trim())} className={`${inputCls} w-full font-mono`} placeholder="my-service" />
          </div>
          <div className="space-y-1">
            <label htmlFor={fileId} className={labelCls}>
              Import a YAML file
            </label>
            <span className="flex items-center gap-2">
              <Upload className="h-4 w-4 text-slate-500 dark:text-slate-400" aria-hidden />
              <input
                id={fileId}
                type="file"
                accept=".yaml,.yml,text/yaml,text/plain"
                className="text-xs"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void f.text().then(setText);
                }}
              />
            </span>
          </div>
        </div>
        <TemplateYamlField text={text} onChange={setText} parsed={parsed} />
        {parsed.commands.length ? <SaveTemplateConfirm commands={parsed.commands} checked={confirmed} onChange={setConfirmed} /> : null}
        {err ? (
          <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">
            {err}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button className={btnCls} onClick={onClose}>
            Cancel
          </button>
          <button className={primaryBtnCls} disabled={saving || !keyOk || !parsed.body || (parsed.commands.length > 0 && !confirmed)} onClick={() => void save()}>
            {saving ? "Saving…" : "Save template"}
          </button>
        </div>
      </div>
    </DialogFrame>
  );
}

function LoginsTab({ canWrite, show }: { canWrite: boolean; show: Show }) {
  const [list, setList] = useState<ServiceLogin[] | null>(null);
  const [editing, setEditing] = useState<ServiceLogin | "new" | null>(null);
  const load = useCallback(async () => setList((await svcGet<ServiceLogin[]>("/logins")) ?? []), []);
  useEffect(() => {
    if (canWrite) void load();
  }, [canWrite, load]);

  if (!canWrite) return <p className={helpCls}>Only people who may change monitoring can see the saved logins.</p>;

  async function remove(l: ServiceLogin) {
    if (!window.confirm(`Delete the login ${l.name}?`)) return;
    try {
      await svcSend(`/logins/${l.id}`, "DELETE");
      show(true, "Login deleted.");
      void load();
    } catch (e) {
      show(false, (e as Error).message);
    }
  }

  return (
    <section className="space-y-3" aria-label="Logins">
      <div className="flex flex-wrap items-center gap-3">
        <p className={`${helpCls} max-w-2xl`}>
          A login (user name and password) that several services share, such as a read-only database user. The password is stored encrypted and never shown
          again.
        </p>
        <button className={`${primaryBtnCls} ml-auto`} onClick={() => setEditing("new")}>
          <Plus className="h-4 w-4" aria-hidden /> Add login
        </button>
      </div>
      {list === null ? (
        <p className={helpCls}>Loading…</p>
      ) : list.length === 0 ? (
        <p className={helpCls}>No saved logins.</p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-md border border-slate-300 dark:divide-slate-800 dark:border-slate-800">
          {list.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
              <KeyRound className="h-4 w-4 text-slate-500 dark:text-slate-400" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="font-medium">{l.name}</span> <span className="font-mono text-xs">{l.username}</span>
                <span className="block text-xs text-slate-500 dark:text-slate-400">
                  {l.hasPassword ? "password saved" : "no password"} · used by {l.instances} service{l.instances === 1 ? "" : "s"}
                  {l.note ? ` · ${l.note}` : ""}
                </span>
              </span>
              <button className={btnCls} onClick={() => setEditing(l)} aria-label={`Edit login ${l.name}`}>
                <Pencil className="h-4 w-4" aria-hidden />
              </button>
              <button className={btnCls} onClick={() => void remove(l)} aria-label={`Delete login ${l.name}`}>
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <LoginModal
          login={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            show(true, "Login saved.");
            void load();
          }}
        />
      ) : null}
    </section>
  );
}

function LoginModal({ login, onClose, onSaved }: { login: ServiceLogin | null; onClose: () => void; onSaved: () => void }) {
  const titleId = useId();
  const id = useId();
  const [name, setName] = useState(login?.name ?? "");
  const [username, setUsername] = useState(login?.username ?? "");
  const [password, setPassword] = useState("");
  const [note, setNote] = useState(login?.note ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      // An empty box keeps the saved password (sending `[saved]`); a new login without one has none.
      const pw = password !== "" ? password : login?.hasPassword ? SAVED_SECRET : undefined;
      const body = { name, username, password: pw, note };
      if (login) await svcSend(`/logins/${login.id}`, "PATCH", body);
      else await svcSend("/logins", "POST", body);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <DialogFrame onClose={onClose} labelledBy={titleId} className="w-full max-w-lg rounded-lg border border-slate-300 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900">
      <h2 id={titleId} className="mb-3 text-base font-semibold">
        {login ? `Edit ${login.name}` : "Add a login"}
      </h2>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {(
          [
            ["name", "Name", name, setName, "text"],
            ["user", "User name", username, setUsername, "text"],
            ["pw", "Password", password, setPassword, "password"],
            ["note", "Note", note, setNote, "text"],
          ] as const
        ).map(([k, label, value, set, type]) => (
          <div key={k} className="space-y-1">
            <label htmlFor={`${id}-${k}`} className={labelCls}>
              {label}
            </label>
            <input
              id={`${id}-${k}`}
              type={type}
              autoComplete={type === "password" ? "new-password" : "off"}
              value={value}
              placeholder={k === "pw" && login?.hasPassword ? "saved (type to replace)" : ""}
              onChange={(e) => set(e.target.value)}
              className={`${inputCls} w-full`}
              required={k === "name" || k === "user"}
            />
          </div>
        ))}
        {err ? (
          <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">
            {err}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnCls} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={primaryBtnCls} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </DialogFrame>
  );
}
