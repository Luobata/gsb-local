#!/usr/bin/env bash
set -euo pipefail

BIN_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(cd -P "$BIN_DIR/.." && pwd -P)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gsb-symlink-cli.XXXXXX")"
trap 'rm -r -- "$TEST_DIR"' EXIT
ln -s "$BIN_DIR" "$TEST_DIR/bin"
ln -s "$ROOT_DIR/studio" "$TEST_DIR/studio"
FAKE_ZELLIJ="$TEST_DIR/zellij"
printf '%s\n' '#!/usr/bin/env bash' \
  '[[ "$*" != "action list-panes --json --all" ]] || { printf '\''[{"id":7,"title":"hub.demo.main · fake","is_plugin":false,"exited":false}]'\''; exit; }' \
  'while :; do :; done' > "$FAKE_ZELLIJ"
chmod +x "$FAKE_ZELLIJ"

check_entry() {
  local label="$1" base="$2" studio_base="$3" output exit_code
  set +e
  output="$(node "$base/zellij-timed.mjs" 2>&1)"; exit_code=$?
  set -e
  [[ $exit_code -eq 2 && "$output" == *"Usage: zellij-timed.mjs"* ]] || { printf '%s usage failed\n' "$label" >&2; return 1; }
  set +e
  output="$(GSB_ZELLIJ_BIN="$FAKE_ZELLIJ" node "$base/zellij-timed.mjs" 20 action list-panes 2>&1)"; exit_code=$?
  set -e
  [[ $exit_code -eq 124 ]] || { printf '%s timeout failed: %s\n' "$label" "$exit_code" >&2; return 1; }
  output="$(node "$base/layout-status.mjs" --selftest 2>&1)"
  [[ "$output" == *"layout-status selftest: 11 passed"* ]] || { printf '%s layout failed\n' "$label" >&2; return 1; }
  output="$(node "$base/watchdog.mjs" --selftest 2>&1)"
  [[ "$output" == *"all self-tests passed"* ]] || { printf '%s watchdog failed\n' "$label" >&2; return 1; }
  output="$(env GSB_ZELLIJ_BIN="$FAKE_ZELLIJ" GSB_SESSION=demo GSB_ROLES=hub XDG_STATE_HOME="$TEST_DIR/state" GSB_NUDGE_RESOLVE_TIMEOUT_MS=100 bash "$base/nudge" hub --dry-run 2>&1)"
  [[ "$output" == "session=demo role=hub pane_id=7 title=hub.demo.main · fake" ]] || { printf '%s nudge failed: %s\n' "$label" "$output" >&2; return 1; }
  output="$(node "$base/wake-detect.mjs" --selftest 2>&1)"
  [[ "$output" == *"all wake-detect self-tests passed"* ]] || { printf '%s wake-detect failed\n' "$label" >&2; return 1; }
  # A studio entry guard that fails open exits 0 with no output instead of printing usage.
  output="$(node "$studio_base/server.mjs" --help 2>&1)"
  [[ "$output" == *"Usage: gsb-local studio"* ]] || { printf '%s studio failed: %s\n' "$label" "$output" >&2; return 1; }
}

cd "$ROOT_DIR"
check_entry real "$BIN_DIR" "$ROOT_DIR/studio"
check_entry relative bin studio
check_entry symlink "$TEST_DIR/bin" "$TEST_DIR/studio"
printf 'symlink CLI selftest: 21 passed\n'
