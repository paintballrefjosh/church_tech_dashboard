// Everything about how an update run gets root on a Linux host: the shell that probes sudo, the shell that
// writes a passwordless-sudo drop-in, and the parsing of what they report. Kept apart from infra-updater.ts so
// the scripts can be run against a fake `sudo` in a unit test.

/**
 * What the probe found. `ok` and `root` mean the run may go on.
 *  - needs_password: sudo works for this login but wants a password the dashboard was not given.
 *  - bad_password:   a password was given and sudo refused it.
 *  - denied:         sudo refused the login itself (not in sudoers / may not run sudo).
 *  - no_sudo:        not root and no sudo binary.
 */
export type SudoState = "root" | "ok" | "needs_password" | "bad_password" | "denied" | "no_sudo";

export interface SudoProbe {
  state: SudoState;
  /** The login is in sudo/wheel/admin. A hint for the message only; sudoers is what decides. */
  inSudoGroup: boolean;
  /** What sudo said (the prompt, or why it refused). Never contains the password. */
  message: string;
}

/** Output sudo gives when it refuses the user outright, across sudo and sudo-rs. */
const DENIED_RE = "not in the sudoers|not allowed to (execute|run)|may not run sudo|afraid I can.t do that";
const BAD_PASSWORD_RE =
  "incorrect password|incorrect authentication|try again|no password was provided|a password is required|interactive authentication is required|authentication (failure|failed)";

export const looksDenied = (s: string): boolean => new RegExp(DENIED_RE, "i").test(s);

const SUDO_STATES: readonly SudoState[] = ["root", "ok", "needs_password", "bad_password", "denied", "no_sudo"];

/**
 * `$SUDO` detection, shared by the upgrade and reboot scripts. Preference order: already root, then NOPASSWD
 * already configured (`sudo -n true` succeeds and no password is touched), then the password read from the first
 * line of stdin (see sshExec's `stdin` option).
 *
 * With a password, `$SUDO` is the shell function `sudo_pw`, which pipes the password into its own `sudo -S` every
 * time. It deliberately does NOT prime sudo's credential cache once and reuse it with `sudo -n`: the cache is tied
 * to a terminal or session, and a command run over SSH without a tty does not reliably find it again (sudo-rs, the
 * default on newer Ubuntu, fails there with "sudo: interactive authentication is required"). The password lives in
 * a shell variable and a builtin `printf`, so it never reaches argv or the environment.
 *
 * The probe reports into `M_SUDO` and, if the run cannot go on, exits there: running apt unprivileged would
 * only produce a wall of permission errors that hide the real cause.
 */
export function sudoProbeScript(havePassword: boolean): string {
  const lines = [
    'SUDO=""',
    "SUDO_STATE=root",
    'SUDO_MSG=""',
    ...(havePassword
      ? ["IFS= read -r SUDO_PW", `sudo_pw() { printf '%s\\n' "$SUDO_PW" | sudo -S -p '' "$@"; }`]
      : []),
    'if [ "$(id -u)" != "0" ]; then',
    "  if ! command -v sudo >/dev/null 2>&1; then",
    "    SUDO_STATE=no_sudo",
    "  elif sudo -n true 2>/dev/null; then",
    '    SUDO="sudo -n"; SUDO_STATE=ok',
    "  else",
  ];
  if (havePassword) {
    lines.push(
      "    SUDO_MSG=$(sudo_pw true 2>&1); SUDO_RC=$?",
      '    if [ "$SUDO_RC" -eq 0 ]; then',
      '      SUDO="sudo_pw"; SUDO_STATE=ok; SUDO_MSG=""',
      `    elif printf '%s' "$SUDO_MSG" | grep -qiE '${DENIED_RE}'; then`,
      "      SUDO_STATE=denied",
      "    else",
      "      SUDO_STATE=bad_password",
      "    fi",
    );
  } else {
    lines.push(
      "    SUDO_MSG=$(sudo -n true 2>&1)",
      `    if printf '%s' "$SUDO_MSG" | grep -qiE '${DENIED_RE}'; then SUDO_STATE=denied; else SUDO_STATE=needs_password; fi`,
    );
  }
  lines.push(
    "  fi",
    "fi",
    "echo M_SUDO",
    'echo "$SUDO_STATE"',
    "if id -nG 2>/dev/null | tr ' ' '\\n' | grep -qxE 'sudo|wheel|admin'; then echo 1; else echo 0; fi",
    'printf \'%s\\n\' "$SUDO_MSG"',
    'if [ "$SUDO_STATE" != "root" ] && [ "$SUDO_STATE" != "ok" ]; then exit 0; fi',
  );
  return lines.join("\n");
}

