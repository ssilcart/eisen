#!/usr/bin/env bash
# Smoke-tests a compiled eisen binary on the machine that can run it:
# --version, add + ls against a throwaway EISEN_DB, and the TUI opened in a
# pseudo-terminal (script) and quit with `q`, which proves the OpenTUI native
# library embedded by `bun build --compile` loads.
#
#   scripts/smoke-binary.sh <path/to/eisen> <expected-version>
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: $0 <path/to/eisen> <expected-version>" >&2
  exit 2
fi

bin="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
expected="$2"
work="$(mktemp -d "${TMPDIR:-/tmp}/eisen-smoke.XXXXXX")"
trap 'rm -rf "$work"' EXIT
export EISEN_DB="$work/eisen.db"
# A config that does not exist: the default (classic) preset, whatever the machine's config says.
export EISEN_CONFIG="$work/config.json"
export TERM="${TERM:-xterm-256color}"
[ "$TERM" = "dumb" ] && export TERM=xterm-256color

fail() {
  echo "smoke: FAIL: $*" >&2
  exit 1
}

got="$("$bin" --version)"
[ "$got" = "$expected" ] || fail "--version printed '$got', expected '$expected'"
echo "smoke: --version -> $got"

"$bin" add "smoke task #ci" --q1 >/dev/null
listed="$("$bin" ls)"
case "$listed" in
  *"smoke task #ci"*) echo "smoke: add + ls ok" ;;
  *) fail "ls did not list the added task: $listed" ;;
esac

# TUI: run under script(1) so it gets a pty, send `q` after it has drawn, and
# read the exit code the inner shell prints (script's own status differs
# between BSD and util-linux).
log="$work/tui.log"
inner="'$bin'; echo eisen-exit=\$?"
run_script() {
  if [ "$(uname -s)" = "Darwin" ]; then
    script -q "$log" sh -c "$inner"
  else
    # util-linux: -c runs "$SHELL -c <inner>"; -e returns the child's status.
    script -q -e -c "$inner" "$log"
  fi
}
(sleep 3; printf q; sleep 3) | run_script >/dev/null 2>&1 &
pid=$!
for _ in $(seq 1 30); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 1
done
if kill -0 "$pid" 2>/dev/null; then
  kill "$pid" 2>/dev/null || true
  fail "the TUI did not quit within 30 s after q"
fi
wait "$pid" || true

show_log() {
  echo "--- end of the TUI session ---" >&2
  tail -c 1500 "$log" | cat -v >&2
  echo >&2
}
grep -a -q "Q1 · ✅ Do" "$log" || { show_log; fail "the TUI did not draw the matrix"; }
grep -a -q "smoke task #ci" "$log" || { show_log; fail "the TUI did not show the added task"; }
grep -a -q "eisen-exit=0" "$log" || fail "the TUI did not exit 0: $(grep -a -o 'eisen-exit=[0-9]*' "$log" || echo 'no exit line')"
echo "smoke: TUI drew the matrix and quit with exit 0"
echo "smoke: OK"
