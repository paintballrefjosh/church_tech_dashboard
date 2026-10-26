import type { AlertChannelEvents, AlertChannelType } from "./schemas/alert-channel";

/**
 * Pure rules for alert channels (see schemas/alert-channel.ts): which notices a channel is sent, and the exact HTTP
 * request each type makes. The API sends what these return; unit-tested in apps/api/test/alert-channels.test.ts.
 */

/** Down, back up, escalated, unstable: what an "outages" channel is sent. Each kind carries its recovery too. */
export const OUTAGE_ALERT_KINDS: ReadonlyArray<string> = [
  "monitor.incident.opened",
  "monitor.incident.resolved",
  "monitor.incident.escalated",
  "monitor.flapping",
  "infra.alert.opened",
  "infra.alert.resolved",
  "unifi.device_offline",
  "cisco.device_offline",
  "dns.primary_unreachable",
  "cluster.node_down",
  // A livestream that is not live when it should be, or has no picture or sound; its recovery says "is back".
  "livestream.problem",
];

/** Also sent to an "everything" channel: changes that are worth knowing but are not an outage. */
export const OTHER_ALERT_KINDS: ReadonlyArray<string> = ["cisco.config_change", "cisco.uptime_change"];

/** Whether any channel could want this notice (the notification service queues only these). */
export function isAlertKind(kind: string): boolean {
  return OUTAGE_ALERT_KINDS.includes(kind) || OTHER_ALERT_KINDS.includes(kind);
}

export function channelWantsAlert(events: AlertChannelEvents, kind: string): boolean {
  if (OUTAGE_ALERT_KINDS.includes(kind)) return true;
  return events === "everything" && OTHER_ALERT_KINDS.includes(kind);
}

export type AlertSeverity = "problem" | "recovery" | "info";

/**
 * Problem or recovery. Some kinds carry both (a UniFi device going offline and coming back share one kind), so the title
 * decides there; the wording is the senders' own ("is back up", "is back online", "recovered", "is back", "stable again").
 */
export function alertSeverity(kind: string, title: string): AlertSeverity {
  if (kind.endsWith(".resolved")) return "recovery";
  if (/\b(is back|back online|back up|recovered|stable again)\b/i.test(title)) return "recovery";
  if (OTHER_ALERT_KINDS.includes(kind)) return "info";
  return "problem";
}

export interface AlertEvent {
  kind: string;
  title: string;
  body: string;
  /** Absolute address of the page about it, or null when the site's own address is unknown. */
  url: string | null;
  at: Date;
}

export interface AlertRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

export interface AlertChannelForSend {
  type: AlertChannelType;
  config: Record<string, unknown>;
  secret: string | null;
}

export interface AlertContext {
  siteName: string;
  /** HMAC-SHA256 of `data` with `key`, hex. Passed in so this file stays free of Node's crypto. */
  sign: (key: string, data: string) => string;
  /** Base64 of a string (for HTTP Basic). */
  base64: (s: string) => string;
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

/** Slack's mrkdwn treats &, < and > as markup. */
function slackEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** The request(s) that deliver `event` to a channel. Twilio sends one per number. */
export function buildAlertRequests(channel: AlertChannelForSend, event: AlertEvent, ctx: AlertContext): AlertRequest[] {
  const severity = alertSeverity(event.kind, event.title);
  const json = (url: string, payload: unknown, extra: Record<string, string> = {}): AlertRequest => ({
    url,
    method: "POST",
    headers: { "content-type": "application/json", ...extra },
    body: JSON.stringify(payload),
  });
  const form = (url: string, fields: Record<string, string>, extra: Record<string, string> = {}): AlertRequest => ({
    url,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...extra },
    body: new URLSearchParams(fields).toString(),
  });
  const secret = channel.secret ?? "";

