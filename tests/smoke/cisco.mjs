/**
 * Cisco smoke tests, run from run.mjs. Read-only against the switches: nothing here pushes, polls or changes a switch
 * (the fleet is real; pushes are tested on a fake switch in apps/api/test). A test that needs a switch with a stored
 * configuration passes with a note when the stack has none. Everything created here is removed before the block ends.
 */
export async function ciscoTests({ test, assert, fetchWithCookies, jar }) {
  const json = (body) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const admin = (path, init = {}) => fetchWithCookies(path, init, jar);

  const switches = await admin("/api/v1/cisco/switches").then(({ res }) => (res.status === 200 ? res.json() : []));

  async function firstStoredConfigs() {
    for (const sw of switches) {
      const { res } = await admin(`/api/v1/cisco/switches/${sw.id}/backups`);
      if (res.status !== 200) continue;
      const list = await res.json();
      if (list.length > 0) return { sw, list };
    }
    return null;
  }

  await test("cisco: a port name that is not an interface name is refused before anything is saved or pushed", async () => {
    if (switches.length === 0) return;
    for (const portId of ["range Gi1/0/1-48", "Gi1/0/1 ; reload", "Gi 1/0/1"]) {
      const { res } = await admin(`/api/v1/cisco/switches/${switches[0].id}/ports`, { method: "POST", ...json({ portId, adminEnabled: false }) });
      assert(res.status === 400, `${JSON.stringify(portId)} gave ${res.status}`);
    }
    for (const bad of [{ speed: "1000 ; reload" }, { duplex: "full ; reload" }, { trunkAllowedVlans: "10 ; reload" }]) {
      const { res } = await admin(`/api/v1/cisco/switches/${switches[0].id}/ports`, { method: "POST", ...json({ portId: "Gi9/9/9", ...bad }) });
      assert(res.status === 400, `${JSON.stringify(bad)} gave ${res.status}`);
    }
  });

  await test("cisco: stored configurations show their secrets to someone who can change the switches and hide them from a volunteer", async () => {
    const found = await firstStoredConfigs();
    if (!found) return; // no switch with a stored configuration on this stack
    const { sw, list } = found;
    const latest = list[0];

    const seen = await admin(`/api/v1/cisco/switches/${sw.id}/backups/${latest.id}`).then(({ res }) => res.json());
    const secrets = [
      ...[...seen.configText.matchAll(/^\s*snmp-server community (\S+)/gim)].map((m) => m[1]),
      ...[...seen.configText.matchAll(/^\s*username \S+.*?\b(?:secret|password) (?:\d )?(\S{6,})/gim)].map((m) => m[1]),
      ...[...seen.configText.matchAll(/^\s*enable (?:secret|password) (?:level \d+ )?(?:\d )?(\S{6,})/gim)].map((m) => m[1]),
    ];
    if (secrets.length === 0) return; // nothing in this configuration to hide
    assert(secrets.every((s) => seen.configText.includes(s)), "the admin copy should be complete");

    const email = `cisco-volunteer-${Date.now()}@example.com`;
    const password = "smoke-volunteer-pw-1234";
    const created = await admin("/api/v1/users", {
      method: "POST",
      ...json({ email, displayName: "Cisco Volunteer Smoke", password, sendInvite: false, sendWelcomeEmail: false, mustChangePassword: false }),
    });
    assert(created.res.status === 200 || created.res.status === 201, `create user ${created.res.status}`);
    const user = await created.res.json();
    let groupId = null;
    try {
      // A volunteer with the Monitoring USER tier (the shipped default for the baseline group; this install may differ), in a
      // throwaway group so the test does not depend on how the baseline group was set up.
      const group = await admin("/api/v1/groups", { method: "POST", ...json({ name: `cisco-smoke-${Date.now()}`, description: "smoke" }) });
      assert(group.res.status === 200 || group.res.status === 201, `create group ${group.res.status}: ${await group.res.clone().text()}`);
      groupId = (await group.res.json()).id;
      const access = await admin(`/api/v1/groups/${groupId}/module-access`, { method: "PUT", ...json({ access: { monitoring: "user" } }) });
      assert(access.res.status === 200 || access.res.status === 201, `set module access ${access.res.status}`);
      const joined = await admin(`/api/v1/groups/${groupId}/members`, { method: "POST", ...json({ userId: user.id }) });
      assert(joined.res.status === 200 || joined.res.status === 201, `add to the group ${joined.res.status}`);
      const j = new Map();
      const csrf = await fetchWithCookies("/api/auth/csrf", {}, j).then(({ res }) => res.json());
      const signin = await fetchWithCookies(
        "/api/auth/callback/credentials",
        { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf.csrfToken, email, password, callbackUrl: "/", json: "true" }).toString() },
        j,
      );
      assert(signin.res.status === 200 || signin.res.status === 302, `volunteer sign-in ${signin.res.status}`);
      const meRes = await fetchWithCookies("/api/v1/me", {}, j);
      assert(meRes.res.status === 200, `volunteer /me gave ${meRes.res.status} (sign-in failed?)`);
      const me = await meRes.res.json();
      assert(Array.isArray(me.permissions) && me.permissions.includes("monitors:read:any") && !me.permissions.includes("monitors:write:any"), "the new account should be an ordinary volunteer (read, not write)");

      const volunteer = await fetchWithCookies(`/api/v1/cisco/switches/${sw.id}/backups/${latest.id}`, {}, j);
      assert(volunteer.res.status === 200, `volunteer read gave ${volunteer.res.status}`);
      const text = (await volunteer.res.json()).configText;
      assert(secrets.every((s) => !text.includes(s)), "a secret is still visible to a volunteer");
      assert(text.includes("<hidden>"), "redacted lines should say so");
      assert(text.split("\n").length === seen.configText.split("\n").length, "redaction must keep every line");

      if (list.length > 1) {
        const diff = await fetchWithCookies(`/api/v1/cisco/switches/${sw.id}/backups/${list[1].id}/diff/${latest.id}`, {}, j);
        assert(diff.res.status === 200, `volunteer diff gave ${diff.res.status}`);
        const body = await diff.res.text();
        assert(secrets.every((s) => !body.includes(s)), "a secret is visible in a volunteer's diff");
      }
    } finally {
      if (groupId) await admin(`/api/v1/groups/${groupId}`, { method: "DELETE" });
      await admin(`/api/v1/users/${user.id}`, { method: "DELETE" });
      await admin(`/api/v1/users/${user.id}/hard-delete`, { method: "POST" });
    }
  });
}