/** Reads the `M_SUDO` section written by `sudoProbeScript`. Null when the section is missing. */
export function parseSudoProbe(lines: readonly string[] | undefined): SudoProbe | null {
  if (!lines?.length) return null;
  const state = (lines[0] ?? "").trim() as SudoState;
  if (!SUDO_STATES.includes(state)) return null;
  return {
    state,
    inSudoGroup: (lines[1] ?? "").trim() === "1",
    message: lines.slice(2).join("\n").trim(),
  };
}

/** A login the setup script will put into a sudoers file: conservative on purpose, it is spliced into a rule. */
export function validSudoUser(user: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/.test(user) && user !== "root";
}

/**
 * sudoers.d ignores names with a dot or a trailing tilde, so the file name is reduced to safe characters. The
 * name starts with `zz-` because sudoers is last-match-wins and files are read in name order: this one must come
 * after anything else that mentions the login (cloud-init's `90-` files, a `%sudo` rule pulled in later).
 */
export function sudoersFileFor(user: string, dir = "/etc/sudoers.d"): string {
  return `${dir}/zz-church-dashboard-${safeName(user)}`;
}

/** The name the first version of the setup used; removed when the setup runs again. */
export function legacySudoersFileFor(user: string, dir = "/etc/sudoers.d"): string {
  return `${dir}/90-church-dashboard-${safeName(user)}`;
}

const safeName = (user: string): string => user.replace(/[^A-Za-z0-9_-]/g, "_");

export type SetupState = "ok" | "already" | "denied" | "bad_password" | "inactive" | "no_sudo" | "failed";

export interface SetupResult {
  state: SetupState;
  message: string;
}

const SETUP_STATES: readonly SetupState[] = ["ok", "already", "denied", "bad_password", "inactive", "no_sudo", "failed"];

/**
 * Writes `<user> ALL=(ALL) NOPASSWD: ALL` to a sudoers.d drop-in, with the password fed on stdin to the one
 * `sudo -S`. The rule goes to a temp name sudoers ignores (trailing `~`), is checked with `visudo -cf`, and is
 * only then moved into place, so a bad rule can never lock sudo out. A host whose sudoers has no `includedir`
 * for the directory is refused up front.
 *
 * "Written" is not "working": sudoers is last-match-wins, so another entry for the login can still demand a
 * password. While still root the script therefore runs `sudo -n true` AS the login to see what really applies.
 * If the plain rule does not take, it adds `Defaults:<login> !authenticate`, which holds whatever order the
 * rules are read in. If that fails too, the file is removed again and sudo's own account of what applies to the
 * login (`sudo -l -U`) is returned, so the operator can see which rule is in the way.
 */
