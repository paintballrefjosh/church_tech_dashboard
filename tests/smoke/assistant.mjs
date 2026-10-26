/**
 * Assistant smoke tests, run from run.mjs. The stack's assistant is not configured, so these check the closed doors only:
 * nothing here reaches a model, and nothing is left behind (the switch is never actually turned on).
 */
export async function assistantTests({ test, assert, fetchWithCookies, jar }) {
  const json = (body) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const session = (path, init = {}) => fetchWithCookies(path, init, jar);

  await test("assistant: needs a session; status says whether it is on", async () => {
    assert((await fetchWithCookies("/api/v1/assistant/status")).res.status === 401, "no session");
    const r = await session("/api/v1/assistant/status");
    assert(r.res.status === 200, `status ${r.res.status}`);
    const s = await r.res.json();
    assert(typeof s.enabled === "boolean" && typeof s.canUse === "boolean", JSON.stringify(s));
  });

  await test("assistant: the readiness checklist is readable by a site admin and switching on is refused until it is green", async () => {
    const r = await session("/api/v1/assistant/admin/readiness");
    assert(r.res.status === 200, `readiness ${r.res.status}`);
    const body = await r.res.json();
    assert(Array.isArray(body.items) && body.items.length === 5, JSON.stringify(body).slice(0, 300));
    if (body.ready) return; // a configured stack: nothing more to check without spending money
    const on = await session("/api/v1/settings/assistant.enabled", { method: "PUT", ...json({ value: true }) });
    assert(on.res.status === 400, `enable while not ready: ${on.res.status}`);
    const after = await (await session("/api/v1/assistant/status")).res.json();
    assert(after.enabled === false, "still off");
  });

  await test("assistant: asking while it is off answers with an error event, not a model call", async () => {
    const s = await (await session("/api/v1/assistant/status")).res.json();
    if (s.enabled || !s.canUse) return;
    const r = await session("/api/v1/assistant/chat", { method: "POST", ...json({ question: "Is anything down?" }) });
    assert(r.res.status === 200, `chat ${r.res.status}`);
    assert(/text\/event-stream/.test(r.res.headers.get("content-type") ?? ""), r.res.headers.get("content-type"));
    const text = await r.res.text();
    const events = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
    assert(events.some((e) => e.type === "error" && e.kind === "disabled"), text.slice(0, 300));
    const list = await session("/api/v1/assistant/conversations");
    assert(list.res.status === 200, `conversations ${list.res.status}`);
  });

  await test("assistant: an empty or oversized question is refused", async () => {
    const empty = await session("/api/v1/assistant/chat", { method: "POST", ...json({ question: "" }) });
    assert(empty.res.status === 400, `empty: ${empty.res.status}`);
    const huge = await session("/api/v1/assistant/chat", { method: "POST", ...json({ question: "x".repeat(5000) }) });
    assert(huge.res.status === 400, `oversized: ${huge.res.status}`);
  });

  await test("assistant: feedback and decisions only touch the person's own answers, and check what they are given", async () => {
    const s = await (await session("/api/v1/assistant/status")).res.json();
    assert(s.health === null || ["ok", "failing", "budget_used"].includes(s.health), `health ${s.health}`);
    const missing = "00000000-0000-4000-8000-0000000000aa";
    const want = s.canUse ? 404 : 403;
    const fb = await session(`/api/v1/assistant/messages/${missing}/feedback`, { method: "POST", ...json({ rating: 1 }) });
    assert(fb.res.status === want, `feedback on a missing answer: ${fb.res.status}`);
    const dec = await session(`/api/v1/assistant/messages/${missing}/actions/${missing}`, { method: "PATCH", ...json({ status: "done", resultUrl: "/tickets/x" }) });
    assert(dec.res.status === want, `decision on a missing answer: ${dec.res.status}`);
    if (!s.canUse) return;
    const bad = await session(`/api/v1/assistant/messages/${missing}/feedback`, { method: "POST", ...json({ rating: 5 }) });
    assert(bad.res.status === 400, `rating 5: ${bad.res.status}`);
    const odd = await session(`/api/v1/assistant/messages/${missing}/actions/${missing}`, { method: "PATCH", ...json({ status: "proposed" }) });
    assert(odd.res.status === 400, `status proposed: ${odd.res.status}`);
  });

  await test("assistant: the usage figures carry no question text", async () => {
    const r = await session("/api/v1/assistant/admin/usage");
    if (r.res.status === 403) return;
    assert(r.res.status === 200, `usage ${r.res.status}`);
    const u = await r.res.json();
    assert(u.answers && typeof u.answers.total === "number" && Array.isArray(u.answers.proposals), JSON.stringify(u).slice(0, 300));
    assert(!/"(question|content|text)"\s*:/.test(JSON.stringify(u)), "no text fields");
  });
}
