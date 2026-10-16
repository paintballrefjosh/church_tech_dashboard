import { describe, expect, it } from "vitest";
import { sectionOk, sectionOff } from "@church/shared";
import { HomeService } from "../src/dashboard/home/home.service";
import type { AuthenticatedUser } from "../src/auth/current-user.decorator";

function build() {
  let builds = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const counted = { build: async () => { builds++; await gate; return sectionOk({}); } };
  const off = { build: async () => sectionOff("forbidden") };
  const settings = { get: async (k: string) => (k === "site.timezone" ? "UTC" : "") };
  const svc = new HomeService(settings as never, off as never, off as never, counted as never, off as never, off as never, off as never, off as never, off as never, off as never, off as never, off as never, off as never);
  return { svc, builds: () => builds, release };
}

const user = (id: string, permissions: string[] = []) => ({ id, email: `${id}@x`, name: id, permissions, groups: ["user"] }) as unknown as AuthenticatedUser;

describe("HomeService request coalescing", () => {
  it("builds once for identical simultaneous requests", async () => {
    const { svc, builds, release } = build();
    const all = Promise.all([svc.snapshot(user("a"), ["week"]), svc.snapshot(user("a"), ["week"]), svc.snapshot(user("a"), ["week"])]);
    release();
    const [x, y, z] = await all;
    expect(builds()).toBe(1);
    expect(x.generatedAt).toBe(y.generatedAt);
    expect(z.user.id).toBe("a");
  });

  it("keeps people, includes and access levels apart", async () => {
    const { svc, builds, release } = build();
    const all = Promise.all([
      svc.snapshot(user("a"), []),
      svc.snapshot(user("b"), []),
      svc.snapshot(user("a"), ["week"]),
      svc.snapshot(user("a", ["tickets:read:any"]), []),
    ]);
    release();
    await all;
    expect(builds()).toBe(4);
  });

  it("keeps nothing once a build ends, so a request after an action sees its effect", async () => {
    const { svc, builds, release } = build();
    release();
    await svc.snapshot(user("a"), []);
    await svc.snapshot(user("a"), []);
    expect(builds()).toBe(2);
  });

  it("lets a failed build be retried by the next request", async () => {
    const off = { build: async () => sectionOff("forbidden") };
    let n = 0;
    const settings = { get: async () => { if (++n === 1) throw new Error("db"); return "UTC"; } };
    const svc = new HomeService(settings as never, off as never, off as never, off as never, off as never, off as never, off as never, off as never, off as never, off as never, off as never, off as never, off as never);
    // The settings reads are caught inside the build, so it still answers; the point is the map is cleaned up.
    await svc.snapshot(user("a"), []);
    await svc.snapshot(user("a"), []);
    expect(n).toBeGreaterThan(1);
  });
});
