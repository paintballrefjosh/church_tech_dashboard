import { describe, expect, it, vi } from "vitest";
import { AvailabilitySampler } from "../src/availability/availability.sampler";
import type { AvailabilitySources } from "../src/availability/availability.sources";
import type { AvailabilitySample, AvailabilityWriter } from "../src/availability/availability.store";
import type { ClusterJobs } from "../src/cluster/cluster-jobs.service";

const s = (kind: AvailabilitySample["kind"], ref: string, down = false): AvailabilitySample => ({
  kind,
  ref,
  label: ref,
  down,
});

function setup(over: Partial<AvailabilitySources> = {}) {
  const sources: AvailabilitySources = {
    monitors: async () => [s("monitor", "m1"), s("monitor", "m2", true)],
    infraTargets: async () => [s("infra_target", "i1")],
    unifiDevices: async () => [s("unifi_device", "aa:bb", true)],
    ciscoSwitches: async () => [s("cisco_switch", "c1")],
    dnsNodes: async () => [s("dns_node", "ns1")],
    serviceInstances: async () => [s("service_instance", "svc1", true)],
    serviceGroups: async () => [s("service_group", "g1")],
    ...over,
  };
  const record = vi.fn(async () => undefined);
  const prune = vi.fn(async () => 0);
  const store: AvailabilityWriter = { record, prune };
  const register = vi.fn();
  const sampler = new AvailabilitySampler(sources, store, { register } as unknown as ClusterJobs);
  return { sampler, record, prune, register };
}

describe("AvailabilitySampler", () => {
  it("records one sample per system into the UTC hour start", async () => {
    const { sampler, record } = setup();
    const n = await sampler.sample(new Date("2026-10-10T13:42:17.500Z"));
    expect(n).toBe(8);
    const [samples, hour] = record.mock.calls[0] as unknown as [AvailabilitySample[], Date];
    expect(samples.map((x) => x.ref)).toEqual(["m1", "m2", "i1", "aa:bb", "c1", "ns1", "svc1", "g1"]);
    expect(samples.filter((x) => x.down).map((x) => x.ref)).toEqual(["m2", "aa:bb", "svc1"]);
    expect(hour.toISOString()).toBe("2026-10-10T13:00:00.000Z");
  });

  it("a throwing or null source skips only its kind", async () => {
    const { sampler, record } = setup({
      unifiDevices: async () => {
        throw new Error("controller unreachable");
      },
      dnsNodes: async () => null,
      serviceInstances: async () => null,
      serviceGroups: async () => null,
    });
    await sampler.sample(new Date("2026-10-10T00:00:00Z"));
    const [samples] = record.mock.calls[0] as unknown as [AvailabilitySample[]];
    expect(new Set(samples.map((x) => x.kind))).toEqual(new Set(["monitor", "infra_target", "cisco_switch"]));
  });

  it("writes nothing when no source has data", async () => {
    const none = async () => null;
    const { sampler, record } = setup({
      monitors: none,
      infraTargets: none,
      unifiDevices: none,
      ciscoSwitches: none,
      dnsNodes: none,
      serviceInstances: none,
      serviceGroups: none,
    });
    expect(await sampler.sample()).toBe(0);
    expect(record).not.toHaveBeenCalled();
  });

  it("prunes everything older than 8 days", async () => {
    const { sampler, prune } = setup();
    await sampler.prune(new Date("2026-10-10T12:00:00Z"));
    expect((prune.mock.calls[0] as unknown as [Date])[0].toISOString()).toBe("2026-10-02T12:00:00.000Z");
  });

  it("registers the sample and prune jobs", () => {
    const { sampler, register } = setup();
    sampler.onModuleInit();
    const specs = register.mock.calls.map((c) => c[0] as { name: string; everyMs: number; schedule?: string });
    expect(specs.map((x) => x.name)).toEqual(["availability-sample", "availability-prune"]);
    expect(specs[0].everyMs).toBe(60_000);
    expect(specs[1].schedule).toBe("fixed-delay");
  });
});
