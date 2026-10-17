/**
 * Tickets from email: the rules that decide what a received message becomes. Pure, so the poller, the tests and the
 * settings page agree. Nothing here talks to a mail server.
 */

export const INBOUND_KEYS = {
  enabled: "tickets.inbound.enabled",
  host: "tickets.inbound.host",
  port: "tickets.inbound.port",
  secure: "tickets.inbound.secure",
  rejectUnauthorized: "tickets.inbound.reject_unauthorized",
  username: "tickets.inbound.username",
  password: "tickets.inbound.password",
  mailbox: "tickets.inbound.mailbox",
  address: "tickets.inbound.address",
  auth: "tickets.inbound.auth",
  authServer: "tickets.inbound.auth_server",
} as const;

/**
 * How sure we must be that a message really comes from the address in its From line (anyone can write any From):
 *  - strict:  the receiving mail server recorded DMARC pass.
 *  - aligned: it recorded a DKIM or SPF pass for the sender's own domain.
 *  - off:     trust the From line. Only for a mailbox nobody outside can write to.
 */
export const INBOUND_AUTH_MODES = ["strict", "aligned", "off"] as const;
export type InboundAuthMode = (typeof INBOUND_AUTH_MODES)[number];
export const INBOUND_AUTH_DEFAULT: InboundAuthMode = "strict";

/** A message bigger than this is left alone (marked as read, logged), never downloaded in full. */
export const INBOUND_MAX_MESSAGE_BYTES = 30 * 1024 * 1024;
export const INBOUND_MAX_ATTACHMENTS = 10;
export const INBOUND_BODY_MAX = 19_000;

export function inboundAuthMode(raw: unknown): InboundAuthMode {
  return typeof raw === "string" && (INBOUND_AUTH_MODES as readonly string[]).includes(raw) ? (raw as InboundAuthMode) : INBOUND_AUTH_DEFAULT;
}

/** What happened to a message, as the log shows it. */
export const INBOUND_OUTCOMES = ["ticket", "comment", "skipped", "error"] as const;
export type InboundOutcome = (typeof INBOUND_OUTCOMES)[number];

export const INBOUND_SKIP_REASONS = {
  auto_generated: "An automatic message (out-of-office, bounce, newsletter).",
  own_mail: "Sent by this site itself.",
  unknown_sender: "The sender is not an account on this site.",
  not_authenticated: "The sender's address could not be confirmed by the mail server.",
  no_access: "The account may not open tickets.",
  too_large: "The message is too large.",
  empty: "The message had no text.",
  no_sender: "The message has no sender address.",
  rate_limited: "Too many messages from this sender in the last hour.",
} as const;
export type InboundSkipReason = keyof typeof INBOUND_SKIP_REASONS;

// ---- subject ----

/** The ticket a subject names with its `[#123]` token, or null. Only the bracketed form counts, a bare #5 is just text. */
export function ticketNumberInSubject(subject: string): number | null {
  const m = /\[#(\d{1,9})\]/.exec(subject);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The token to put in the subject of mail about a ticket, so a reply finds its way back. */
export function ticketSubjectToken(number: number): string {
  return `[#${number}]`;
}

/** A subject as a ticket title: no Re:/Fwd: prefixes or `[#n]` tokens, one line, at most 200 characters. */
export function cleanSubject(subject: string): string {
  let s = subject.replace(/[\r\n\t]+/g, " ").replace(/\[#\d{1,9}\]/g, " ");
  for (;;) {
    const next = s.replace(/^\s*(re|fwd?|aw|wg|sv|vs|tr|r)\s*(\[\d+\])?\s*:\s*/i, "");
    if (next === s) break;
    s = next;
  }
  s = s.replace(/\s+/g, " ").trim();
  if (s === "") return "(no subject)";
  return s.length > 200 ? `${s.slice(0, 197)}...` : s;
}

// ---- body ----

const REPLY_HEADER_LINE = /^\s*(on\s.{3,300}\swrote:|le\s.{3,300}\sa\s[eé]crit\s?:|am\s.{3,300}\sschrieb.{0,60}:)\s*$/i;

/**
 * The part of a reply the person actually wrote: the quoted original (lines starting with `>`), the "On ... wrote:" line
 * and everything after it, an Outlook header block and the signature delimiter are cut. If that leaves nothing the whole
 * text is returned, so a message is never lost to over-eager trimming.
 */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const pair = `${line} ${lines[i + 1] ?? ""}`;
    if (line === "-- " || line === "--") break;
    if (/^\s*-{2,}\s*(original message|forwarded message)\s*-{2,}\s*$/i.test(line)) break;
    if (REPLY_HEADER_LINE.test(line) || (i + 1 < lines.length && REPLY_HEADER_LINE.test(pair) && /^\s*on\s/i.test(line) && !/wrote:\s*$/i.test(line))) break;
    // An Outlook style block: "From: x", then "Sent:"/"Date:" and "To:"/"Subject:" lines.
    if (/^\s*(from|de|von)\s*:\s*\S/i.test(line) && /^\s*(sent|date|envoy[eé]|gesendet)\s*:/i.test(lines[i + 1] ?? "")) break;
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }
  const trimmed = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return trimmed === "" ? text.replace(/\r\n?/g, "\n").trim() : trimmed;
}

// ---- who sent it ----

export interface AuthResults {
  /** The name of the server that wrote the header (the first word), lower case. */
  serverId: string | null;
  dmarc: string | null;
  dkim: Array<{ result: string; domain: string | null }>;
  spf: { result: string; domain: string | null } | null;
}

/**
 * Read an Authentication-Results header (RFC 8601) as the receiving mail server wrote it. Only the part after the server's
 * own identifier matters; each method looks like `dkim=pass header.d=example.org`.
 */
export function parseAuthResults(header: string | null | undefined): AuthResults {
  const out: AuthResults = { serverId: null, dmarc: null, dkim: [], spf: null };
  if (!header) return out;
  const flat = header.replace(/\r?\n\s*/g, " ").replace(/\([^)]*\)/g, " ");
  const parts = flat.split(";");
  out.serverId = (parts[0] ?? "").trim().split(/\s+/)[0]?.toLowerCase() || null;
  for (const part of parts.slice(1)) {
    const p = part.trim();
    const m = /^(dmarc|dkim|spf)\s*=\s*([a-z]+)\b(.*)$/i.exec(p);
    if (!m) continue;
    const method = m[1]!.toLowerCase();
    const result = m[2]!.toLowerCase();
    const rest = m[3] ?? "";
    if (method === "dmarc") {
      out.dmarc ??= result;
    } else if (method === "dkim") {
      const d = /header\.d\s*=\s*"?([^\s";]+)/i.exec(rest) ?? /header\.i\s*=\s*"?@?([^\s";]+)/i.exec(rest);
      out.dkim.push({ result, domain: d ? domainOf(d[1]!) : null });
    } else if (!out.spf) {
      const d = /smtp\.mailfrom\s*=\s*"?([^\s";]+)/i.exec(rest) ?? /smtp\.helo\s*=\s*"?([^\s";]+)/i.exec(rest);
      out.spf = { result, domain: d ? domainOf(d[1]!) : null };
    }
  }
  return out;
}

