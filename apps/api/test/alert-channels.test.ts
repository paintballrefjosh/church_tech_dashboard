import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  alertDestinationProblem,
  alertSeverity,
  buildAlertRequests,
  channelWantsAlert,
  createAlertChannelSchema,
  isAlertKind,
  type AlertEvent,
} from "@church/shared";

const ctx = {
  siteName: "St Example",
  sign: (key: string, data: string) => createHmac("sha256", key).update(data).digest("hex"),
  base64: (s: string) => Buffer.from(s).toString("base64"),
};
const down: AlertEvent = {
  kind: "monitor.incident.opened",
  title: "Livestream encoder is down",
  body: "HTTP check failed: timeout",
  url: "https://dash.example.org/monitoring/abc",
  at: new Date("2026-10-25T09:00:00Z"),
};

describe("which alerts a channel gets", () => {
  it("outages: down, up, escalations; everything: also config changes", () => {
    expect(channelWantsAlert("outages", "monitor.incident.opened")).toBe(true);
    expect(channelWantsAlert("outages", "cisco.config_change")).toBe(false);
    expect(channelWantsAlert("everything", "cisco.config_change")).toBe(true);
    expect(channelWantsAlert("everything", "ticket.comment")).toBe(false);
    expect(isAlertKind("wiki.updated")).toBe(false);
  });
  it("tells a recovery from a problem, also when one kind carries both", () => {
    expect(alertSeverity("monitor.incident.resolved", "Encoder is back up")).toBe("recovery");
    expect(alertSeverity("unifi.device_offline", "UniFi device recovered: AP Hall")).toBe("recovery");
    expect(alertSeverity("cisco.device_offline", "core-sw is back online")).toBe("recovery");
    expect(alertSeverity("cisco.device_offline", "core-sw is offline")).toBe("problem");
    expect(alertSeverity("cisco.uptime_change", "core-sw rebooted")).toBe("info");
  });
});

describe("the request each type sends", () => {
  it("ntfy publishes JSON to the server root, with the token only when there is one", () => {
    const [r] = buildAlertRequests({ type: "ntfy", config: { server: "https://ntfy.example.org/", topic: "church-it" }, secret: null }, down, ctx);
    expect(r!.url).toBe("https://ntfy.example.org/");
    const body = JSON.parse(r!.body);
    expect(body).toMatchObject({ topic: "church-it", title: down.title, priority: 4, click: down.url });
    expect(r!.headers.authorization).toBeUndefined();
    const [withToken] = buildAlertRequests({ type: "ntfy", config: { topic: "t" }, secret: "tk_1" }, down, ctx);
    expect(withToken!.headers.authorization).toBe("Bearer tk_1");
  });
  it("Slack escapes its markup and Discord never pings", () => {
    const evil: AlertEvent = { ...down, title: "<!channel> & <@U1>", body: "@everyone look" };
    const [slack] = buildAlertRequests({ type: "slack", config: {}, secret: "https://hooks.slack.com/services/x" }, evil, ctx);
    expect(JSON.parse(slack!.body).text).toContain("&lt;!channel&gt; &amp; &lt;@U1&gt;");
    const [discord] = buildAlertRequests({ type: "discord", config: {}, secret: "https://discord.com/api/webhooks/1/x" }, evil, ctx);
    expect(JSON.parse(discord!.body).allowed_mentions).toEqual({ parse: [] });
  });
  it("a signed webhook can be checked by the receiver", () => {
    const [r] = buildAlertRequests({ type: "webhook", config: { url: "https://n8n.example.org/hook" }, secret: "s3cret" }, down, ctx);
    const ts = r!.headers["x-church-timestamp"]!;
    const expected = createHmac("sha256", "s3cret").update(`${ts}.${r!.body}`).digest("hex");
    expect(r!.headers["x-church-signature"]).toBe(`sha256=${expected}`);
    expect(JSON.parse(r!.body)).toMatchObject({ kind: down.kind, severity: "problem", site: "St Example" });
  });
  it("Twilio sends one message per number, short, with HTTP Basic", () => {
    const reqs = buildAlertRequests(
      { type: "twilio", config: { accountSid: `AC${"0".repeat(32)}`, from: "+15550000000", to: ["+15550000001", "+15550000002"] }, secret: "tok" },
      down,
      ctx,
    );
    expect(reqs).toHaveLength(2);
    expect(new URLSearchParams(reqs[0]!.body).get("To")).toBe("+15550000001");
    expect(new URLSearchParams(reqs[0]!.body).get("Body")!.length).toBeLessThanOrEqual(320);
    expect(reqs[0]!.headers.authorization).toBe(`Basic ${Buffer.from(`AC${"0".repeat(32)}:tok`).toString("base64")}`);
  });
});

describe("where an alert may go", () => {
  it("the chat services only to their own hosts, over https", () => {
    expect(alertDestinationProblem("slack", "https://hooks.slack.com/services/T/B/x")).toBeNull();
    expect(alertDestinationProblem("slack", "https://evil.example/hooks.slack.com")).not.toBeNull();
    expect(alertDestinationProblem("discord", "http://discord.com/api/webhooks/1/x")).not.toBeNull();
    expect(alertDestinationProblem("teams", "https://prod-12.westus.logic.azure.com:443/workflows/abc")).toBeNull();
  });
  it("a webhook or ntfy may be on the LAN, but never link-local or with credentials in it", () => {
    expect(alertDestinationProblem("webhook", "http://10.0.0.5:5678/hook")).toBeNull();
    expect(alertDestinationProblem("webhook", "http://169.254.169.254/latest/meta-data")).not.toBeNull();
    expect(alertDestinationProblem("ntfy", "http://[fe80::1]/")).not.toBeNull();
    expect(alertDestinationProblem("webhook", "https://user:pass@example.org/")).not.toBeNull();
    expect(alertDestinationProblem("webhook", "file:///etc/passwd")).not.toBeNull();
  });
});

describe("createAlertChannelSchema", () => {
  it("checks the type's own settings and requires the secret where the type needs one", () => {
    expect(createAlertChannelSchema.safeParse({ name: "IT", type: "slack", config: {} }).success).toBe(false);
    expect(createAlertChannelSchema.safeParse({ name: "IT", type: "slack", config: {}, secret: "https://hooks.slack.com/x" }).success).toBe(true);
    expect(createAlertChannelSchema.safeParse({ name: "SMS", type: "twilio", config: { accountSid: "nope", from: "+1", to: [] }, secret: "t" }).success).toBe(false);
    expect(createAlertChannelSchema.safeParse({ name: "n", type: "ntfy", config: { topic: "bad topic!" } }).success).toBe(false);
  });
});