  switch (channel.type) {
    case "ntfy": {
      // JSON publishing to the server root: titles in any language survive (a `Title` header must be ASCII).
      const server = str(channel.config.server, "https://ntfy.sh").replace(/\/+$/, "");
      return [
        json(
          `${server}/`,
          {
            topic: str(channel.config.topic),
            title: clip(event.title, 250),
            message: clip(event.body || event.title, 4000),
            priority: severity === "problem" ? 4 : 3,
            tags: [severity === "problem" ? "rotating_light" : severity === "recovery" ? "white_check_mark" : "information_source"],
            ...(event.url ? { click: event.url } : {}),
          },
          secret ? { authorization: `Bearer ${secret}` } : {},
        ),
      ];
    }
    case "pushover":
      return [
        form("https://api.pushover.net/1/messages.json", {
          token: secret,
          user: str(channel.config.userKey),
          title: clip(event.title, 250),
          message: clip(event.body || event.title, 1024),
          priority: severity === "problem" ? "1" : "0",
          ...(event.url ? { url: event.url, url_title: "Open in the dashboard" } : {}),
        }),
      ];
    case "slack": {
      const link = event.url ? `\n<${event.url}|Open in ${slackEscape(ctx.siteName)}>` : "";
      return [json(secret, { text: `*${slackEscape(event.title)}*\n${slackEscape(event.body)}${link}` })];
    }
    case "discord": {
      const link = event.url ? `\n${event.url}` : "";
      // allowed_mentions: a title or body that contains "@everyone" must not ping a server.
      return [json(secret, { content: clip(`**${event.title}**\n${event.body}${link}`, 2000), allowed_mentions: { parse: [] } })];
    }
    case "teams":
      // A Workflows "post to a channel when a webhook request is received" flow takes an Adaptive Card.
      return [
        json(secret, {
          type: "message",
          attachments: [
            {
              contentType: "application/vnd.microsoft.card.adaptive",
              contentUrl: null,
              content: {
                $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
                type: "AdaptiveCard",
                version: "1.4",
                body: [
                  { type: "TextBlock", text: event.title, weight: "Bolder", size: "Medium", wrap: true },
                  { type: "TextBlock", text: event.body, wrap: true },
                ],
                actions: event.url ? [{ type: "Action.OpenUrl", title: `Open in ${ctx.siteName}`, url: event.url }] : [],
              },
            },
          ],
        }),
      ];
    case "webhook": {
      const at = event.at.toISOString();
      const payload = { event: "alert", kind: event.kind, severity, title: event.title, body: event.body, url: event.url, site: ctx.siteName, at };
      const body = JSON.stringify(payload);
      const headers: Record<string, string> = { "content-type": "application/json", "x-church-event": "alert" };
      if (secret) {
        // Signed over "<timestamp>.<body>", so a captured request cannot be replayed later with a fresh timestamp.
        const ts = String(Math.floor(event.at.getTime() / 1000));
        headers["x-church-timestamp"] = ts;
        headers["x-church-signature"] = `sha256=${ctx.sign(secret, `${ts}.${body}`)}`;
      }
      return [{ url: str(channel.config.url), method: "POST", headers, body }];
    }
    case "twilio": {
      const sid = str(channel.config.accountSid);
      const from = str(channel.config.from);
      const to = Array.isArray(channel.config.to) ? channel.config.to.filter((n): n is string => typeof n === "string") : [];
      const text = clip(`${event.title}${event.url ? ` ${event.url}` : ""}`, 320);
      const auth = { authorization: `Basic ${ctx.base64(`${sid}:${secret}`)}` };
      return to.map((n) =>
        form(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, { To: n, From: from, Body: text }, auth),
      );
    }
  }
}

/** Hosts the fixed-destination types may post to (their webhook URL is the secret, so it is checked here). */
const ALLOWED_HOSTS: Partial<Record<AlertChannelType, (host: string) => boolean>> = {
  slack: (h) => h === "hooks.slack.com",
  discord: (h) => ["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"].includes(h),
  teams: (h) => /\.logic\.azure\.com$/.test(h) || /\.powerplatform\.com$/.test(h) || /\.webhook\.office\.com$/.test(h),
};

/** Address literals no alert may go to: link-local (cloud metadata lives there) and the unspecified address. */
export function isForbiddenAlertAddress(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (/^169\.254\./.test(h) || h === "0.0.0.0" || h === "::" || h === "metadata.google.internal") return true;
  if (/^fe[89ab][0-9a-f]:/.test(h) || h === "fd00:ec2::254") return true;
  return false;
}

/**
 * Why a destination address is refused, or null when it is fine. https is required for the hosted chat services; a
 * self-hosted ntfy or webhook may be http on the LAN. Never credentials in the URL, never a link-local address.
 */
export function alertDestinationProblem(type: AlertChannelType, raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "That is not a web address.";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "Only http and https addresses can be used.";
  if (u.username || u.password) return "Put the credentials in the secret field, not in the address.";
  if (isForbiddenAlertAddress(u.hostname)) return "That address is link-local (where cloud metadata services live) and is not allowed.";
  const allow = ALLOWED_HOSTS[type];
  if (allow) {
    if (u.protocol !== "https:") return "This service's webhook addresses start with https://.";
    if (!allow(u.hostname.toLowerCase())) return `That does not look like a ${type === "teams" ? "Microsoft Teams workflow" : type} webhook address.`;
  }
  return null;
}

/** The address a channel posts to, for the checks above (null for the types with a fixed one). */
export function alertDestinationOf(type: AlertChannelType, config: Record<string, unknown>, secret: string | null): string | null {
  switch (type) {
    case "slack":
    case "discord":
    case "teams":
      return secret;
    case "ntfy":
      return str(config.server, "https://ntfy.sh");
    case "webhook":
      return str(config.url);
    default:
      return null;
  }
}