export function sudoersSetupScript(user: string, dir = "/etc/sudoers.d", mainFile = "/etc/sudoers"): string {
  if (!validSudoUser(user)) throw new Error(`Cannot set up passwordless sudo for the login name "${user}"`);
  const file = sudoersFileFor(user, dir);
  // Arguments: 1 login, 2 file, 3 directory, 4 main sudoers file, 5 file name of the first version.
  // No single quotes in here: it is passed to `sh -c '...'`.
  const inner = [
    // A rule in a directory sudo never reads would look installed and do nothing.
    'grep -qE "^[#@]includedir[[:space:]]+$3" "$4" || { echo "sudo does not read $3 on this host (no includedir line in $4)" >&2; exit 3; }',
    'rm -f "$5"',
    "try_rule() {",
    '  T="$2~"; umask 0227',
    '  { printf "%s ALL=(ALL) NOPASSWD: ALL\n" "$1"; [ -z "$3" ] || printf "%s\n" "$3"; } > "$T"',
    '  if ! visudo -cf "$T" >/dev/null 2>&1; then rm -f "$T"; return 2; fi',
    '  chmod 0440 "$T"; mv "$T" "$2"',
    '  if sudo -u "$1" sudo -n true >/dev/null 2>&1; then return 0; fi',
    '  rm -f "$2"; return 1',
    "}",
    'try_rule "$1" "$2" ""; RC=$?',
    '[ "$RC" -eq 2 ] && { echo "visudo rejected the rule" >&2; exit 2; }',
    '[ "$RC" -eq 0 ] && exit 0',
    'try_rule "$1" "$2" "Defaults:$1 !authenticate" && exit 0',
    'echo "sudo still asks $1 for a password even with a passwordless rule in place, so another entry read after it must be overriding it (usually a %sudo or %admin line below the includedir line in $4: move that line to the end, using visudo, or remove the entry)." >&2',
    'echo "What sudo says applies to $1:" >&2',
    'sudo -l -U "$1" 2>&1 | head -n 25 >&2',
    'echo "Files in $3:" >&2; ls "$3" 2>&1 | head -n 20 >&2',
    'echo "Rules in $4 that mention a group or ALL:" >&2; grep -nE "^[^#]*(includedir|%|ALL=)" "$4" 2>&1 | head -n 15 >&2',
    "exit 4",
  ].join("\n");
  return [
    `U='${user}'`,
    `F='${file}'`,
    "STATE=failed; OUT=''",
    'if [ "$(id -u)" = "0" ]; then STATE=already',
    "elif ! command -v sudo >/dev/null 2>&1; then STATE=no_sudo",
    "elif sudo -n true 2>/dev/null; then STATE=already",
    "else",
    `  OUT=$(sudo -S -p '' sh -c '${inner}' sh "$U" "$F" '${dir}' '${mainFile}' '${legacySudoersFileFor(user, dir)}' 2>&1); RC=$?`,
    '  if [ "$RC" -eq 0 ]; then',
    // Forget the cached credentials first, or the check below would pass on the password just given.
    "    sudo -k 2>/dev/null",
    '    CHECK=$(sudo -n true 2>&1)',
    '    if [ $? -eq 0 ]; then STATE=ok; OUT=""',
    '    else STATE=inactive; OUT="The rule is in $F and passes as root, but when $U runs sudo it still says: $CHECK"; fi',
    '  elif [ "$RC" -eq 4 ]; then STATE=inactive',
    '  elif [ "$RC" -eq 3 ] || [ "$RC" -eq 2 ]; then STATE=failed',
    `  elif printf '%s' "$OUT" | grep -qiE '${DENIED_RE}'; then STATE=denied`,
    `  elif printf '%s' "$OUT" | grep -qiE '${BAD_PASSWORD_RE}'; then STATE=bad_password`,
    "  fi",
    "fi",
    "echo M_SETUP",
    'echo "$STATE"',
    'printf \'%s\\n\' "$OUT"',
  ].join("\n");
}

export function parseSetupResult(lines: readonly string[] | undefined): SetupResult | null {
  if (!lines?.length) return null;
  const state = (lines[0] ?? "").trim() as SetupState;
  if (!SETUP_STATES.includes(state)) return null;
  return { state, message: lines.slice(1).join("\n").trim() };
}

/** Removes every occurrence of a secret from text that is about to be stored or shown. */
export function scrubSecret(text: string, secret: string | null | undefined): string {
  return secret ? text.split(secret).join("********") : text;
}
