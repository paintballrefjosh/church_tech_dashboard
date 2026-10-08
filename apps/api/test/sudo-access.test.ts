import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  looksDenied,
  parseSetupResult,
  parseSudoProbe,
  scrubSecret,
  sudoProbeScript,
  sudoersFileFor,
  sudoersSetupScript,
  validSudoUser,
} from "../src/infra/sudo-access";
import { sectionLines, splitSections } from "../src/infra/collectors/markers";

/**
 * The probe and setup scripts are real shell, so they run here against a fake `sudo`. FAKE_SUDO_MODE picks how
 * the "host" behaves: nopasswd (rule already there), password (needs "secret"), denied (not a sudoer).
 */
const FAKE_SUDO = `#!/bin/sh
state="$FAKE_SUDO_DIR"
nopass=0
stdin_pw=0
while [ $# -gt 0 ]; do
  case "$1" in
    -n) nopass=1; shift ;;
    -S) stdin_pw=1; shift ;;
    -p) shift 2 ;;
    -v) set -- true; break ;;
    *) break ;;
  esac
done
case "$FAKE_SUDO_MODE" in
  denied)
    echo "$(id -un) is not in the sudoers file.  This incident will be reported." >&2; exit 1 ;;
  nopasswd) exec "$@" ;;
  password)
    if [ -e "$state/ticket" ]; then exec "$@"; fi
    if [ "$stdin_pw" = 1 ]; then
      read -r pw
      if [ "$pw" = "secret" ]; then : > "$state/ticket"; exec "$@"; fi
      echo "Sorry, try again." >&2; echo "sudo: 1 incorrect password attempt" >&2; exit 1
    fi
    echo "sudo: a password is required" >&2; exit 1 ;;
esac
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sudo-access-"));
  writeFileSync(join(dir, "sudo"), FAKE_SUDO);
  chmodSync(join(dir, "sudo"), 0o755);
  writeFileSync(join(dir, "visudo"), "#!/bin/sh\nexit ${FAKE_VISUDO_RC:-0}\n");
  chmodSync(join(dir, "visudo"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(script: string, mode: string, stdin = "", extraEnv: Record<string, string> = {}) {
  const r = spawnSync("sh", ["-c", script], {
    input: stdin,
    encoding: "utf8",
    env: { PATH: `${dir}:${process.env.PATH ?? ""}`, FAKE_SUDO_MODE: mode, FAKE_SUDO_DIR: dir, ...extraEnv },
  });
  return { out: r.stdout, err: r.stderr, code: r.status };
}

// The probe tests only make sense for a non-root runner (as in the project's node container).
const nonRoot = typeof process.getuid === "function" && process.getuid() !== 0;
const maybe = nonRoot ? describe : describe.skip;

maybe("sudoProbeScript", () => {
  const probeOf = (out: string) => parseSudoProbe(sectionLines(splitSections(out), "M_SUDO"));

  it("goes on when sudo needs no password", () => {
    const r = run(`${sudoProbeScript(false)}\necho M_AFTER\necho reached`, "nopasswd");
    expect(probeOf(r.out)?.state).toBe("ok");
    expect(r.out).toContain("reached");
  });

  it("stops and reports needs_password when no password is available", () => {
    const r = run(`${sudoProbeScript(false)}\necho M_AFTER\necho reached`, "password");
    const probe = probeOf(r.out);
    expect(probe?.state).toBe("needs_password");
    expect(probe?.message).toContain("a password is required");
    expect(r.out).not.toContain("reached");
  });

  it("accepts the right password and continues", () => {
    const r = run(`${sudoProbeScript(true)}\necho M_AFTER\necho reached`, "password", "secret\n");
    expect(probeOf(r.out)?.state).toBe("ok");
    expect(r.out).toContain("reached");
  });

  it("reports bad_password for a wrong one and never echoes it", () => {
    const r = run(`${sudoProbeScript(true)}\necho M_AFTER\necho reached`, "password", "hunter2\n");
    const probe = probeOf(r.out);
    expect(probe?.state).toBe("bad_password");
    expect(probe?.message).toContain("incorrect password");
    expect(r.out).not.toContain("hunter2");
    expect(r.out).not.toContain("reached");
  });

  it("reports denied for a login that is not a sudoer, with or without a password", () => {
    for (const have of [false, true]) {
      const probe = probeOf(run(sudoProbeScript(have), "denied", "secret\n").out);
      expect(probe?.state).toBe("denied");
      expect(probe?.message).toContain("not in the sudoers");
    }
  });

  it("reports no_sudo when sudo is not installed", () => {
    const r = spawnSync("sh", ["-c", sudoProbeScript(false)], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
    });
    // Only meaningful where the host really has no sudo on that PATH.
    if (!existsSync("/usr/bin/sudo") && !existsSync("/bin/sudo")) {
      expect(probeOf(r.stdout)?.state).toBe("no_sudo");
    }
  });
});

maybe("sudoersSetupScript", () => {
  const setupOf = (out: string) => parseSetupResult(sectionLines(splitSections(out), "M_SETUP"));

  it("writes a validated drop-in and leaves no temp file", () => {
    // The fake sudo grants the ticket on the right password, which makes the final `sudo -n true` pass.
    const r = run(sudoersSetupScript("churchmon", dir), "password", "secret\n");
    expect(setupOf(r.out)?.state).toBe("ok");
    const file = sudoersFileFor("churchmon", dir);
    expect(readFileSync(file, "utf8")).toBe("churchmon ALL=(ALL) NOPASSWD: ALL\n");
    expect(existsSync(`${file}~`)).toBe(false);
  });

  it("does nothing when passwordless sudo already works", () => {
    const r = run(sudoersSetupScript("churchmon", dir), "nopasswd");
    expect(setupOf(r.out)?.state).toBe("already");
    expect(existsSync(sudoersFileFor("churchmon", dir))).toBe(false);
  });

  it("reports a wrong password and writes nothing", () => {
    const r = run(sudoersSetupScript("churchmon", dir), "password", "nope\n");
    expect(setupOf(r.out)?.state).toBe("bad_password");
    expect(existsSync(sudoersFileFor("churchmon", dir))).toBe(false);
  });

  it("reports denied for a login that may not use sudo", () => {
    const r = run(sudoersSetupScript("churchmon", dir), "denied", "secret\n");
    const res = setupOf(r.out);
    expect(res?.state).toBe("denied");
    expect(looksDenied(res?.message ?? "")).toBe(true);
  });

  it("refuses to install a rule visudo rejects", () => {
    const r = run(sudoersSetupScript("churchmon", dir), "password", "secret\n", { FAKE_VISUDO_RC: "1" });
    const res = setupOf(r.out);
    expect(res?.state).toBe("failed");
    expect(res?.message).toContain("visudo rejected");
    expect(existsSync(sudoersFileFor("churchmon", dir))).toBe(false);
    expect(existsSync(`${sudoersFileFor("churchmon", dir)}~`)).toBe(false);
  });
});

describe("helpers", () => {
  it("only lets plain login names into a sudoers rule", () => {
    for (const ok of ["churchmon", "svc_monitor", "a.b-c"]) expect(validSudoUser(ok)).toBe(true);
    for (const bad of ["root", "", "a b", "a;rm", "x'y", "9lives", "a\nb", "$(id)", "DOM\\user"]) {
      expect(validSudoUser(bad)).toBe(false);
    }
    expect(() => sudoersSetupScript("a;rm")).toThrow();
  });

  it("names the drop-in so sudo does not skip it", () => {
    // sudoers.d ignores names containing a dot or ending in ~
    expect(sudoersFileFor("first.last")).toBe("/etc/sudoers.d/90-church-dashboard-first_last");
  });

  it("recognises the ways sudo says no", () => {
    expect(looksDenied("josh is not in the sudoers file.")).toBe(true);
    expect(looksDenied("Sorry, user josh may not run sudo on host.")).toBe(true);
    expect(looksDenied("Sorry, try again.")).toBe(false);
  });

  it("scrubs a secret from stored text", () => {
    expect(scrubSecret("pw is hunter2, hunter2", "hunter2")).toBe("pw is ********, ********");
    expect(scrubSecret("unchanged", null)).toBe("unchanged");
  });

  it("ignores a malformed section", () => {
    expect(parseSudoProbe(["bogus", "0"])).toBeNull();
    expect(parseSudoProbe(undefined)).toBeNull();
    expect(parseSetupResult(["bogus"])).toBeNull();
  });
});
