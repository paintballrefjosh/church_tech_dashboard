/**
 * A setup run's log as steps (docs/signage.md section 3). The API writes `== <step>` before each step's lines (its own steps
 * and the `@@step` lines the Pi sends), so the log is cut at those markers; nothing here talks to the server.
 */

export interface StepTone {
  /** Whole class names, so Tailwind sees them: a tinted label, and the colour of the card's left edge. */
  pill: string;
  edge: string;
}

export interface StepInfo {
  label: string;
  what: string;
  tone: StepTone;
}

const tone = (pill: string, edge: string): StepTone => ({ pill, edge });

export const STEP_INFO: Record<string, StepInfo> = {
  connect: { label: "Connect", what: "Signs in to the Pi over SSH with the setup login and remembers its host key.", tone: tone("bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200", "border-l-sky-500") },
  copy: { label: "Copy the player", what: "Sends the signage software (the agent) to the Pi and checks it arrived whole.", tone: tone("bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200", "border-l-indigo-500") },
  check: { label: "Check the Pi", what: "Makes sure this is a supported Raspberry Pi and OS with room to spare. A Pi that boots to the desktop is noted here.", tone: tone("bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-200", "border-l-teal-500") },
  packages: { label: "Install packages", what: "Installs mpv (the video player) and the small tools for TV control, Wi-Fi and the firewall. This is the slow part.", tone: tone("bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200", "border-l-amber-500") },
  accounts: { label: "Accounts", what: "Creates the signage and signage-player accounts, so the player runs without any special rights.", tone: tone("bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200", "border-l-violet-500") },
  agent: { label: "Start the agent", what: "Installs and starts the services that fetch the schedule and drive the player. The TV may go black here: the player has taken over the screen.", tone: tone("bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200", "border-l-blue-500") },
  system: { label: "System settings", what: "Host name, time zone, clock server, no login prompt on the TV, HDMI always on, and boot to the console instead of the desktop.", tone: tone("bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200", "border-l-emerald-500") },
  lockdown: { label: "Lock-down", what: "Applies the SSH security settings so only the dashboard can manage the Pi. The Pi undoes them after 2 minutes unless the dashboard can still log in, so you cannot lock yourself out.", tone: tone("bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200", "border-l-rose-500") },
  overlay: { label: "Read-only disk", what: "Makes the SD card read-only from the next restart, so a power cut cannot corrupt it. The Pi keeps its changes in memory and forgets them at restart.", tone: tone("bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-200", "border-l-orange-500") },
  done: { label: "Pi finished", what: "Everything the Pi had to do is done and its settings are saved.", tone: tone("bg-slate-200 text-slate-800 dark:bg-slate-800 dark:text-slate-200", "border-l-slate-500") },
  verify: { label: "Verify", what: "The dashboard signs in again with its own key, keeps the new SSH settings, checks the player and, if needed, restarts the Pi.", tone: tone("bg-cyan-100 text-cyan-900 dark:bg-cyan-950 dark:text-cyan-200", "border-l-cyan-500") },
  finished: { label: "Finished", what: "", tone: tone("bg-lime-100 text-lime-900 dark:bg-lime-950 dark:text-lime-200", "border-l-lime-600") },
};

/** The order a first setup goes through, so steps still to come can be shown as waiting. */
export const SETUP_STEP_ORDER = ["connect", "copy", "check", "packages", "accounts", "agent", "system", "lockdown", "overlay", "done", "verify", "finished"] as const;

const UNKNOWN_TONE = tone("bg-slate-200 text-slate-800 dark:bg-slate-800 dark:text-slate-200", "border-l-slate-500");

export function stepInfo(name: string): StepInfo {
  return STEP_INFO[name] ?? { label: name.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase()), what: "", tone: UNKNOWN_TONE };
}

export interface RunStep {
  name: string;
  lines: string[];
}

/** Cut a run's output at its `== name` markers. Lines before the first marker belong to "connect" (the first thing a run does). */
export function parseRunSteps(output: string): RunStep[] {
  const steps: RunStep[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const m = /^== (\S+)\s*$/.exec(line);
    if (m) {
      if (steps.length === 1 && steps[0]!.name === m[1] && m[1] === "connect") continue; // the marker after the implicit connect lines
      steps.push({ name: m[1]!, lines: [] });
      continue;
    }
    if (!line.trim()) continue;
    if (steps.length === 0) steps.push({ name: "connect", lines: [] });
    steps[steps.length - 1]!.lines.push(line.replace(/^ {2}/, ""));
  }
  // Runs recorded before the dashboard's own copy step had a name called it "agent", like the Pi's later step of that name.
  for (const s of steps) if (s.name === "agent" && /^copying agent\b/.test(s.lines[0] ?? "")) s.name = "copy";
  return steps;
}

export type StepState = "done" | "running" | "failed" | "waiting";

/** Each step's state from the run's status: the last step seen is the live one (or the one that failed). */
export function stepStates(steps: RunStep[], runStatus: string, kind: string): Array<{ name: string; lines: string[]; state: StepState }> {
  const busy = runStatus === "queued" || runStatus === "running" || runStatus === "needs_sudo";
  const out: Array<{ name: string; lines: string[]; state: StepState }> = steps.map((s, i) => {
    const last = i === steps.length - 1;
    const state: StepState = last && runStatus === "failed" ? "failed" : last && busy ? "running" : "done";
    return { name: s.name, lines: s.lines, state };
  });
  if (kind === "setup" && busy) {
    const seen = new Set(steps.map((s) => s.name));
    const lastIdx = steps.length ? SETUP_STEP_ORDER.indexOf(steps[steps.length - 1]!.name as (typeof SETUP_STEP_ORDER)[number]) : -1;
    SETUP_STEP_ORDER.forEach((name, i) => {
      if (!seen.has(name) && i > lastIdx && name !== "finished") out.push({ name, lines: [], state: "waiting" });
    });
  }
  return out;
}

/** The run ended by restarting the Pi: a black TV for a minute or two is expected. */
export function restartsPi(output: string): boolean {
  return /^restarting the Pi\b/m.test(output);
}
