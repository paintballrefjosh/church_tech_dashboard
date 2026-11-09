import { describe, expect, it } from "vitest";
import { INBOUND_KEYS, SETTING_CATEGORY_MANAGE_PERMISSION, PERMISSIONS, contactHostProblem, findKnownSetting, validateSettingValue } from "@lampstand/shared";
import { assertMailboxHost } from "../src/tickets/ticket-inbound";

describe("contactHostProblem", () => {
  it("allows a public name, a LAN name with dots and a private address", () => {
    expect(contactHostProblem("imap.gmail.com")).toBeNull();
    expect(contactHostProblem("mail.church.lan")).toBeNull();
    expect(contactHostProblem("192.168.1.20")).toBeNull();
    expect(contactHostProblem("10.0.0.5")).toBeNull();
    expect(contactHostProblem("")).toBeNull();
  });

  it("refuses this machine, link-local (cloud metadata) and any-address, in every spelling", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "0.0.0.0", "169.254.169.254", "::1", "[::1]", "::ffff:127.0.0.1", "fe80::1"]) {
      expect(contactHostProblem(h), h).not.toBeNull();
    }
  });

  it("refuses the stack's own containers and any one-word name", () => {
    for (const h of ["api", "web", "localhost", "meilisearch", "garage", "cockroach", "cockroach1", "mailserver", "API"]) {
      expect(contactHostProblem(h), h).not.toBeNull();
    }
  });
});

describe("the mailbox host", () => {
  it("is refused when saved, before anything connects", () => {
    expect(validateSettingValue(INBOUND_KEYS.host, "127.0.0.1")).not.toBeNull();
    expect(validateSettingValue(INBOUND_KEYS.host, "api")).not.toBeNull();
    expect(validateSettingValue(INBOUND_KEYS.host, "imap.example.org")).toBeNull();
    expect(validateSettingValue(INBOUND_KEYS.host, "")).toBeNull();
    expect(validateSettingValue(INBOUND_KEYS.host, "https://imap.example.org")).not.toBeNull();
  });

  it("is refused again at connect time, including a name that resolves to loopback", async () => {
    await expect(assertMailboxHost("169.254.169.254")).rejects.toThrow(/may contact/);
    await expect(assertMailboxHost("api")).rejects.toThrow(/not allowed/);
    // localhost.localdomain-style names resolve to loopback on most systems; a name that cannot be found is also refused.
    await expect(assertMailboxHost("no-such-host.invalid")).rejects.toThrow(/Could not find/);
  });
});

describe("who manages the Helpdesk and Wiki settings", () => {
  it("is the module's own admin, not only a site admin", () => {
    expect(SETTING_CATEGORY_MANAGE_PERMISSION.helpdesk).toBe(PERMISSIONS.TICKETS_ADMIN);
    expect(SETTING_CATEGORY_MANAGE_PERMISSION.tickets).toBe(PERMISSIONS.TICKETS_ADMIN);
    expect(SETTING_CATEGORY_MANAGE_PERMISSION.wiki).toBe(PERMISSIONS.WIKI_ADMIN);
    expect(findKnownSetting("tickets.sla.warn_percent")?.category).toBe("tickets");
    expect(findKnownSetting("wiki.review.default_days")?.category).toBe("wiki");
    expect(findKnownSetting(INBOUND_KEYS.password)?.category).toBe("helpdesk");
  });
});
