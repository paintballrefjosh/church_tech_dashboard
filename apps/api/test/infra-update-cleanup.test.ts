import { describe, expect, it } from "vitest";
import { createInfraUpdateRunSchema } from "@church/shared";
import { upgradeScript } from "../src/infra/infra-updater";

describe("update run: remove unused packages", () => {
  it("is off unless asked for", () => {
    expect(createInfraUpdateRunSchema.parse({}).cleanup).toBe(false);
    expect(upgradeScript(false, false, false, false)).not.toContain("autoremove");
  });

  it("runs the package manager's autoremove after a successful upgrade only", () => {
    const script = upgradeScript(false, false, false, true);
    expect(script).toContain("apt-get -y autoremove");
    expect(script).toContain("dnf -y autoremove");
    // Guarded by the upgrade's own exit status, and placed before that status is reported.
    const guard = script.indexOf('if [ "$UPGRADE_EXIT" = "0" ]');
    expect(guard).toBeGreaterThan(script.indexOf("UPGRADE_EXIT=$?"));
    expect(guard).toBeLessThan(script.indexOf("echo M_EXIT"));
    expect(script.indexOf("autoremove")).toBeGreaterThan(guard);
  });

  it("goes through $SUDO with a non-interactive environment, like the upgrade", () => {
    const line = upgradeScript(true, false, false, true)
      .split("\n")
      .find((l) => l.includes("apt-get -y autoremove"));
    expect(line).toContain("$SUDO env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a");
  });
});
