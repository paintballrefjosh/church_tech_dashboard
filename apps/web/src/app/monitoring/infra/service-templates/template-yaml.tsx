"use client";

import { useId, useMemo } from "react";
import { parse, stringify } from "yaml";
import { BUILTIN_TEMPLATES, serviceTemplateProblems, templateCommands, templateRunsCommands, type ServiceTemplateBody } from "@church/shared";
import { ConfirmCommandsBox, labelCls } from "../services/services-ui";

/**
 * Templates are written as YAML in the web only: the API takes and returns JSON. Parsing here is `yaml`'s plain parse (no
 * custom tags), then the same `serviceTemplateProblems` the API runs on save.
 */

export function toYaml(body: ServiceTemplateBody): string {
  return stringify(body, { lineWidth: 0 });
}

export const starterYaml = toYaml({ ...BUILTIN_TEMPLATES["json-value"]!, name: "My service" });

export interface ParsedTemplate {
  body: ServiceTemplateBody | null;
  problems: string[];
  commands: string[];
}

export function useTemplateYaml(text: string): ParsedTemplate {
  return useMemo(() => {
    let raw: unknown;
    try {
      raw = parse(text, { maxAliasCount: 50 });
    } catch (e) {
      return { body: null, problems: [`YAML: ${(e as Error).message.split("\n")[0]}`], commands: [] };
    }
    const problems = serviceTemplateProblems(raw);
    if (problems.length) return { body: null, problems, commands: [] };
    const body = raw as ServiceTemplateBody;
    return { body, problems: [], commands: templateRunsCommands(body) ? templateCommands(body) : [] };
  }, [text]);
}

export function TemplateYamlField({ text, onChange, parsed, readOnly = false }: { text: string; onChange?: (t: string) => void; parsed: ParsedTemplate; readOnly?: boolean }) {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className={labelCls}>
        Template (YAML)
      </label>
      <textarea
        id={id}
        value={text}
        readOnly={readOnly}
        onChange={(e) => onChange?.(e.target.value)}
        spellCheck={false}
        rows={24}
        aria-describedby={`${id}-state`}
        className="w-full rounded-md border border-slate-300 bg-white p-3 font-mono text-xs leading-5 dark:border-slate-700 dark:bg-slate-950"
        data-testid="template-yaml"
      />
      <div id={`${id}-state`} aria-live="polite">
        {parsed.problems.length ? (
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-rose-700 dark:text-rose-300">
            {parsed.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-emerald-700 dark:text-emerald-400">The template reads correctly.</p>
        )}
      </div>
    </div>
  );
}

export function SaveTemplateConfirm({ commands, checked, onChange }: { commands: string[]; checked: boolean; onChange: (v: boolean) => void }) {
  return <ConfirmCommandsBox commands={commands} checked={checked} onChange={onChange} where="every host a service of this template is on" />;
}
