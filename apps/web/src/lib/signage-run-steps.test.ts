import { describe, expect, it } from "vitest";
import { SETUP_STEP_ORDER, STEP_INFO, parseRunSteps, restartsPi, stepInfo, stepStates } from "./signage-run-steps";

const OUTPUT = `connecting to pi@10.1.30.177 with the setup login
== connect
== copy
copying agent 1.0.0
agent installed
== check
  this Pi boots to the desktop (full Raspberry Pi OS): setup will switch it to the console
  Raspberry Pi 3 Model B Plus Rev 1.4, Debian GNU/Linux 13 (trixie), aarch64, 22480 MB free
== overlay
  read-only root turned on (after the reboot)
`;

describe("signage run steps", () => {
  it("cuts the log at the markers and gives the opening lines to connect", () => {
    const s = parseRunSteps(OUTPUT);
    expect(s.map((x) => x.name)).toEqual(["connect", "copy", "check", "overlay"]);
    expect(s[0]!.lines).toEqual(["connecting to pi@10.1.30.177 with the setup login"]);
    expect(s[2]!.lines[0]).toContain("boots to the desktop");
    expect(s[3]!.lines).toEqual(["read-only root turned on (after the reboot)"]);
  });

  it("reads a run recorded before the copy step had its own name", () => {
    const s = parseRunSteps("== connect\n== agent\ncopying agent 1.0.0\nagent installed\n== check\n  ok\n== agent\n  agent started\n");
    expect(s.map((x) => x.name)).toEqual(["connect", "copy", "check", "agent"]);
  });

  it("marks the last step live while the run goes on, or failed, and lists what is still to come", () => {
    const steps = parseRunSteps(OUTPUT);
    const running = stepStates(steps, "running", "setup");
    expect(running.find((x) => x.name === "overlay")!.state).toBe("running");
    expect(running.find((x) => x.name === "check")!.state).toBe("done");
    expect(running.filter((x) => x.state === "waiting").map((x) => x.name)).toEqual(["done", "verify"]);
    expect(stepStates(steps, "failed", "setup").at(-1)!.state).toBe("failed");
    // A finished run shows only what happened; another kind of run does not invent steps.
    expect(stepStates(steps, "succeeded", "setup").some((x) => x.state === "waiting")).toBe(false);
    expect(stepStates(steps, "running", "os_update").some((x) => x.state === "waiting")).toBe(false);
  });

  it("knows every step a setup goes through, each with its own colour and an explanation", () => {
    const tones = new Set<string>();
    for (const n of SETUP_STEP_ORDER) {
      const info = STEP_INFO[n]!;
      expect(info.label).toBeTruthy();
      if (n !== "finished") expect(info.what.length).toBeGreaterThan(20);
      tones.add(info.tone.pill);
    }
    expect(tones.size).toBe(SETUP_STEP_ORDER.length);
  });

  it("makes a readable label for a step it does not know", () => {
    expect(stepInfo("os_update").label).toBe("Os update");
  });

  it("notices a run that restarts the Pi", () => {
    expect(restartsPi("verify\nrestarting the Pi so the boot settings take effect")).toBe(true);
    expect(restartsPi("SSH settings kept")).toBe(false);
  });
});
