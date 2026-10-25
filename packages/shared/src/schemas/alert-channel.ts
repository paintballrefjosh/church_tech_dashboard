import { z } from "zod";

/**
 * Alert channels: places outside the dashboard that monitoring alerts are also sent to (a team chat, a phone app, an
 * SMS number, an automation's webhook). Site-wide, configured by the monitoring admin tier, separate from each person's
 * own bell/email/push choices. The request each type makes is built by the pure `buildAlertRequest`
 * (`packages/shared/src/alert-channels.ts`).
 */

export const ALERT_CHANNEL_TYPES = ["ntfy", "pushover", "slack", "teams", "discord", "webhook", "twilio"] as const;
export type AlertChannelType = (typeof ALERT_CHANNEL_TYPES)[number];

export const ALERT_CHANNEL_TYPE_LABELS: Record<AlertChannelType, string> = {
  ntfy: "ntfy",
  pushover: "Pushover",
  slack: "Slack",
  teams: "Microsoft Teams",
  discord: "Discord",
  webhook: "Webhook (JSON)",
  twilio: "SMS (Twilio)",
};

/** What a channel is sent: `outages` (down, back up, escalated, unstable) or `everything` (also config changes, reboots). */
export const ALERT_CHANNEL_EVENTS = ["outages", "everything"] as const;
export type AlertChannelEvents = (typeof ALERT_CHANNEL_EVENTS)[number];

const httpsUrl = z
  .string()
  .trim()
  .url()
  .max(500)
  .refine((u) => /^https?:\/\//i.test(u), "Must be an http or https address");

const e164 = z.string().trim().regex(/^\+[1-9]\d{6,14}$/, "A phone number in international form, like +441234567890");

/** The non-secret settings of each type. The secret (token, webhook address) is a separate field, never returned. */
export const alertChannelConfigSchemas = {
  ntfy: z.object({ server: httpsUrl.default("https://ntfy.sh"), topic: z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, "Letters, digits, - and _") }).strict(),
  pushover: z.object({ userKey: z.string().trim().regex(/^[A-Za-z0-9]{30}$/, "The 30-character user or group key") }).strict(),
  slack: z.object({}).strict(),
  teams: z.object({}).strict(),
  discord: z.object({}).strict(),
  webhook: z.object({ url: httpsUrl }).strict(),
  twilio: z
    .object({
      accountSid: z.string().trim().regex(/^AC[0-9a-f]{32}$/, "The account SID, AC followed by 32 hex digits"),
      from: e164,
      to: z.array(e164).min(1).max(10),
    })
    .strict(),
} as const;

/** Which types need a secret, and what the form calls it. */
export const ALERT_CHANNEL_SECRET: Record<AlertChannelType, { required: boolean; label: string }> = {
  ntfy: { required: false, label: "Access token (only for a protected topic)" },
  pushover: { required: true, label: "Application API token" },
  slack: { required: true, label: "Incoming webhook URL" },
  teams: { required: true, label: "Workflow webhook URL" },
  discord: { required: true, label: "Webhook URL" },
  webhook: { required: false, label: "Signing secret (sent as an HMAC-SHA256 signature)" },
  twilio: { required: true, label: "Auth token" },
};

const base = {
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  events: z.enum(ALERT_CHANNEL_EVENTS).default("outages"),
};

export const createAlertChannelSchema = z
  .object({
    ...base,
    type: z.enum(ALERT_CHANNEL_TYPES),
    config: z.record(z.unknown()).default({}),
    secret: z.string().max(2000).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const parsed = alertChannelConfigSchemas[v.type].safeParse(v.config);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: ["config", ...issue.path] });
    }
    if (ALERT_CHANNEL_SECRET[v.type].required && !v.secret?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["secret"], message: `${ALERT_CHANNEL_SECRET[v.type].label} is required` });
    }
  });
export type CreateAlertChannelInput = z.infer<typeof createAlertChannelSchema>;

/** A change. `secret` left out keeps the saved one; an empty string removes it (where the type allows none). */
export const updateAlertChannelSchema = z
  .object({
    name: base.name.optional(),
    enabled: z.boolean().optional(),
    events: z.enum(ALERT_CHANNEL_EVENTS).optional(),
    config: z.record(z.unknown()).optional(),
    secret: z.string().max(2000).optional(),
  })
  .strict();
export type UpdateAlertChannelInput = z.infer<typeof updateAlertChannelSchema>;

/** What the API returns: never the secret, only whether one is saved. */
export interface AlertChannel {
  id: string;
  name: string;
  type: AlertChannelType;
  enabled: boolean;
  events: AlertChannelEvents;
  config: Record<string, unknown>;
  hasSecret: boolean;
  lastSentAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  createdAt: string;
  updatedAt: string;
}
