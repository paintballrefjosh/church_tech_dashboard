import { describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "@church/shared";
import { MAX_MENTIONS, MentionsService } from "../src/mentions/mentions.service";
import { mayReadComment } from "../src/tickets/ticket-events";

type Loaded = { id: string; approvalStatus: "approved" | "pending"; permissions: string[] };

function harness(people: Record<string, Loaded | null>) {
  const sent: { recipientUserId: string }[][] = [];
  const notifications = { createMany: vi.fn(async (rows: { recipientUserId: string }[]) => void sent.push(rows)) };
  const auth = { loadUserById: vi.fn(async (id: string) => people[id] ?? null) };
  const svc = new MentionsService({} as never, notifications as never, auth as never);
  vi.spyOn(svc, "resolve").mockResolvedValue(
    Object.keys(people).map((id) => ({ id, email: `${id}@local`, name: id })),
  );
  return { svc, sent, notifications };
}

const base = { excludeUserId: "actor", title: "t", summary: "secret text", link: "/x" };

describe("MentionsService.notify", () => {
  it("only notifies people the caller's rule lets read the text", async () => {
    const { svc, sent } = harness({
      staff: { id: "staff", approvalStatus: "approved", permissions: ["ok"] },
      requester: { id: "requester", approvalStatus: "approved", permissions: [] },
    });
    await svc.notify({ ...base, body: "@staff @requester", canSee: (u) => u.permissions.includes("ok") });
    expect(sent).toEqual([[expect.objectContaining({ recipientUserId: "staff" })]]);
  });

  it("never notifies disabled, deleted or pending accounts, nor the author", async () => {
    const { svc, notifications } = harness({
      gone: null,
      waiting: { id: "waiting", approvalStatus: "pending", permissions: [] },
      actor: { id: "actor", approvalStatus: "approved", permissions: [] },
    });
    await svc.notify({ ...base, body: "@gone @waiting @actor", canSee: () => true });
    expect(notifications.createMany).not.toHaveBeenCalled();
  });

  it("a failed send does not reject (callers fire and forget)", async () => {
    const { svc, notifications } = harness({ a: { id: "a", approvalStatus: "approved", permissions: [] } });
    notifications.createMany.mockRejectedValueOnce(new Error("db down"));
    await expect(svc.notify({ ...base, body: "@a", canSee: () => true })).resolves.toBeUndefined();
  });
});

describe("MentionsService.parse", () => {
  it(`looks up at most ${MAX_MENTIONS} handles`, () => {
    const body = Array.from({ length: 50 }, (_, i) => `@user${i}`).join(" ");
    expect(MentionsService.parse(body)).toHaveLength(MAX_MENTIONS);
  });
});

describe("mayReadComment", () => {
  const ticket = { createdByUserId: "req" };
  const staff = { id: "s", permissions: [PERMISSIONS.TICKETS_READ_ANY] };
  const requester = { id: "req", permissions: [PERMISSIONS.TICKETS_READ_OWN] };
  const stranger = { id: "x", permissions: [PERMISSIONS.TICKETS_READ_OWN] };

  it("an internal note is for ticket staff only", () => {
    expect(mayReadComment(staff, ticket, { isInternal: true })).toBe(true);
    expect(mayReadComment(requester, ticket, { isInternal: true })).toBe(false);
  });
  it("a public comment also reaches the requester, never someone else's ticket", () => {
    expect(mayReadComment(requester, ticket, { isInternal: false })).toBe(true);
    expect(mayReadComment(stranger, ticket, { isInternal: false })).toBe(false);
  });
});
