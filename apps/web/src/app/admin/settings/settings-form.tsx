"use client";

import { useState, useTransition } from "react";
import { findKnownSetting, findTogglePrerequisite } from "@church/shared";

type Known = {
  key: string;
  type: "string" | "boolean" | "number" | "secret" | "json";
  label: string;
  description: string;
  defaultValue: unknown;
  category: string;
};

/**
 * Per-category "Test connection" buttons. Each entry knows how to translate
 * the form's flat `values` map (keyed by full setting keys like "smtp.host")
 * into the body expected by /api/admin/test/<target>; `target` defaults to the
 * category slug. A category can carry several (Monitoring tests both UniFi and
 * DNS). Categories not listed don't show a Test button.
 */
interface TestHandler {
  label: string;
  target?: string;
  build: (values: Record<string, unknown>) => Record<string, unknown>;
}

const TEST_HANDLERS: Record<string, TestHandler[]> = {
  smtp: [{
    label: "Test SMTP",
    build: (v) => ({
      host: v["smtp.host"],
      port: v["smtp.port"],
      username: v["smtp.username"],
      password: v["smtp.password"],
      secure: v["smtp.secure"],
      fromEmail: v["smtp.from_email"],
      fromName: v["smtp.from_name"],
    }),
  }],
  google: [{
    label: "Test Google OAuth",
    build: (v) => ({
      clientId: v["google.oauth.client_id"],
      clientSecret: v["google.oauth.client_secret"],
    }),
  }],
  propresenter: [{
    label: "Test ProPresenter",
    build: (v) => ({
      host: v["propresenter.host"],
      port: v["propresenter.port"],
      password: v["propresenter.password"],
    }),
  }],
  monitoring: [{
    label: "Test UniFi connection",
    build: (v) => ({
      baseUrl: v["unifi.controller_url"],
      apiKey: v["unifi.api_key"],
      siteId: v["unifi.site_id"],
      verifyTls: v["unifi.verify_tls"],
    }),
  }, {
    label: "Test DNS connection",
    target: "dns",
    build: (v) => ({
      baseUrl: v["dns.primary_url"],
      apiToken: v["dns.api_token"],
      verifyTls: v["dns.verify_tls"],
    }),
  }],
};

/**
 * Renders a flat list of setting fields. Callers pre-filter `known` to the
 * category they want (see /admin/settings/[category]/page.tsx); the form
 * itself doesn't know or care about category groupings.
 */
