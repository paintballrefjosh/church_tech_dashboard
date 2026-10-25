import { describe, expect, it } from "vitest";
import { RealtimeGateway } from "../src/realtime/realtime.gateway";

const TICKET = "11111111-2222-3333-4444-555555555555";

/** A db stand-in answering the one lookup `mayJoin` makes: who created the ticket. */
function gatewayWithTicketOwner(owner: string | null) {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: async () => (owner ? [{ createdBy: owner }] : []),
  };
  return new RealtimeGateway(chain as never, {} as never, {} as never);
}

describe("RealtimeGateway.mayJoin", () => {
  it("lets the requester and ticket staff into a ticket's room, nobody else", async () => {
    const gw = gatewayWithTicketOwner("req");
    expect(await gw.mayJoin("req", ["tickets:read:own"], `ticket:${TICKET}`)).toBe(true);
    expect(await gw.mayJoin("staff", ["tickets:read:own", "tickets:read:any"], `ticket:${TICKET}`)).toBe(true);
    expect(await gw.mayJoin("other", ["tickets:read:own"], `ticket:${TICKET}`)).toBe(false);
  });
  it("refuses a missing ticket, a malformed id and someone without the Tickets module", async () => {
    expect(await gatewayWithTicketOwner(null).mayJoin("req", ["tickets:read:own"], `ticket:${TICKET}`)).toBe(false);
    expect(await gatewayWithTicketOwner("req").mayJoin("req", ["tickets:read:own"], "ticket:not-a-uuid")).toBe(false);
    expect(await gatewayWithTicketOwner("req").mayJoin("req", [], `ticket:${TICKET}`)).toBe(false);
  });
  it("keeps the permission rooms as before", async () => {
    const gw = gatewayWithTicketOwner(null);
    expect(await gw.mayJoin("u", ["monitors:read:any"], "monitoring")).toBe(true);
    expect(await gw.mayJoin("u", [], "monitoring")).toBe(false);
    expect(await gw.mayJoin("u", ["monitors:read:any"], "unknown-room")).toBe(false);
  });
});