function domainOf(value: string): string {
  const at = value.lastIndexOf("@");
  return (at >= 0 ? value.slice(at + 1) : value).toLowerCase().replace(/[>"']+$/g, "");
}

/** The domain of an email address, lower-cased, or null. */
export function addressDomain(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at < 1 || at === address.length - 1) return null;
  return address.slice(at + 1).trim().toLowerCase();
}

/** True when two domains are the same or one is a subdomain of the other (a mail system may send from mail.example.org). */
function related(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * Which Authentication-Results header to believe among the ones a message carries (in message order, topmost first). The
 * topmost one is the last server's; the sender can add headers of their own, but only BELOW the receiving server's. A server
 * that adds none (some do not) would leave the sender's forged one on top, so when `serverName` is set only a header written
 * by that server counts (its first word equals the name or ends with it).
 */
export function pickAuthResultsHeader(headers: ReadonlyArray<string>, serverName: string): string | null {
  const want = serverName.trim().toLowerCase();
  for (const h of headers) {
    if (want === "") return h;
    const id = parseAuthResults(h).serverId;
    if (id && (id === want || id.endsWith(`.${want}`))) return h;
  }
  return null;
}

/**
 * Is the From address backed by what the mail server checked? `header` comes from `pickAuthResultsHeader`: lower headers can
 * be forged by the sender, so the caller must not pass any other.
 */
export function senderAuthenticated(mode: InboundAuthMode, fromAddress: string, header: string | null | undefined): boolean {
  if (mode === "off") return true;
  const res = parseAuthResults(header);
  if (res.dmarc === "pass") return true;
  if (mode === "strict") return false;
  const domain = addressDomain(fromAddress);
  if (res.dkim.some((d) => d.result === "pass" && related(d.domain, domain))) return true;
  return res.spf !== null && res.spf.result === "pass" && related(res.spf.domain, domain);
}

/** Why a message is a machine's and not a person's (so no ticket is made from it), or null. Header names are lower case. */
export function autoGeneratedReason(headers: ReadonlyMap<string, string> | Record<string, string | undefined>): InboundSkipReason | null {
  const get = (k: string): string | undefined => (headers instanceof Map ? headers.get(k) : (headers as Record<string, string | undefined>)[k]);
  const auto = get("auto-submitted")?.trim().toLowerCase();
  if (auto && auto !== "no") return "auto_generated";
  const precedence = get("precedence")?.trim().toLowerCase();
  if (precedence && ["bulk", "junk", "list", "auto_reply"].includes(precedence)) return "auto_generated";
  if (get("x-auto-response-suppress") !== undefined || get("x-autoreply") !== undefined || get("x-autorespond") !== undefined) return "auto_generated";
  if (get("list-unsubscribe") !== undefined && get("list-id") !== undefined) return "auto_generated";
  return null;
}