export function SettingsForm({
  known,
  current,
  category,
}: {
  known: Known[];
  current: Record<string, unknown>;
  category?: string;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const out: Record<string, unknown> = {};
    for (const s of known) out[s.key] = s.key in current ? current[s.key] : s.defaultValue;
    return out;
  });
  // Secret fields the user has explicitly asked to wipe. Tracked separately
  // from `values` because the secret <input> always starts blank (we never
  // round-trip the stored ciphertext to the browser), so we can't distinguish
  // "leave it alone" from "clear it" via the field value itself.
  const [clearedSecrets, setClearedSecrets] = useState<Set<string>>(new Set());
  const [saving, startTransition] = useTransition();
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const testHandlers = category ? TEST_HANDLERS[category] ?? [] : [];

  /**
   * For a provider "enable" toggle, report which prerequisite credentials are
   * still missing. Checks `current` (the full saved settings map, not just this
   * category) because the credentials are saved on the provider's own page. The
   * API enforces the same rule on save; this is the matching UI affordance so
   * the toggle is disabled rather than failing the save.
   */
  function lockedToggle(
    key: string,
  ): { hint: string; href: string } | null {
    const prereq = findTogglePrerequisite(key);
    if (!prereq) return null;
    const missing = prereq.requires.filter((r) => {
      const v = current[r];
      return typeof v === "string" ? v.trim() === "" : !v;
    });
    if (missing.length === 0) return null;
    const labels = missing.map((r) => findKnownSetting(r)?.label ?? r);
    return {
      hint: `Set the ${labels.join(" and ")} first.`,
      href: `/admin/settings/${prereq.categorySlug}`,
    };
  }

  function setVal(key: string, v: unknown) {
    setValues((prev) => ({ ...prev, [key]: v }));
  }

  function markCleared(key: string) {
    setClearedSecrets((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }
  function unmarkCleared(key: string) {
    setClearedSecrets((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }

  async function runTest(handler: TestHandler) {
    if (!category) return;
    setStatus(null);
    setTesting(true);
    try {
      const payload = handler.build(values);
      const target = handler.target ?? category;
      const r = await fetch(`/api/admin/test/${encodeURIComponent(target)}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      let parsed: { ok?: boolean; message?: string } = {};
      try {
        parsed = (await r.json()) as typeof parsed;
      } catch {
        /* keep body empty so we surface the http status below */
      }
      if (!r.ok) {
        setStatus({
          kind: "err",
          text: parsed.message ?? `Request failed (HTTP ${r.status})`,
        });
        return;
      }
      setStatus({
        kind: parsed.ok ? "ok" : "err",
        text: parsed.message ?? (parsed.ok ? "OK" : "Failed"),
      });
    } catch (err) {
      setStatus({ kind: "err", text: (err as Error).message || String(err) });
    } finally {
      setTesting(false);
    }
  }

  function onSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus(null);
    startTransition(async () => {
      // Persist any value that has changed from `current`. Skip secrets that look
      // unchanged (empty string from a masked input) so we don't wipe them by
      // accident — but if the user explicitly clicked "Clear", send an
      // explicit empty string regardless.
      const tasks: Promise<Response>[] = [];
      for (const s of known) {
        const next = values[s.key];
        const prev = s.key in current ? current[s.key] : s.defaultValue;
        if (s.type === "secret") {
          if (clearedSecrets.has(s.key)) {
            tasks.push(saveOne(s.key, ""));
            continue;
          }
          if (next === "") continue;
        }
        if (JSON.stringify(next) === JSON.stringify(prev)) continue;
        tasks.push(saveOne(s.key, next));
      }
      if (tasks.length === 0) {
        setStatus({ kind: "ok", text: "Nothing to save." });
        return;
      }
      const results = await Promise.all(tasks);
      const failures = results.filter((r) => !r.ok);
      if (failures.length) {
        // Surface the API's reason (e.g. "Set the Google OAuth Client ID … first")
        // instead of a bare count so the operator knows what to fix.
        const messages = await Promise.all(
          failures.map(async (r) => {
            try {
              const body = (await r.json()) as { error?: unknown };
              return typeof body.error === "string" ? body.error : null;
            } catch {
              return null;
            }
          }),
        );
        const detail = messages.filter((m): m is string => Boolean(m));
        setStatus({
          kind: "err",
          text: detail.length
            ? detail.join(" ")
            : `${failures.length} setting(s) failed to save.`,
        });
      } else {
        setStatus({ kind: "ok", text: `Saved ${tasks.length} setting(s).` });
        setClearedSecrets(new Set());
      }
    });
  }

  function saveOne(key: string, value: unknown): Promise<Response> {
    return fetch(`/admin/settings/save/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value }),
      credentials: "same-origin",
    });
  }

  return (
    <form onSubmit={onSave} className="mt-6 space-y-6">
      <div className="divide-y divide-slate-200 rounded-md border border-slate-300 dark:divide-slate-800 dark:border-slate-800">
        {known.map((s) => (
          <SettingField
            key={s.key}
            setting={s}
            value={values[s.key]}
            onChange={(v) => setVal(s.key, v)}
            hasStoredValue={Boolean(s.key in current && current[s.key])}
            cleared={clearedSecrets.has(s.key)}
            onClear={() => markCleared(s.key)}
            onUndoClear={() => unmarkCleared(s.key)}
            locked={s.type === "boolean" ? lockedToggle(s.key) : null}
          />
        ))}
      </div>

      {status ? (
        <p
          role="status"
          className={`rounded-md border px-3 py-2 text-sm ${
            status.kind === "ok"
              ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
              : "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300"
          }`}
        >
          {status.text}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={saving || testing}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
        {testHandlers.map((h) => (
          <button
            key={h.label}
            type="button"
            onClick={() => void runTest(h)}
            disabled={saving || testing}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            {testing ? "Testing…" : h.label}
          </button>
        ))}
      </div>
    </form>
  );
}

function SettingField({
  setting,
  value,
  onChange,
  hasStoredValue,
  cleared,
  onClear,
  onUndoClear,
  locked,
}: {
  setting: Known;
  value: unknown;
  onChange: (v: unknown) => void;
  /** True when a non-empty value is already stored server-side. Secrets use this to decide whether to offer a Clear button. */
  hasStoredValue: boolean;
  /** True when the user has clicked Clear on this secret — save will send an explicit empty string. */
  cleared: boolean;
  onClear: () => void;
  onUndoClear: () => void;
  /** Non-null for a toggle whose prerequisites aren't met: disables it and shows why. */
  locked: { hint: string; href: string } | null;
}) {
  return (
    <div className="grid gap-2 p-4 sm:grid-cols-[1fr_2fr]">
      <div>
        <div className="font-mono text-xs text-slate-500 dark:text-slate-400">{setting.key}</div>
        <div className="text-sm font-medium">{setting.label}</div>
        <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{setting.description}</div>
      </div>
      <div>
        {setting.type === "boolean" ? (
          <div className="space-y-1">
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={Boolean(value) && !locked}
                disabled={Boolean(locked)}
                onChange={(e) => onChange(e.target.checked)}
              />
              <span className={locked ? "text-slate-400 dark:text-slate-500" : undefined}>
                Enabled
              </span>
            </label>
            {locked ? (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                {locked.hint}{" "}
                <a href={locked.href} className="underline hover:no-underline">
                  Open settings
                </a>
              </p>
            ) : null}
          </div>
        ) : setting.type === "number" ? (
          <input
            type="number"
            value={typeof value === "number" ? value : 0}
            onChange={(e) => onChange(Number(e.target.value))}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
        ) : setting.type === "secret" ? (
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <input
                type="password"
                placeholder={
                  cleared
                    ? "(will be cleared on save)"
                    : hasStoredValue
                      ? "(unchanged)"
                      : ""
                }
                disabled={cleared}
                onChange={(e) => onChange(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100 disabled:text-slate-500 dark:border-slate-700 dark:bg-slate-950 dark:disabled:bg-slate-800"
              />
              {hasStoredValue && !cleared ? (
                <button
                  type="button"
                  onClick={onClear}
                  className="shrink-0 rounded-md border border-slate-300 px-2 py-2 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  Clear
                </button>
              ) : cleared ? (
                <button
                  type="button"
                  onClick={onUndoClear}
                  className="shrink-0 rounded-md border border-slate-300 px-2 py-2 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  Undo
                </button>
              ) : null}
            </div>
            {cleared ? (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                This value will be removed when you save.
              </p>
            ) : null}
          </div>
        ) : setting.type === "json" ? (
          <textarea
            value={typeof value === "string" ? value : JSON.stringify(value ?? "", null, 2)}
            onChange={(e) => {
              try {
                onChange(JSON.parse(e.target.value));
              } catch {
                onChange(e.target.value);
              }
            }}
            rows={5}
            className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
          />
        ) : (
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={typeof value === "string" ? value : value == null ? "" : String(value)}
              onChange={(e) => onChange(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
            />
            {typeof value === "string" && value.length > 0 ? (
              <button
                type="button"
                onClick={() => onChange("")}
                className="shrink-0 rounded-md border border-slate-300 px-2 py-2 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Clear
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
