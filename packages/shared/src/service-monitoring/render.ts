/**
 * Filling `{{placeholders}}` (template.ts says where each may appear). How a value goes in depends on where: this file is
 * the one place that decides, so a template can never choose to concatenate a value into a command line unquoted.
 */

export interface PlaceholderValue {
  value: string;
  secret: boolean;
}

export type RenderMode = "plain" | "shell" | "url" | "header";

export class RenderError extends Error {}

/** A value as ONE shell word: single-quoted, any `'` inside closed, escaped and reopened. */
export function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

const URL_SAFE = /^[A-Za-z0-9._~:@\-[\]/%?=&;+,!*$()]*$/;

/**
 * Fills a string. `vars` holds every input by key (`host`, `port`, `login.user`, `login.password`); a placeholder with
 * no value becomes "" (an optional input left blank).
 */
export function renderPlaceholders(s: string, vars: Record<string, PlaceholderValue>, mode: RenderMode): string {
  return s.replace(/\{\{\s*([a-z][a-z0-9_]*(?:\.(?:user|password))?)\s*\}\}/g, (match, key: string, offset: number) => {
    const v = vars[key]?.value ?? "";
    if (/[\r\n\0]/.test(v)) throw new RenderError(`${key} holds a line break`);
    switch (mode) {
      case "shell":
        return shellQuote(v);
      case "url": {
        if (!URL_SAFE.test(v)) throw new RenderError(`${key} holds characters that cannot go in an address`);
        // An IPv6 address right after "//" is a host and needs brackets.
        const before = s.slice(0, offset);
        if (/\/\/$/.test(before) && v.includes(":") && !v.startsWith("[")) return `[${v}]`;
        return v;
      }
      default:
        void match;
        return v;
    }
  });
}

/** The values that must never be printed (a test run's output, an error line) because they are secrets. */
export function secretValues(vars: Record<string, PlaceholderValue>): string[] {
  return Object.values(vars)
    .filter((v) => v.secret && v.value.length >= 4)
    .map((v) => v.value);
}

/** Replaces every secret value in a text with [hidden]. */
export function hideSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("[hidden]");
  return out;
}
