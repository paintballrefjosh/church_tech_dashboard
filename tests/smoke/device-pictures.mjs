/**
 * Device picture choices, run from run.mjs: an infra host's device profile (saved on the host, cleared when the profile is
 * deleted) and a UniFi device's choice by MAC (works with no controller: nothing is sent to it). Creates one host with
 * monitoring off, two profiles and one choice for a made-up MAC, and removes them all.
 */
export async function devicePictureTests({ test, assert, fetchWithCookies, jar }) {
  const json = (method, body) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const call = (path, init = {}) => fetchWithCookies(path, init, jar);
  const MAC = "02:5e:00:00:00:01"; // locally administered: no real device has it
  let profile = null;
  let module = null;
  let hostId = null;

  async function makeProfile(name, kind) {
    const { res } = await call("/api/v1/switch-models", json("POST", { name: `[smoke] ${name} ${Date.now()}`, kind }));
    const text = await res.text();
    assert(res.status === 200 || res.status === 201, `create profile status ${res.status}: ${text}`);
    return JSON.parse(text);
  }

  try {
    await test("device pictures: an infra host keeps the profile chosen for it, and refuses a module or a missing one", async () => {
      profile = await makeProfile("server", "switch");
      module = await makeProfile("module", "module");
      const { res } = await call("/api/v1/infra/targets", json("POST", { name: "[smoke] pictured host", os: "linux", host: "127.0.0.1", enabled: false, switchModelId: profile.id }));
      assert(res.status === 200 || res.status === 201, `create host status ${res.status}`);
      const host = await res.json();
      hostId = host.id;
      assert(host.switchModelId === profile.id, `switchModelId ${host.switchModelId}`);
      const asModule = await call(`/api/v1/infra/targets/${hostId}`, json("PATCH", { switchModelId: module.id }));
      assert(asModule.res.status === 400, `a module gave ${asModule.res.status}`);
      const missing = await call(`/api/v1/infra/targets/${hostId}`, json("PATCH", { switchModelId: "00000000-0000-4000-8000-0000000000aa" }));
      assert(missing.res.status === 400, `a missing profile gave ${missing.res.status}`);
      const still = await call(`/api/v1/infra/targets/${hostId}`).then(({ res: r }) => r.json());
      assert(still.switchModelId === profile.id, `after refusals: ${still.switchModelId}`);
    });

    await test("device pictures: a UniFi device's choice is kept by MAC, without a controller", async () => {
      const bad = await call("/api/v1/unifi/devices/not-a-mac/switch-view", json("PUT", { mode: "off" }));
      assert(bad.res.status === 400, `a bad MAC gave ${bad.res.status}`);
      const noModel = await call(`/api/v1/unifi/devices/${MAC}/switch-view`, json("PUT", { mode: "model" }));
      assert(noModel.res.status === 400, `mode model without a profile gave ${noModel.res.status}`);
      const asModule = await call(`/api/v1/unifi/devices/${MAC}/switch-view`, json("PUT", { mode: "model", modelId: module.id }));
      assert(asModule.res.status === 400, `a module gave ${asModule.res.status}`);
      const picked = await call(`/api/v1/unifi/devices/${MAC.toUpperCase()}/switch-view`, json("PUT", { mode: "model", modelId: profile.id }));
      assert(picked.res.status === 200, `pick gave ${picked.res.status}`);
      const body = await picked.res.json();
      assert(body.mac === MAC && body.switchModelId === profile.id && body.switchViewOff === false, `pick: ${JSON.stringify(body)}`);
      const off = await call(`/api/v1/unifi/devices/${MAC}/switch-view`, json("PUT", { mode: "off" }));
      assert(off.res.status === 200 && (await off.res.json()).switchViewOff === true, "off should be saved");
    });

    await test("device pictures: deleting the profile clears the host's choice", async () => {
      const del = await call(`/api/v1/switch-models/${profile.id}`, { method: "DELETE" });
      assert(del.res.status === 200 || del.res.status === 204, `delete profile gave ${del.res.status}`);
      profile = null;
      const host = await call(`/api/v1/infra/targets/${hostId}`).then(({ res }) => res.json());
      assert(host.switchModelId === null, `after delete: ${host.switchModelId}`);
    });
  } finally {
    await call(`/api/v1/unifi/devices/${MAC}/switch-view`, json("PUT", { mode: "auto" })).catch(() => undefined);
    if (hostId) await call(`/api/v1/infra/targets/${hostId}`, { method: "DELETE" }).catch(() => undefined);
    for (const p of [profile, module]) if (p) await call(`/api/v1/switch-models/${p.id}`, { method: "DELETE" }).catch(() => undefined);
  }
}
