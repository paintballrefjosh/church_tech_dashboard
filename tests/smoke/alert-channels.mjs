/**
 * Alert channel smoke tests, run from run.mjs. Nothing is ever delivered anywhere real: the only channel that is sent a
 * test points at a closed port on the API's own host, and every channel made here is deleted before the block ends.
 */
export async function alertChannelTests({ test, assert, fetchWithCookies, jar }) {
  const json = (body) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const session = (path, init = {}) => fetchWithCookies(path, init, jar);
  const made = [];
  try {
    await test("alert channels: need a session", async () => {
      const { res } = await fetchWithCookies("/api/v1/alert-channels");
      assert(res.status === 401, `status ${res.status}`);
    });

    await test("alert channels: a webhook to a link-local address or a Slack hook on another host is refused", async () => {
      const meta = await session("/api/v1/alert-channels", {
        method: "POST",
        ...json({ name: "[smoke] metadata", type: "webhook", config: { url: "http://169.254.169.254/latest/meta-data" } }),
      });
      assert(meta.res.status === 400, `link-local: ${meta.res.status}`);
      const slack = await session("/api/v1/alert-channels", {
        method: "POST",
        ...json({ name: "[smoke] fake slack", type: "slack", secret: "https://evil.example.org/hooks.slack.com/x" }),
      });
      assert(slack.res.status === 400, `slack host: ${slack.res.status}`);
    });

    let ch;
    await test("alert channels: a channel is saved with its secret hidden, and names are unique", async () => {
      const { res } = await session("/api/v1/alert-channels", {
        method: "POST",
        ...json({ name: "[smoke] dead hook", type: "webhook", events: "outages", config: { url: "http://127.0.0.1:9/hook" }, secret: "smoke-signing-secret" }),
      });
      const text = await res.text();
      assert(res.status === 201 || res.status === 200, `create ${res.status}: ${text}`);
      ch = JSON.parse(text);
      made.push(ch.id);
      assert(ch.hasSecret === true && !("secret" in ch) && !text.includes("smoke-signing-secret"), `secret leaked: ${text}`);
      const again = await session("/api/v1/alert-channels", {
        method: "POST",
        ...json({ name: "[smoke] dead hook", type: "webhook", config: { url: "http://127.0.0.1:9/hook" } }),
      });
      assert(again.res.status === 409, `duplicate name: ${again.res.status}`);
      const list = await (await session("/api/v1/alert-channels")).res.json();
      assert(list.some((c) => c.id === ch.id) && !JSON.stringify(list).includes("smoke-signing-secret"), "list");
    });

    await test("alert channels: a failing test send says why and is recorded on the channel", async () => {
      const { res } = await session(`/api/v1/alert-channels/${ch.id}/test`, { method: "POST" });
      assert(res.status === 400, `test send to a closed port: ${res.status}`);
      const after = await (await session(`/api/v1/alert-channels/${ch.id}`)).res.json();
      assert(after.lastError && after.lastErrorAt, `lastError: ${JSON.stringify(after)}`);
    });

    await test("alert channels: editing without a secret keeps the saved one; the change is audited without it", async () => {
      const { res } = await session(`/api/v1/alert-channels/${ch.id}`, { method: "PATCH", ...json({ enabled: false, events: "everything" }) });
      assert(res.status === 200, `patch ${res.status}`);
      const body = await res.json();
      assert(body.enabled === false && body.events === "everything" && body.hasSecret === true, JSON.stringify(body));
      const audit = await (await session("/api/v1/audit?limit=20")).res.json();
      const rows = Array.isArray(audit) ? audit : audit.items ?? audit.rows ?? [];
      assert(!JSON.stringify(rows).includes("smoke-signing-secret"), "the secret reached the audit log");
    });
  } finally {
    for (const id of made) await session(`/api/v1/alert-channels/${id}`, { method: "DELETE" }).catch(() => undefined);
  }
}
