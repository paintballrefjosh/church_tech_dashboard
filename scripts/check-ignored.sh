#!/usr/bin/env bash
#
# Fails if a source file exists on disk but .gitignore hides it from git. A file that is ignored is never committed,
# so it works on the machine that wrote it and is missing from every fresh clone (this is how the whole admin
# Backups page once went missing: an unanchored `backups/` rule). Build output, dependencies and logs are expected
# to be ignored and are not reported.
#
#   scripts/check-ignored.sh        (also: make check-repo)
set -uo pipefail
cd "$(dirname "$0")/.."
git rev-parse --git-dir >/dev/null 2>&1 || { echo "check-ignored: not a git checkout, nothing to check"; exit 0; }
hidden=$(git ls-files --others --ignored --exclude-standard --directory -- apps packages services tests infra docs scripts 2>/dev/null \
  | grep -vE '(^|/)(node_modules|dist|\.next|\.turbo|coverage|playwright-report|test-results|\.playwright)(/|$)|\.tsbuildinfo$|\.log$|(^|/)\.nfs')
if [[ -n $hidden ]]; then
  echo "check-ignored: these exist but .gitignore hides them, so a fresh clone will not have them:" >&2
  sed 's/^/  /' <<<"$hidden" >&2
  echo "Anchor or narrow the rule that matches them (git check-ignore -v <path> shows which)." >&2
  exit 1
fi
echo "check-ignored: no source file is hidden by .gitignore"
